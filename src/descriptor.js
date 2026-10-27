/**
 * The node descriptor: a signed self-description served at
 * /.well-known/frontier-node.json. Discovery is reading this document; a registry
 * that fetches it verifies the envelope against the DID it names and lists the node.
 *
 * `buildNodeDescriptor` is pure so an operated stack with its own node description
 * can build the same document; `signNodeDescriptor` wraps it with a signer.
 */

import { PAYLOAD_PROFILES, createEnvelope } from "@iricity/frontier-shared";

export const DESCRIPTOR_VERSION = "node-descriptor.json/1";
export const DESCRIPTOR_PATH = "/.well-known/frontier-node.json";

/** Surfaces a node offers, as paths relative to its public URL. */
export const DEFAULT_ENDPOINT_PATHS = {
  identity: "/identity",
  authorizations: "/authorizations",
  passes: "/passes",
  receipts: "/receipts",
  observations: "/observations",
  envelopes_verify: "/envelopes/verify"
};

function joinUrl(base, path) {
  if (!base) return path;
  return `${String(base).replace(/\/+$/, "")}${path}`;
}

/**
 * @param {object} args
 * @param {{node_id:string, name?:string, operator:string, jurisdiction?:string|null, site?:object|null}} args.node
 * @param {string} args.did
 * @param {string|null} [args.publicUrl]      absolute base URL when known; endpoints are relative otherwise
 * @param {object} [args.endpointPaths]       per-surface paths (defaults to DEFAULT_ENDPOINT_PATHS)
 * @param {object[]} [args.authorizations]
 * @param {string[]} [args.profiles]          payload profiles this node produces
 * @param {string} [args.generatedAt]
 */
export function buildNodeDescriptor({ node, did, publicUrl = null, endpointPaths = DEFAULT_ENDPOINT_PATHS, authorizations = [], profiles = [], generatedAt }) {
  if (!node?.node_id || !node?.operator) throw new TypeError("node with node_id and operator is required");
  if (typeof did !== "string" || !did.startsWith("did:key:z6Mk")) throw new TypeError("did must be an ed25519 did:key");
  const endpoints = {};
  for (const [name, path] of Object.entries(endpointPaths)) endpoints[name] = joinUrl(publicUrl, path);
  return {
    descriptor_version: DESCRIPTOR_VERSION,
    node_id: node.node_id,
    did,
    name: node.name ?? null,
    operator: node.operator,
    jurisdiction: node.jurisdiction ?? null,
    site: node.site ?? null,
    public_url: publicUrl ? String(publicUrl).replace(/\/+$/, "") : null,
    endpoints,
    protocol: { envelope: "state-envelope/1", receipt: "state-receipt/1", profiles },
    authorizations,
    generated_at: generatedAt ?? new Date().toISOString()
  };
}

export function signNodeDescriptor(descriptor, signer) {
  return createEnvelope({ payload: descriptor, payload_type: PAYLOAD_PROFILES.NODE_DESCRIPTOR, signer, created_at: descriptor.generated_at });
}
