# space-node

The reference node of the Frontier State Protocol. One operator-controlled process with:

- an ed25519 identity expressed as a `did:key`, so anyone can verify what it signs without asking anyone;
- a declared site and self-declared, machine-readable authorizations (receive-only; no transmit is claimed);
- signed pass predictions (CelesTrak elements, SGP4) and signed observations (local or SatNOGS), as `state-envelope/1` envelopes;
- an append-only `state-receipt/1` receipt chain over everything it keeps, verifiable offline.

It is small on purpose: Node 20+, four dependencies, one SQLite file. Run it on a mini PC next to a receiver, on a laptop, or in a container. It needs nothing from any other operator.

Specification and reference registry: `iricity-state-stack`. Primitives and conformance vectors: `@iricity/frontier-shared`. License: Apache-2.0.

## Run it in five minutes

```bash
git clone <this repository> && cd space-node
npm ci
cp node.example.json node.json      # edit: node_id, operator, site coordinates, jurisdiction
npm run keygen                      # prints a did:key and a private key PEM
export NODE_SIGNING_PRIVATE_KEY="$(cat path/to/key.pem)"   # keep the PEM out of the repository
export NODE_OPERATOR_KEY="$(openssl rand -hex 24)"         # protects the write routes
npm start                           # http://localhost:3100
```

Then:

```bash
curl -s localhost:3100/identity | jq .identity.did
curl -s "localhost:3100/passes?norad_id=25544&hours=12" | jq '.prediction.passes[0]'
curl -s -X POST localhost:3100/observations -H "x-operator-key: $NODE_OPERATOR_KEY" \
  -H "content-type: application/json" -d '{"observation":{"measurement_type":"noise_floor","value_dbm":-104}}' | jq .receipt
curl -s localhost:3100/receipts/verify | jq .verified
```

The full walkthrough, including what each setting means and how to check a node from outside, is in [docs/RUN_YOUR_OWN_NODE.md](docs/RUN_YOUR_OWN_NODE.md).

## Surfaces

| Route | Access | What it does |
| --- | --- | --- |
| `GET /identity`, `GET /authorizations` | public | who this node is, under whose authority, where, what it may do |
| `GET /passes?norad_id=` | public, rate limited | passes over the declared site in the next hours (max 48); signed, never stored |
| `GET /receipts`, `/receipts/verify`, `/receipts/:id` | public | the chain, its verification against stored records, one receipt |
| `GET /observations`, `/observations/:id`, `/observations/:id/verify` | public | what the node recorded and whether it verifies |
| `POST /observations`, `POST /observations/ingest` | operator key | record one observation; pull observations from SatNOGS |
| `GET /orbital/passes?latitude=&longitude=` | operator key | passes for any observer, up to 168 hours; stored and receipted |
| `GET /orbital/passes/history`, `/orbital/passes/:id` | public | stored predictions and their verification |
| `GET /orbital/state?norad_id=&at=` | operator key | propagated position and look angles |
| `POST /envelopes/verify` | public, rate limited | verify any envelope from any node |
| `GET /health`, `GET /openapi.yaml`, `GET /` | public | liveness, the API document, the endpoint index |

Input errors are `400`; elements that cannot be propagated (decayed objects) are `422`; an object with no bundled elements when `fixture=true` is `404`; upstream failure with no fallback is `502`. Faults are logged and answered with a generic `500`.

## Trust model

- **Identity.** The signer is the DID. `GET /identity` is where a consumer learns it; after that, nothing from this node needs this node to be reachable to verify.
- **Honest strength.** Without `NODE_SIGNING_PRIVATE_KEY` the node runs on an ephemeral key and says `signer_mode: "ephemeral_dev"` on every surface. With `NODE_ENV=production` it refuses to start without a key.
- **Only itself.** The node signs only objects it produced. Observations are recorded as this node; passes computed for another observer say `observer_source: "request"` and `observer_id: null`.
- **Append-only.** Every kept object gets a receipt chained to the previous one. Recording the same observation twice returns the stored entry; nothing is rewritten.
- **No transmit.** The authorizations claim `receive` and `publish_data` only. Nothing here schedules a transmission.

## Verify a node from outside

```js
import { verifyEnvelope, verifyReceiptChain } from "@iricity/frontier-shared";

const identity = await (await fetch("http://node:3100/identity")).json();
const passes = await (await fetch("http://node:3100/passes?norad_id=25544")).json();
verifyEnvelope(passes.envelope, { expected_signer: identity.identity.did });   // { verified: true, ... }

const list = await (await fetch("http://node:3100/receipts")).json();
const receipts = await Promise.all(list.receipts.map(async (r) => (await (await fetch(`http://node:3100/receipts/${r.receipt_id}`)).json()).receipt));
verifyReceiptChain(receipts, { expected_issuer: identity.identity.did });     // { verified: true, length: n, ... }
```

## Configuration

See [.env.example](.env.example). The node is described by `node.json` (or the `NODE_*` variables), signed with `NODE_SIGNING_PRIVATE_KEY`, written to through `NODE_OPERATOR_KEY`, and stores its SQLite file under `NODE_DATA_DIR`.

## Develop

```bash
npm test                 # node:test, offline (bundled elements and observations)
npm run lint:openapi     # docs/openapi.yaml
docker build -t space-node . && docker run -p 3100:3100 -v node-data:/data -e NODE_SIGNING_PRIVATE_KEY=... -e NODE_OPERATOR_KEY=... space-node
```

## Two nodes

`npm run demo:two-nodes` starts two nodes with their own keys and sites, has each verify the other's objects offline, and with `-- --registry <url>` hands both to a reference registry that receipts them into one chain. See [docs/TWO_NODES.md](docs/TWO_NODES.md).

## Use as a library

The package exports its modules for an operated stack that embeds a node: `@iricity/space-node/orbital` (SGP4 pass search), `@iricity/space-node/connectors/celestrak` and `/connectors/satnogs`, `@iricity/space-node/store` (`createNodeStore({ ensureDb, persistDb })` binds the node tables to any sql.js database), `/identity`, `/agent`, `/node`.

Documentation: [docs/RUN_YOUR_OWN_NODE.md](docs/RUN_YOUR_OWN_NODE.md), [docs/TWO_NODES.md](docs/TWO_NODES.md), [docs/NODE_AGENT.md](docs/NODE_AGENT.md), [docs/ORBIT_SERVICE.md](docs/ORBIT_SERVICE.md), [docs/openapi.yaml](docs/openapi.yaml).
