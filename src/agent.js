/**
 * The node agent: produces the protocol objects this node is responsible for.
 *
 *  - signed pass predictions (CelesTrak OMM -> SGP4 -> pass-prediction.json/1)
 *  - signed observations (local or SatNOGS -> satnogs.observation.json/1)
 *  - the node's identity and self-declared authorization records
 *
 * Every object is an envelope signed by the node's did:key. Objects that are kept
 * also get a receipt in the node's own append-only chain, so a third party can
 * verify them offline. This process signs only as itself.
 */

import { createHash } from "node:crypto";
import { PAYLOAD_PROFILES, createAuthorizationRecord, hashPayload, verifyReceiptChain, verifyReceiptRecord } from "@iricity/frontier-shared";
import { assertObserver, assertWindowHours, parseInstant, predictPasses } from "./orbital/propagation.js";
import { clampTimeoutMs, resolveOmm } from "./connectors/celestrak.js";
import { fetchSatnogsObservations } from "./connectors/satnogs.js";
import { buildNodeIdentityRecord, getNodeIdentity, getNodeSigner, issueNodeReceipt, signNodePayload } from "./identity.js";
import { getNodeDescription } from "./node.js";
import { NODE_PUBLIC_URL } from "./config.js";
import { buildNodeDescriptor, signNodeDescriptor } from "./descriptor.js";
import {
  extendChain,
  getLatestNodeReceiptHash,
  getLatestObservationEnvelopeHash,
  getNodeReceiptByHash,
  getNodeReceiptById,
  getNodeReceiptSubjectRecord,
  getObservationById,
  listNodeReceipts,
  saveObservationWithReceipt,
  savePassPredictionWithReceipt
} from "./store/nodeStore.js";

const SATNOGS_REQUIRED = ["id", "start", "ground_station", "norad_cat_id"];
const MAX_OBSERVATION_BYTES = 256 * 1024;
function clientError(message, status = 400, code = undefined) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

/** Self-declared authorizations: receive-only and publish_data, within the declared jurisdiction. No transmit is claimed. */
export function buildNodeAuthorizations() {
  const node = getNodeDescription();
  const base = {
    subject_id: node.node_id,
    controller_id: node.operator,
    profile: "self_declared",
    jurisdiction: node.jurisdiction ?? undefined,
    location: node.site ? { ...node.site, radius_km: 25 } : null,
    valid_from: node.created_at
  };
  const authorizations = [
    createAuthorizationRecord({ ...base, capability: "receive", scope: "receive_only_no_transmit", license_reference: null }),
    createAuthorizationRecord({ ...base, capability: "publish_data", scope: "signed_observations_and_pass_predictions" })
  ];
  return authorizations.map((authorization) => ({
    ...authorization,
    note: authorization.capability === "receive"
      ? "Receive-only operation requires no spectrum licence in this jurisdiction. No transmit authorization is claimed."
      : "Publishes only data this node produced or verified, under the protocol's signed envelope."
  }));
}

export function describeNode() {
  const node = getNodeDescription();
  return {
    node_id: node.node_id,
    name: node.name,
    operator: node.operator,
    jurisdiction: node.jurisdiction,
    identity: getNodeIdentity(),
    identity_record: buildNodeIdentityRecord(),
    authorizations: buildNodeAuthorizations(),
    site: node.site,
    description_source: node.source
  };
}

/** The node's signed descriptor, for /.well-known/frontier-node.json. */
export function nodeDescriptorEnvelope({ publicUrl = NODE_PUBLIC_URL || null, generatedAt } = {}) {
  const node = getNodeDescription();
  const identity = getNodeIdentity();
  const descriptor = buildNodeDescriptor({
    node,
    did: identity.did,
    publicUrl,
    authorizations: buildNodeAuthorizations(),
    profiles: [PAYLOAD_PROFILES.PASS_PREDICTION, PAYLOAD_PROFILES.SATNOGS_OBSERVATION, PAYLOAD_PROFILES.OPAQUE_JSON, PAYLOAD_PROFILES.STATE_RECORD],
    generatedAt
  });
  return signNodeDescriptor(descriptor, getNodeSigner());
}

