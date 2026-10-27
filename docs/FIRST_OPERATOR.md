# For a first outside operator

What you get, what it costs you, and how to say yes. This is the whole pitch; there is no sales call behind it.

## What you get

- A node that is yours. One process, one key you generate, one declared site. It publishes a verifiable identity, a machine-readable statement of what your station may do (receive-only by default; a licence can be attached later), pass predictions over your site, and signed observations of what you heard.
- Provenance the SatNOGS Network does not give you: every observation you record or ingest is signed by your key and chained in a receipt chain anyone can verify offline. Nobody, including us, can alter or re-attribute it afterwards.
- Independence. Nothing in the node needs us to be reachable. Our registry can discover you and anchor your chain; so can anyone else's. If we vanish, your node and your records keep verifying.
- Apache-2.0 code and a CC BY 4.0 specification. You can read all of it before running any of it.

## What it costs you

- A machine that stays on (a mini PC or a small VPS), Node.js 20 or newer, and about an hour the first time. No radio is required to start; a node with no receiver still publishes a useful identity and pass predictions.
- Your site coordinates at city-level accuracy and a jurisdiction code. Nothing else about you is published; the operator field is whatever name you choose.
- Keeping one private key safe. Lose it and you start a new identity; leak it and someone can sign as you.

## How to say yes

1. Follow [RUN_YOUR_OWN_NODE.md](RUN_YOUR_OWN_NODE.md). It ends with a node whose `/health` says `durable_identity: true`.
2. Set `NODE_PUBLIC_URL` to the address others can reach you at, so your descriptor at `/.well-known/frontier-node.json` carries absolute endpoints.
3. Send us that URL. We fetch the descriptor, verify it against your DID, and list your node in our registry; you can do the same with ours. Nothing else is exchanged.

## What we ask in return

Honest reports. If a pass prediction is off, an observation is wrong, the docs mislead you, or the node does something you did not expect, say so. The first outside node is how the protocol learns what it got wrong.

## What this is not

Not a service you pay for, not a network you join, not a token. A node is an operator's own statement about their own station, in a form other people can check.
