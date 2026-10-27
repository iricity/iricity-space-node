# Two nodes

`examples/two-nodes.mjs` is the federation sketch made runnable: two nodes, two keys, two sites, no shared secret, verifying each other and then a registry receipting both.

```bash
npm run demo:two-nodes                                   # peer-to-peer only
npm run demo:two-nodes -- --registry http://127.0.0.1:8787   # also through a registry
```

The registry is the reference registry from `iricity-state-stack` (`npm start` there). Everything else is offline: bundled elements, bundled observations, ephemeral keys generated for the run.

## What happens

1. **Identity.** Each node starts as its own process with its own `NODE_SIGNING_PRIVATE_KEY`, site and operator key. Each learns the other's DID from `GET /identity`, once.
2. **A produces.** Node A records a SatNOGS observation (receipted in A's chain) and predicts passes over its own site (signed, not kept).
3. **B verifies A.** Offline, with `verifyEnvelope` against A's DID; through B's own `POST /envelopes/verify`; A's whole receipt chain with `verifyReceiptChain`. The same object fails as B's, and a tampered copy fails outright.
4. **B attests.** B records what it verified as its own signed observation, naming A's envelope hash. This is the smallest cross-node statement the protocol supports: one node vouching, under its own key, for what it checked.
5. **A verifies B.** A's verifier accepts B's attestation; B's chain verifies.
6. **Registry.** With `--registry`, both envelopes are ingested. The registry attributes each record to the node that signed it, receipts both into one chain, and refuses A's observation when it is re-labelled as B's.

The run prints one line per check and exits 0 only if all pass. `tests/two-nodes.test.js` runs the same flow; set `STATE_STACK_DIR` to a checkout of the registry to include step 6.

## What it shows

- Trust is per object and per key. Nothing a node says about another node is taken on its word; the signature is checked against the DID.
- A registry adds order, not authority. Its receipts say when it accepted what; the objects still verify against their producers without it.
- A second operator needs this repository and their own key. Nothing in the demo belongs to the first operator.

## What it does not show yet

Discovery (how B finds A without a URL), scheduling, and two registries reconciling their chains. Those are the next layers, in that order.
