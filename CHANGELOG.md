# Changelog

## 0.5.0 - 2026-10-28

- The store speaks one asynchronous database interface (`@iricity/space-node/database`) with two adapters: `wrapSqlJsDatabase` for the node's own SQLite file and `wrapLibsqlClient` for libSQL, a SQLite database shared across processes such as Turso. An operated stack can keep the node tables in a hosted database.
- Breaking for embedders: `createNodeStore({ ensureDb, persistDb })` now expects `ensureDb()` to return that interface, not a raw sql.js database. Wrap it with `wrapSqlJsDatabase(db)`.
- Chain integrity under concurrency. A unique index allows one receipt per predecessor and one observation envelope per predecessor, so two writers that read the same chain head cannot both extend it. The losing writer re-reads the head and signs again. Each object and its receipt are written in one atomic batch. Recording the same observation concurrently still stores it once.
- Databases written by earlier versions gain the new column and indexes on first use; if an existing fork prevents an index, `chainGuards()` reports it instead of refusing to start.

## 0.4.1 - 2026-10-28

- First release through the trusted publisher, with provenance. No code change.

## 0.4.0 - 2026-10-28

- First version on npm as `@iricity/space-node`, with `space-node` and `space-node-keygen` as commands. The repository is public under Apache-2.0.
- Depends on `@iricity/frontier-shared` from the registry.

## 0.3.0 - 2026-10-27

- Discovery: `GET /.well-known/frontier-node.json` serves the node's signed descriptor (`node-descriptor.json/1`); `NODE_PUBLIC_URL` makes its endpoints absolute. `@iricity/space-node/descriptor` exports the pure builder for operated stacks. The two-node demonstration discovers both nodes into the registry and anchors nothing new; registry anchoring lives in the registry.
- Vendored `@iricity/frontier-shared` 0.5.0 (vectors version 3; profile ids for descriptors and chain heads).

## 0.2.0 - 2026-10-27

- Two-node demonstration (`npm run demo:two-nodes`, `docs/TWO_NODES.md`): two nodes with their own keys verify each other's objects offline and, with `--registry`, through the reference registry; covered by a test.
- Library exports: `./orbital`, `./connectors/celestrak`, `./connectors/satnogs`, `./store`, `./identity`, `./agent`, `./node`; `createNodeStore({ ensureDb, persistDb })` binds the node tables to any sql.js database so an operated stack can embed the node without copying it.
- Vendored `@iricity/frontier-shared` 0.4.0.

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
