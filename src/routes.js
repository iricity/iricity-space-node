import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyEnvelope, verifyReceiptRecord } from "@iricity/frontier-shared";
import { OPERATOR_PASS_WINDOW_MAX_HOURS, PUBLIC_PASS_WINDOW_MAX_HOURS } from "./config.js";
import { enforcePublicRateLimit, requireOperatorKey } from "./auth.js";
import {
  describeNode,
  ingestSatnogsObservations,
  listNodeReceiptSummaries,
  nodeDescriptorEnvelope,
  predictNodePasses,
  recordObservation,
  verifyNodeReceipt,
  verifyNodeReceiptChain
} from "./agent.js";
import { getNodeIdentity } from "./identity.js";
import { getNodeDescription } from "./node.js";
import { assertObserver, parseInstant, propagateState } from "./orbital/propagation.js";
import { describeElementsCache, resolveOmm } from "./connectors/celestrak.js";
import { countNodeReceipts, getObservationById, getPassPredictionById, listObservations, listPassPredictions } from "./store/nodeStore.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
const OPENAPI_PATH = path.join(here, "..", "docs", "openapi.yaml");

export const VERSION = pkg.version;

/**
 * Errors that carry a status are client-facing by construction; TypeErrors come
 * from input validation; anything else is a fault, logged and not echoed.
 */
function sendError(req, reply, error) {
  const status = error?.status ?? (error instanceof TypeError ? 400 : 500);
  if (status >= 500) {
    req.log.error({ err: error }, "route failure");
    return reply.code(status).send({ error: "unexpected error", request_id: req.id });
  }
  return reply.code(status).send({ error: error?.message ?? "request failed", ...(error?.code ? { code: error.code } : {}) });
}