/** Deterministic id over everything that changes the answer: who, where, which elements, which window. */
function predictionId(prediction, nodeId) {
  const observer = `${prediction.observer.latitude}|${prediction.observer.longitude}|${prediction.observer.altitude_m}`;
  return `pred_${createHash("sha256")
    .update(`${nodeId}|${prediction.norad_cat_id}|${prediction.elements_hash}|${observer}|${prediction.window_start}|${prediction.window_end}|${prediction.min_elevation_deg}`)
    .digest("hex")
    .slice(0, 24)}`;
}

/**
 * Predict passes and sign the result.
 * @param {object} args
 * @param {number} [args.norad_id]
 * @param {number} [args.hours]
 * @param {number} [args.max_hours]          ceiling for the window (the route decides)
 * @param {number} [args.min_elevation_deg]
 * @param {string|Date} [args.start]         zone-less strings are UTC
 * @param {{latitude:number, longitude:number, altitude_m?:number}} [args.observer]  override the declared site
 * @param {boolean} [args.fixture]           force bundled elements
 * @param {boolean} [args.persist]           store the signed prediction and issue a receipt (default false)
 */
export async function predictNodePasses({ norad_id, hours, max_hours, min_elevation_deg = 10, start, observer, fixture = false, persist = false }) {
  const node = getNodeDescription();
  const identity = getNodeIdentity();
  const windowHours = assertWindowHours(hours, 24, max_hours);
  const startAt = start === undefined || start === null || start === "" ? new Date() : parseInstant(start, "start");
  const site = observer ? assertObserver(observer) : node.site;
  if (!site) throw clientError("This node has no declared site; set NODE_SITE_LATITUDE and NODE_SITE_LONGITUDE or a site in the manifest", 422, "no_declared_site");
  const observerIsDeclaredSite = !observer;

  const elements = await resolveOmm(norad_id, { fixture });
  const prediction = predictPasses({
    omm: elements.omm,
    observer: site,
    start: startAt,
    hours: windowHours,
    min_elevation_deg,
    observer_id: observerIsDeclaredSite ? node.node_id : null
  });

  const payload = {
    ...prediction,
    observer_source: observerIsDeclaredSite ? "node_declared_site" : "request",
    computed_by: identity.node_id,
    elements_origin: elements.origin,
    elements_fetched_at: elements.fetched_at,
    elements_source_url: elements.source_url,
    ...(elements.note ? { elements_note: elements.note } : {}),
    omm: elements.omm
  };

  const envelope = signNodePayload(payload, PAYLOAD_PROFILES.PASS_PREDICTION);
  const entry = {
    prediction_id: predictionId(prediction, node.node_id),
    node_id: node.node_id,
    computed_by: identity.node_id,
    elements_origin: elements.origin,
    prediction: payload,
    envelope,
    receipt: null,
    persisted: false,
    created_at: new Date().toISOString()
  };

  if (persist) {
    await extendChain(async () => {
      entry.receipt = issueNodeReceipt({ record: payload, previous_hash: await getLatestNodeReceiptHash(node.node_id) });
      await savePassPredictionWithReceipt(entry, { node_id: node.node_id, created_at: entry.created_at });
    });
    entry.persisted = true;
  }
  return entry;
}

function observationIdFor(nodeId, payloadHash) {
  return `obs_${createHash("sha256").update(`${nodeId}|${payloadHash}`).digest("hex").slice(0, 24)}`;
}

function instantOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  try {
    return parseInstant(value, "timestamp").toISOString();
  } catch {
    return null;
  }
}

/**
 * Wrap one observation into a measurement record, sign it, receipt it, store it.
 * Recording the same observation twice returns the stored entry (`already_recorded`).
 */
