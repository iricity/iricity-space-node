# Node Agent

A node is the smallest unit of the protocol: one operator-controlled process with a key, a declared site, a statement of what it may do, and a stream of signed objects. This repository is the reference node.

## Identity

- The node holds one ed25519 key, expressed as a `did:key` (`did:key:z6Mk…`). Set `NODE_SIGNING_PRIVATE_KEY` (PKCS#8 PEM or a 64-hex seed) for a durable identity. Without it the node generates an ephemeral key at start and reports `signer_mode: "ephemeral_dev"` on every identity surface, with a warning. With `NODE_ENV=production` the process refuses to start without a key.
- The key and the node description are resolved when the process starts, so a malformed key or manifest fails at boot, never on a request.
- `GET /identity` returns the live identity, the node's `entity` identity record (`identity_type: node`, the node's DID, the operator as `controller_id`), its authorizations and its site.
- `npm run keygen` prints a fresh DID and PEM.

## Self-description

The node describes itself from `node.json` (path in `NODE_MANIFEST_PATH`) or from `NODE_ID`, `NODE_NAME`, `NODE_OPERATOR`, `NODE_JURISDICTION` and `NODE_SITE_*`, which override the file. `node_id` is validated (2 to 64 characters of letters, digits, `_`, `-`), `jurisdiction` must be ISO 3166-1 alpha-2, and the site must be within range. A node may have no site; it then publishes identity and authorizations but answers `422` (`no_declared_site`) for passes over its own site.

## Trust boundary

The node signs only as itself. It computes passes over its declared site (`observer_id` is its own id, `observer_source: "node_declared_site"`) or over an observer given in the request (`observer_id: null`, `observer_source: "request"`), and in both cases `computed_by` names this node and the envelope is signed by it. It records observations only as itself: a `node_id` in the body that is not its own is refused with `400` (`not_this_node`).

## Authorizations

`GET /authorizations` returns machine-readable, self-declared authorization records:

| Capability | Scope | Claim |
| --- | --- | --- |
| `receive` | `receive_only_no_transmit` | receive-only operation, which needs no spectrum licence in the declared jurisdiction |
| `publish_data` | `signed_observations_and_pass_predictions` | publishes only what this node produced or verified |

No `transmit` authorization is claimed. When an amateur or commercial licence exists it is added as a `transmit` authorization with bands, power ceiling, licence reference and `profile: regulator_issued`; nothing in the node will schedule a transmit action without one.

## Observations

| Route | Access | Purpose |
| --- | --- | --- |
| `POST /observations` | operator key | record one observation: `{observation, source?, payload_profile?}` |
| `POST /observations/ingest` | operator key | pull observations from SatNOGS (`options.norad_id`, `limit`, `ground_station`, `status`, `timeout_ms`, `fixture`) and record each |
| `GET /observations` | public | summaries, filter by `source`, `norad_id` |
| `GET /observations/:id` | public | the record, envelope and receipt |
| `GET /observations/:id/verify` | public, rate limited | verification of envelope and receipt |

Each observation becomes a canonical `measurement` record. A SatNOGS observation is carried unchanged under `satnogs.observation.json/1`; anything else under `opaque.json/1`. The record is wrapped in a `state-envelope/1` envelope signed by the node, chained to the node's previous observation envelope, and receipted in the node's receipt chain. The stored record, envelope and receipt are exactly what the public endpoints return.

Rules that keep the chains honest:

- The observation id is derived from the node id and the observation's canonical hash. Recording the same observation again returns the stored entry with `already_recorded: true` (status `200`). Nothing is rewritten, so envelopes chained to the original stay valid.
- `timestamp` comes from the observation (`start`, `observed_at` or `timestamp`, zone-less values read as UTC). When none parses, the record is stamped with the recording time and says so in `timestamp_source: "recorded_at"`.
- Payloads the protocol cannot canonicalise (nesting deeper than 256 levels, non-finite numbers) and payloads above 256 KiB are refused with `400` or `413`.
- A SatNOGS `demoddata` list longer than 25 entries is truncated before signing, and the signed object says so (`demoddata_truncated`, `demoddata_total`).

## SatNOGS

The SatNOGS Network stays the scheduler. This node reads `GET /api/observations/` with `norad_cat_id` and signs what it ingests. It does not schedule, vet or alter observations. The requested object filter is applied again locally: if upstream ignores it, the answer is the matching subset (possibly empty), never an unrelated list, and `filter_applied_upstream` reports what happened. A bundled fixture makes the connector usable offline and in tests; responses always state `observations_origin`.

Ingest answers with `ingested_count` (processed), `recorded_count` (new) and `duplicate_count` (already in the store).

## Receipts

Node-issued receipts are `state-receipt/1` records, signed with ed25519 by the node DID, in the node's own append-only chain.

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /receipts` | public | the chain in append order; filter by `subject_kind` (`pass_prediction`, `observation`) |
| `GET /receipts/verify` | public, rate limited | verify the whole chain: links, signatures, and each receipt against its stored record |
| `GET /receipts/:receipt_id` | public | one receipt verified against its record and its predecessor, with the full receipt |

A receipt enters the chain only when the object it covers is kept: every observation, and pass predictions from the operator orbit route. Public pass predictions are signed but not stored, and carry `receipt: null`.

The chain re-verifies offline with `verifyReceiptChain` from the primitive package, using the receipts returned by the single-receipt endpoint and the node DID as `expected_issuer`.

## Access control and limits

Write routes require the `x-operator-key` header matching `NODE_OPERATOR_KEY`; without the variable they answer `503` (`operator_key_unset`). Keyless requests to the routes that do real work (`/passes`, `/receipts/verify`, `/observations/:id/verify`, `/envelopes/verify`) are limited per client address: `PUBLIC_RATE_LIMIT_MAX_REQUESTS` per `PUBLIC_RATE_LIMIT_WINDOW_MS` (default 30 per minute), with `x-ratelimit-*` and `retry-after` headers.

## What a second node needs

A second operator needs this repository, their own `NODE_SIGNING_PRIVATE_KEY`, their own `node.json`, and nothing from this operator. Their envelopes verify against their DID; their authorizations say what they may do. Discovery across nodes is a later layer.