function optionalNumber(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a number`);
  return parsed;
}

function flag(value) {
  return String(value ?? "false").toLowerCase() === "true";
}

function observerFromQuery(q) {
  if (q.latitude === undefined && q.longitude === undefined && q.altitude_m === undefined) return undefined;
  if (q.latitude === undefined || q.longitude === undefined) throw new TypeError("latitude and longitude must both be given");
  return assertObserver({
    latitude: optionalNumber(q.latitude, "latitude"),
    longitude: optionalNumber(q.longitude, "longitude"),
    altitude_m: optionalNumber(q.altitude_m, "altitude_m") ?? 0
  });
}

function requireObjectBody(body, label = "body") {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError(`${label} must be a JSON object`);
  return body;
}

export const ENDPOINTS = {
  health: "GET /health",
  identity: "GET /identity",
  authorizations: "GET /authorizations",
  passes: "GET /passes?norad_id=25544&hours=24",
  receipts: "GET /receipts",
  receipts_verify: "GET /receipts/verify",
  receipt: "GET /receipts/:receipt_id",
  observations: "GET /observations",
  observation: "GET /observations/:observation_id",
  observation_verify: "GET /observations/:observation_id/verify",
  record_observation: "POST /observations (operator key)",
  ingest_satnogs: "POST /observations/ingest (operator key)",
  orbital_passes: "GET /orbital/passes?latitude=..&longitude=.. (operator key; stored and receipted)",
  orbital_passes_history: "GET /orbital/passes/history",
  orbital_pass: "GET /orbital/passes/:prediction_id",
  orbital_state: "GET /orbital/state?norad_id=25544&at=.. (operator key)",
  envelopes_verify: "POST /envelopes/verify",
  descriptor: "GET /.well-known/frontier-node.json",
  openapi: "GET /openapi.yaml"
};

export default async function routes(app) {
  app.get("/", async () => {
    const identity = getNodeIdentity();
    return {
      name: pkg.name,
      version: VERSION,
      protocol: { envelope: "state-envelope/1", receipt: "state-receipt/1" },
      node_id: identity.node_id,
      did: identity.did,
      signer_mode: identity.signer_mode,
      endpoints: ENDPOINTS
    };
  });

  app.get("/health", async () => {
    const identity = getNodeIdentity();
    const node = getNodeDescription();
    return {
      name: pkg.name,
      version: VERSION,
      status: "ok",
      timestamp: new Date().toISOString(),
      node_id: identity.node_id,
      did: identity.did,
      signer_mode: identity.signer_mode,
      durable_identity: identity.durable,
      declared_site: Boolean(node.site),
      receipt_count: await countNodeReceipts(node.node_id),
      elements_cache: describeElementsCache()
    };
  });

  app.get("/openapi.yaml", async (_req, reply) => {
    reply.type("application/yaml; charset=utf-8");
    return fs.readFileSync(OPENAPI_PATH, "utf8");
  });

  // Identity and authorizations: public, this is what discovery reads.
  app.get("/identity", async () => ({ version: "v1", ...describeNode() }));

  // The signed descriptor: one document a registry fetches to learn this node.
  app.get("/.well-known/frontier-node.json", async () => nodeDescriptorEnvelope());

  app.get("/authorizations", async () => {
    const node = describeNode();
    return {
      version: "v1",
      node_id: node.node_id,
      profile_note: "All authorizations are self-declared by the operator until a regulator-issued credential is attached.",
      authorizations: node.authorizations
    };
  });

  // Passes over the declared site: public, rate limited, never stored.
  app.get("/passes", { preHandler: enforcePublicRateLimit }, async (req, reply) => {
    try {
      const q = req.query || {};
      return await predictNodePasses({
        norad_id: q.norad_id,
        hours: q.hours,
        max_hours: PUBLIC_PASS_WINDOW_MAX_HOURS,
        min_elevation_deg: optionalNumber(q.min_elevation_deg, "min_elevation_deg") ?? 10,
        start: q.start,
        fixture: flag(q.fixture),
        persist: false
      });
    } catch (error) {
      return sendError(req, reply, error);
    }
  });

  // The receipt chain: public, verifiable against the stored records.
  app.get("/receipts", async (req) => {
    const identity = getNodeIdentity();
    const receipts = await listNodeReceiptSummaries({ subject_kind: req.query?.subject_kind, limit: req.query?.limit });
    return { node_id: identity.node_id, issuer: identity.did, receipt_kind: "state-receipt/1", count: receipts.length, receipts };
  });

  app.get("/receipts/verify", { preHandler: enforcePublicRateLimit }, async () => verifyNodeReceiptChain());

  app.get("/receipts/:receipt_id", async (req, reply) => {
    const verification = await verifyNodeReceipt(req.params.receipt_id);
    if (!verification) return reply.code(404).send({ error: "Receipt not found", receipt_id: req.params.receipt_id });
    return verification;
  });

  // Operator routes: any observer, longer windows, stored and receipted.
  app.get("/orbital/passes", { preHandler: requireOperatorKey }, async (req, reply) => {
    try {
      const q = req.query || {};
      return await predictNodePasses({
        norad_id: q.norad_id,
        hours: q.hours,
        max_hours: OPERATOR_PASS_WINDOW_MAX_HOURS,
        min_elevation_deg: optionalNumber(q.min_elevation_deg, "min_elevation_deg") ?? 10,
        start: q.start,
        observer: observerFromQuery(q),
        fixture: flag(q.fixture),
        persist: true
      });
    } catch (error) {
      return sendError(req, reply, error);
    }
  });

  app.get("/orbital/passes/history", async (req) => {
    const predictions = await listPassPredictions({ norad_cat_id: req.query?.norad_id, limit: req.query?.limit });
    return {
      predictions: predictions.map(({ prediction, envelope, receipt, ...rest }) => ({
        ...rest,
        passes: prediction.passes?.length ?? 0,
        envelope_id: envelope?.envelope_id ?? null,
        receipt_id: receipt?.receipt_id ?? null
      }))
    };
  });

  app.get("/orbital/passes/:prediction_id", async (req, reply) => {
    const entry = await getPassPredictionById(req.params.prediction_id);
    if (!entry) return reply.code(404).send({ error: "Prediction not found", prediction_id: req.params.prediction_id });
    return {
      ...entry,
      verification: verifyEnvelope(entry.envelope),
      receipt_verification: entry.receipt ? verifyReceiptRecord(entry.receipt, { record: entry.prediction }) : null
    };
  });

  app.get("/orbital/state", { preHandler: requireOperatorKey }, async (req, reply) => {
    try {
      const q = req.query || {};
      const at = q.at === undefined || q.at === "" ? new Date() : parseInstant(q.at, "at");
      const observer = observerFromQuery(q) ?? null;
      const elements = await resolveOmm(q.norad_id, { fixture: flag(q.fixture) });
      const state = propagateState(elements.omm, at, observer);
      return { state, elements_origin: elements.origin, elements_fetched_at: elements.fetched_at };
    } catch (error) {
      return sendError(req, reply, error);
    }
  });

  // Observations: record and ingest with the operator key; list and verify in public.
  app.post("/observations", { preHandler: requireOperatorKey }, async (req, reply) => {
    try {
      const body = requireObjectBody(req.body);
      if (body.node_id !== undefined && body.node_id !== getNodeDescription().node_id) {
        throw Object.assign(new Error("this node records observations only as itself"), { status: 400, code: "not_this_node" });
      }
      const entry = await recordObservation({ observation: body.observation, source: body.source || "local", payload_profile: body.payload_profile });
      return reply.code(entry.already_recorded ? 200 : 201).send(entry);
    } catch (error) {
      return sendError(req, reply, error);
    }
  });

  app.post("/observations/ingest", { preHandler: requireOperatorKey }, async (req, reply) => {
    try {
      const body = req.body === undefined || req.body === null ? {} : requireObjectBody(req.body);
      const result = await ingestSatnogsObservations({ options: body.options ?? {} });
      return reply.code(201).send(result);
    } catch (error) {
      return sendError(req, reply, error);
    }
  });

  app.get("/observations", async (req) => {
    const observations = await listObservations({ source: req.query?.source, norad_cat_id: req.query?.norad_id, limit: req.query?.limit });
    return {
      observations: observations.map(({ record, envelope, receipt, ...summary }) => ({
        ...summary,
        envelope_id: envelope?.envelope_id ?? null,
        receipt_id: receipt?.receipt_id ?? null
      }))
    };
  });

  app.get("/observations/:observation_id", async (req, reply) => {
    const entry = await getObservationById(req.params.observation_id);
    if (!entry) return reply.code(404).send({ error: "Observation not found", observation_id: req.params.observation_id });
    return entry;
  });

  app.get("/observations/:observation_id/verify", { preHandler: enforcePublicRateLimit }, async (req, reply) => {
    const entry = await getObservationById(req.params.observation_id);
    if (!entry) return reply.code(404).send({ error: "Observation not found", observation_id: req.params.observation_id });
    const envelope = verifyEnvelope(entry.envelope, { expected_signer: req.query?.expected_signer });
    const receipt = entry.receipt ? verifyReceiptRecord(entry.receipt, { record: entry.record }) : null;
    return { observation_id: entry.observation_id, verified: envelope.verified && (receipt ? receipt.verified : true), signer: entry.signer, envelope, receipt };
  });

  // Anyone can verify any envelope produced by any node: self-contained by design.
  app.post("/envelopes/verify", { preHandler: enforcePublicRateLimit }, async (req, reply) => {
    try {
      const body = requireObjectBody(req.body);
      const envelope = body.envelope ?? body;
      if (body.allowed_payload_types !== undefined && !Array.isArray(body.allowed_payload_types)) {
        throw new TypeError("allowed_payload_types must be an array of payload type strings");
      }
      return verifyEnvelope(envelope, { payload: body.payload, expected_signer: body.expected_signer, allowed_payload_types: body.allowed_payload_types });
    } catch (error) {
      return sendError(req, reply, error);
    }
  });
}