export async function recordObservation({ observation, source = "local", payload_profile }) {
  const node = getNodeDescription();
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) throw clientError("observation must be an object");
  if (typeof source !== "string" || !/^[a-z0-9_\-]{1,64}$/i.test(source)) throw clientError("source must be a short identifier");
  if (payload_profile !== undefined && payload_profile !== null && !Object.values(PAYLOAD_PROFILES).includes(payload_profile)) {
    throw clientError(`payload_profile must be one of: ${Object.values(PAYLOAD_PROFILES).join(", ")}`);
  }

  const isSatnogs = source === "satnogs" || SATNOGS_REQUIRED.every((key) => key in observation);
  if (source === "satnogs") {
    const missing = SATNOGS_REQUIRED.filter((key) => !(key in observation));
    if (missing.length) throw clientError(`SatNOGS observation missing: ${missing.join(", ")}`);
  }
  const profile = payload_profile ?? (isSatnogs ? PAYLOAD_PROFILES.SATNOGS_OBSERVATION : PAYLOAD_PROFILES.OPAQUE_JSON);

  let payloadHash;
  try {
    const bytes = Buffer.byteLength(JSON.stringify(observation), "utf8");
    if (bytes > MAX_OBSERVATION_BYTES) throw clientError(`observation exceeds ${MAX_OBSERVATION_BYTES} bytes`, 413);
    payloadHash = hashPayload(observation);
  } catch (error) {
    if (error.status) throw error;
    throw clientError(`observation cannot be canonicalised: ${error.message}`);
  }

  const observationId = observationIdFor(node.node_id, payloadHash);
  const existing = await getObservationById(observationId);
  if (existing) return { ...existing, already_recorded: true };

  const observedAt = instantOrNull(observation.start ?? observation.observed_at ?? observation.timestamp);
  const recordedAt = new Date().toISOString();
  const noradId = Number.isInteger(Number(observation.norad_cat_id)) && Number(observation.norad_cat_id) > 0 ? Number(observation.norad_cat_id) : null;

  const record = {
    record_type: "measurement",
    sensor_id: isSatnogs && observation.ground_station != null ? `satnogs_station_${observation.ground_station}` : node.node_id,
    measurement_type: isSatnogs ? "rf_observation" : (typeof observation.measurement_type === "string" ? observation.measurement_type : "observation"),
    value: observation,
    unit: "opaque",
    payload_profile: profile,
    payload_hash: payloadHash,
    observation_id: observation.id ?? null,
    norad_cat_id: noradId,
    ground_station: observation.ground_station ?? null,
    observation_status: observation.status ?? null,
    window_start: instantOrNull(observation.start),
    window_end: instantOrNull(observation.end),
    timestamp: observedAt ?? recordedAt,
    timestamp_source: observedAt ? "observation" : "recorded_at",
    source,
    recorded_by: node.node_id
  };

  const entry = {
    observation_id: observationId,
    node_id: node.node_id,
    source,
    norad_cat_id: noradId,
    observed_at: observedAt,
    payload_profile: profile,
    payload_hash: payloadHash,
    record,
    envelope: null,
    receipt: null,
    created_at: recordedAt
  };

  try {
    await extendChain(async () => {
      entry.envelope = signNodePayload(record, PAYLOAD_PROFILES.STATE_RECORD, { previous_envelope_hash: await getLatestObservationEnvelopeHash(node.node_id) });
      entry.receipt = issueNodeReceipt({ record, previous_hash: await getLatestNodeReceiptHash(node.node_id) });
      await saveObservationWithReceipt(entry, { node_id: node.node_id, created_at: recordedAt });
    });
  } catch (error) {
    // A concurrent request recorded the same observation first.
    const stored = await getObservationById(observationId);
    if (stored) return { ...stored, already_recorded: true };
    throw error;
  }
  return { ...entry, already_recorded: false };
}

/** Pull observations from SatNOGS and record each one. */
export async function ingestSatnogsObservations({ options = {} } = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw clientError("options must be an object");
  const node = getNodeDescription();
  const fetched = await fetchSatnogsObservations({ ...options, timeout_ms: clampTimeoutMs(options.timeout_ms) });
  const observations = fetched.payload?.observations ?? [];
  const recorded = [];
  let duplicates = 0;
  for (const observation of observations) {
    const entry = await recordObservation({ observation, source: "satnogs" });
    if (entry.already_recorded) duplicates += 1;
    recorded.push(entry);
  }
  return {
    node_id: node.node_id,
    source: "satnogs",
    observations_origin: fetched.payload?.observations_origin ?? "unknown",
    filter_applied_upstream: fetched.payload?.filter_applied_upstream ?? null,
    source_url: fetched.payload?.source_url ?? null,
    note: fetched.payload?.note ?? null,
    ingested_count: recorded.length,
    recorded_count: recorded.length - duplicates,
    duplicate_count: duplicates,
    observations: recorded
  };
}

