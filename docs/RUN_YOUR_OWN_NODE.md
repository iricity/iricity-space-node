# Run your own node

A node is the smallest unit of the protocol: one process, one key, one declared site, one stream of signed objects. This guide takes you from nothing to a node another operator can verify, in the order the questions come up.

## 1. What you need

- Node.js 20 or newer. Nothing native is compiled: SQLite runs through sql.js (WebAssembly).
- A machine that stays on, if you want others to rely on your passes and observations. A laptop is fine to try it.
- Internet access to CelesTrak (orbital elements) and, if you ingest from it, the SatNOGS Network. Both are optional: bundled elements and observations make the node usable offline for testing.
- A receiver is not required. A node with no radio still publishes a verifiable identity, authorizations and pass predictions.

## 2. Describe the node

Copy `node.example.json` to `node.json` and edit it:

| Field | Meaning |
| --- | --- |
| `node_id` | a stable identifier you choose, 2 to 64 characters of letters, digits, `_` or `-`; it appears in every record |
| `name` | human-readable |
| `operator` | the person or organization responsible; becomes `controller_id` in the identity record |
| `jurisdiction` | ISO 3166-1 alpha-2 country code of the site; used in the authorization records |
| `site` | latitude, longitude (decimal degrees), altitude in metres; city-level accuracy is enough for pass timing within a second |
| `created_at` | when the node came into existence, ISO-8601 UTC |

Every field can also be set with `NODE_ID`, `NODE_NAME`, `NODE_OPERATOR`, `NODE_JURISDICTION`, `NODE_SITE_LATITUDE`, `NODE_SITE_LONGITUDE`, `NODE_SITE_ALTITUDE_M`, which override the file. A node without a site still runs; pass prediction over its own site then answers `422` with `no_declared_site`.

## 3. Give it an identity

```bash
npm run keygen
```

prints a `did:key` and a PKCS#8 PEM. The DID is public and goes into every object the node signs. The PEM is the node's identity; whoever holds it can sign as the node. Keep it in a secrets manager, a protected file or an environment variable, never in the repository:

```bash
export NODE_SIGNING_PRIVATE_KEY="$(cat /etc/space-node/key.pem)"
```

A 64-hex seed works in place of the PEM. Without the variable the node generates an ephemeral key at start and labels itself `ephemeral_dev` everywhere, so nobody mistakes it for a durable identity. With `NODE_ENV=production` the process refuses to start without a key.

Rotating the key is a new identity. Old objects stay verifiable against the old DID; publish the new DID through `GET /identity` and keep the old receipts.

## 4. Protect the write routes

```bash
export NODE_OPERATOR_KEY="$(openssl rand -hex 24)"
```

Recording observations, ingesting from SatNOGS, and the operator orbit routes require the header `x-operator-key`. Without the variable those routes answer `503`, so a freshly started node never accepts anonymous writes. The public routes (identity, passes over the declared site, receipts, observations, verification) need no key and are rate limited per client address: `PUBLIC_RATE_LIMIT_MAX_REQUESTS` per `PUBLIC_RATE_LIMIT_WINDOW_MS`, default 30 per minute.

## 5. Start it

```bash
npm ci
npm start
```

The log's first line names the node, its DID, its signer mode and its site. Check:

```bash
curl -s localhost:3100/health
curl -s localhost:3100/identity
```

`durable_identity` must be `true` before you tell anyone about the node. Data lives in `NODE_DATA_DIR/node.sqlite` (default `./data`); back that file up and you have the node's whole history.

### As a container

```bash
docker build -t space-node .
docker run -d --name space-node -p 3100:3100 -v space-node-data:/data \
  -e NODE_SIGNING_PRIVATE_KEY="$(cat key.pem)" -e NODE_OPERATOR_KEY="..." \
  -e NODE_ID=node_mysite -e NODE_OPERATOR="My Organization" -e NODE_JURISDICTION=DE \
  -e NODE_SITE_LATITUDE=52.52 -e NODE_SITE_LONGITUDE=13.405 -e NODE_SITE_ALTITUDE_M=34 \
  space-node
```

The image sets `NODE_ENV=production`, so the key is required.

### Behind a reverse proxy

Put the node behind a TLS-terminating proxy and forward the client address (`x-forwarded-for`) if you want the per-client rate limit to see real clients; Fastify reads it when `trustProxy` is configured, which this node leaves off by default. Expose only port 3100.

## 6. Produce something

Passes over your site, free for anyone:

```bash
curl -s "localhost:3100/passes?norad_id=25544&hours=24" | jq '{count: .prediction.pass_count, first: .prediction.passes[0], signer: .envelope.signer}'
```

Record an observation (anything your receiver or software produced), signed and receipted:

```bash
curl -s -X POST localhost:3100/observations -H "x-operator-key: $NODE_OPERATOR_KEY" -H "content-type: application/json" \
  -d '{"observation":{"measurement_type":"noise_floor","value_dbm":-104.2,"observed_at":"2026-10-21T01:00:00Z"}}' | jq '{id: .observation_id, receipt: .receipt.receipt_id}'
```

Pull what the SatNOGS Network published for an object, and sign each observation as ingested by your node:

```bash
curl -s -X POST localhost:3100/observations/ingest -H "x-operator-key: $NODE_OPERATOR_KEY" -H "content-type: application/json" \
  -d '{"options":{"norad_id":25544,"limit":5}}' | jq '{origin: .observations_origin, new: .recorded_count, dup: .duplicate_count}'
```

SatNOGS stays the scheduler; your node does not schedule, vet or alter observations.

## 7. Let others verify you

Everything verifies offline with the primitive package:

```js
import { verifyEnvelope, verifyReceiptChain } from "@iricity/frontier-shared";
```

- An envelope verifies against the DID inside it. A consumer compares that DID with your `GET /identity` once, then never needs your node to be online to check an object you signed.
- `GET /receipts/verify` checks your whole chain against your stored records. A consumer can do the same with `GET /receipts` plus `GET /receipts/:id`, then `verifyReceiptChain(receipts, { expected_issuer: yourDid })`.
- Observations and stored predictions each have a `/verify` route for one-object checks.

Verification is public by design and costs nothing; this is how tampering would be detected.

## 8. What the node will not do

- Transmit, or claim it may. Authorizations are `receive` and `publish_data` only. Attaching a licence is an authorization record with `profile: regulator_issued`, bands and a reference; it is not generated by this node.
- Record observations as any other node, or accept observations without the operator key.
- Rewrite history. The receipt chain and the observation envelope chain are append-only. A repeated observation returns the existing entry.
- Invent data. No elements and no fixture is an error; a decayed object is `422`; a window the elements stop propagating in is marked `truncated_by_propagation_error`.

## 9. Keep it honest over time

- Watch `GET /health`: `durable_identity`, `declared_site`, `receipt_count`, and the elements cache (recent failures mean CelesTrak was unreachable and bundled elements may be in use; the response says `elements_origin: "fixture"` when they are).
- Back up `node.sqlite`. It is the chain.
- Element age degrades predictions by minutes per day; the prediction carries `elements_age_hours` so consumers can judge.

## 10. Next

Register the node with a registry (the reference registry in `iricity-state-stack` accepts signed envelopes at `POST /demo/ingest-envelope`), or hand your objects to any party that trusts your DID. Discovery across nodes is a later layer; today a node is found by its URL and trusted by its DID.
