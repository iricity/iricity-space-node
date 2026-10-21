# Changelog

## 0.1.0 - 2026-10-21

First release of the reference node as its own repository, carved out of the operated space stack.

- A single node described by `node.json` or `NODE_*` variables: id, operator, jurisdiction, site.
- `did:key` identity from `NODE_SIGNING_PRIVATE_KEY`; ephemeral and labelled without it; required in production. `npm run keygen`.
- Self-declared authorizations (`receive`, `publish_data`; no transmit claimed) and an identity record.
- Signed pass predictions over the declared site (public, never stored) and for any observer (operator key, stored and receipted); propagated state.
- Signed, chained, idempotent observations, local or ingested from the SatNOGS Network.
- An append-only `state-receipt/1` chain with public list and verify routes.
- `POST /envelopes/verify` for any envelope from any node.
- Operator key for write routes (`503` when unset), per-client rate limit on public compute routes, `400`/`422` error contract, UTC parsing.
- CelesTrak connector with cache, negative cache, in-flight sharing and object check; SatNOGS connector with a local object filter.
- SQLite through sql.js under `NODE_DATA_DIR`; Dockerfile; OpenAPI 3.1 at `/openapi.yaml`; tests run offline on bundled elements and observations.
- Primitives from `@iricity/frontier-shared` 0.3.0 (vendored until published).
