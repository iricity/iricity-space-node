/**
 * Node identity: the node's own ed25519 key, expressed as a did:key, used to sign
 * every object this node produces (pass predictions, observations, receipts).
 *
 * Key material comes from NODE_SIGNING_PRIVATE_KEY (PKCS#8 PEM or 32-byte seed hex).
 * Without it the node generates an ephemeral key at start and says so on every
 * surface, so nothing ever pretends to be durable identity when it is not. In
 * production the key is required and the process refuses to start without it.
 */

import {
  createEnvelope,
  createIdentityRecord,
  createReceiptRecord,
  fingerprintDid,
  generateEd25519KeyPair,
  keyPairFromPrivateKeyPem,
  keyPairFromSeed,
  verifyEnvelope
} from "@iricity/frontier-shared";
import { IS_PRODUCTION, NODE_SIGNING_KEY_LABEL, NODE_SIGNING_PRIVATE_KEY } from "./config.js";
import { getNodeDescription } from "./node.js";

let cached = null;

function loadKeyPair() {
  const raw = String(NODE_SIGNING_PRIVATE_KEY || "").trim();
  if (!raw) {
    if (IS_PRODUCTION) throw new Error("NODE_SIGNING_PRIVATE_KEY is required when NODE_ENV=production: a published node needs a durable identity");
    return { pair: generateEd25519KeyPair(), mode: "ephemeral_dev" };
  }
  if (raw.includes("PRIVATE KEY")) return { pair: keyPairFromPrivateKeyPem(raw), mode: "configured" };
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return { pair: keyPairFromSeed(raw), mode: "configured" };
  throw new Error("NODE_SIGNING_PRIVATE_KEY must be an ed25519 PKCS#8 PEM or a 64-hex-character seed");
}

function state() {
  if (!cached) {
    const { pair, mode } = loadKeyPair();
    cached = { pair, mode, created_at: new Date().toISOString() };
  }
  return cached;
}

export function getNodeIdentity() {
  const { pair, mode, created_at } = state();
  const node = getNodeDescription();
  return {
    node_id: node.node_id,
    did: pair.did,
    key_id: pair.did,
    key_label: NODE_SIGNING_KEY_LABEL,
    algorithm: "ed25519",
    public_key_multibase: pair.public_key_multibase,
    public_key_fingerprint: fingerprintDid(pair.did),
    signer_mode: mode,
    durable: mode === "configured",
    since: created_at,
    warning: mode === "configured"
      ? null
      : "Ephemeral development key: identity changes on restart. Set NODE_SIGNING_PRIVATE_KEY for a durable node identity."
  };
}

export function getNodeSigner() {
  return state().pair;
}

export function signNodePayload(payload, payload_type, options = {}) {
  return createEnvelope({
    payload,
    payload_type,
    signer: getNodeSigner(),
    created_at: options.created_at,
    previous_envelope_hash: options.previous_envelope_hash ?? null,
    detached: Boolean(options.detached)
  });
}

export function verifyNodeEnvelope(envelope, options = {}) {
  return verifyEnvelope(envelope, options);
}

export function issueNodeReceipt({ record, previous_hash = null, timestamp } = {}) {
  return createReceiptRecord({ record, previous_hash, issuer: getNodeSigner(), timestamp });
}

/** The node's identity record: an `entity` with identity_type node and this process's did. */
export function buildNodeIdentityRecord() {
  const node = getNodeDescription();
  const identity = getNodeIdentity();
  return createIdentityRecord({
    entity_id: node.node_id,
    identity_type: "node",
    did: identity.did,
    controller_id: node.operator,
    display_name: node.name,
    status: "active",
    created_at: node.created_at,
    metadata: {
      jurisdiction: node.jurisdiction,
      declared_site: node.site ? `${node.site.latitude},${node.site.longitude}` : null
    }
  });
}

export function resetNodeIdentityForTests() {
  cached = null;
}
