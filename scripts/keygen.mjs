#!/usr/bin/env node
// Prints a fresh ed25519 node key: the did:key to publish and the PEM to keep secret.
import { generateEd25519KeyPair } from "@iricity/frontier-shared";

const pair = generateEd25519KeyPair();
process.stdout.write(`did: ${pair.did}\n\nNODE_SIGNING_PRIVATE_KEY (keep this out of the repository):\n${pair.private_key_pem}\n`);