// ---------------------------------------------------------------------------
// Receipt chain: list and verify
// ---------------------------------------------------------------------------

function receiptSummary(entry) {
  return {
    receipt_id: entry.receipt_id,
    node_id: entry.node_id,
    subject_kind: entry.subject_kind,
    subject_id: entry.subject_id,
    record_hash: entry.record_hash,
    previous_hash: entry.previous_hash,
    receipt_hash: entry.receipt_hash,
    issuer: entry.issuer,
    timestamp: entry.timestamp,
    sequence: entry.sequence
  };
}

export async function listNodeReceiptSummaries(filters = {}) {
  const entries = await listNodeReceipts({ node_id: getNodeDescription().node_id, ...filters });
  return entries.map(receiptSummary);
}

/** Verify one receipt against the record it commits to and its predecessor. */
export async function verifyNodeReceipt(receiptId) {
  const entry = await getNodeReceiptById(receiptId);
  if (!entry) return null;
  const record = await getNodeReceiptSubjectRecord(entry);
  const result = verifyReceiptRecord(entry.receipt, record ? { record } : {});
  const errors = [...result.errors];
  const checks = [...result.checks];
  if (!record) errors.push(`subject ${entry.subject_kind} ${entry.subject_id} is missing from the store`);
  else checks.push("subject_record_present");

  let previous = null;
  if (entry.previous_hash) {
    previous = await getNodeReceiptByHash(entry.previous_hash);
    if (!previous) errors.push(`previous receipt ${entry.previous_hash} is missing from the chain`);
    else checks.push("previous_receipt_present");
  } else {
    checks.push("chain_genesis");
  }

  const identity = getNodeIdentity();
  if (entry.receipt.issuer !== identity.did) {
    errors.push(`issuer ${entry.receipt.issuer} is not this node's current identity ${identity.did}`);
  }

  return {
    ...result,
    verified: result.verified && errors.length === 0,
    errors,
    checks,
    receipt_kind: "state-receipt/1",
    node_id: entry.node_id,
    subject_kind: entry.subject_kind,
    subject_id: entry.subject_id,
    previous_receipt_id: previous?.receipt_id ?? null,
    issuer_is_current_identity: entry.receipt.issuer === identity.did,
    receipt: entry.receipt
  };
}

/** Verify the whole chain in append order, each receipt against its stored record. */
export async function verifyNodeReceiptChain({ limit = 1000 } = {}) {
  const node = getNodeDescription();
  const identity = getNodeIdentity();
  const entries = await listNodeReceipts({ node_id: node.node_id, limit });
  const chain = entries.length
    ? verifyReceiptChain(entries.map((entry) => entry.receipt), { expected_issuer: identity.did })
    : { verified: true, errors: [], results: [] };
  const errors = [...chain.errors];
  let recordsVerified = 0;
  for (const entry of entries) {
    const record = await getNodeReceiptSubjectRecord(entry);
    if (!record) {
      errors.push(`${entry.receipt_id}: subject ${entry.subject_kind} ${entry.subject_id} is missing from the store`);
      continue;
    }
    const single = verifyReceiptRecord(entry.receipt, { record });
    if (!single.verified) errors.push(`${entry.receipt_id}: ${single.errors.join(", ")}`);
    else recordsVerified += 1;
  }
  return {
    node_id: node.node_id,
    expected_issuer: identity.did,
    length: entries.length,
    verified: chain.verified && errors.length === 0,
    errors,
    receipts_failed: chain.results.filter((result) => !result.verified).map((result) => result.receipt_id),
    records_verified: recordsVerified,
    head: entries.length ? receiptSummary(entries[entries.length - 1]) : null
  };
}
