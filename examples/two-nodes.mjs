/**
 * Two nodes, run as separate processes with their own keys and sites, verify each
 * other's objects without trusting each other, and optionally hand them to a
 * registry that receipts both into one chain.
 *
 *   node examples/two-nodes.mjs                      # peer-to-peer only
 *   node examples/two-nodes.mjs --registry http://127.0.0.1:8787   # also through a registry
 *   REGISTRY_URL=... node examples/two-nodes.mjs
 *
 * Everything runs offline: passes use the bundled elements, observations the
 * bundled SatNOGS fixture. Exit code 0 when every check passed.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateEd25519KeyPair, verifyEnvelope, verifyReceiptChain } from "@iricity/frontier-shared";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "..", "src", "server.js");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(here, "..", "src", "connectors", "fixtures", "satnogs-observations-25544.json"), "utf8"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startNode({ id, operator, site, root }) {
  const pair = generateEd25519KeyPair();
  const operatorKey = `op_${id}_${Math.random().toString(16).slice(2)}`;
  const dataDir = path.join(root, id);
  fs.mkdirSync(dataDir, { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      NODE_ID: id,
      NODE_NAME: `${id} (demo)`,
      NODE_OPERATOR: operator,
      NODE_JURISDICTION: "IN",
      NODE_SITE_LATITUDE: String(site.latitude),
      NODE_SITE_LONGITUDE: String(site.longitude),
      NODE_SITE_ALTITUDE_M: String(site.altitude_m),
      NODE_MANIFEST_PATH: path.join(dataDir, "no-manifest.json"),
      NODE_SIGNING_PRIVATE_KEY: pair.private_key_pem,
      NODE_OPERATOR_KEY: operatorKey,
      NODE_DATA_DIR: dataDir,
      PORT: String(port),
      HOST: "127.0.0.1"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${id} exited early: ${stderr}`);
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  return {
    id,
    base,
    did: pair.did,
    operatorKey,
    stop: () => new Promise((resolve) => { child.once("exit", resolve); child.kill(); })
  };
}

async function json(url, init) {
  const res = await fetch(url, init);
  const body = await res.json();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

function post(node, route, body) {
  return json(`${node.base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-key": node.operatorKey },
    body: JSON.stringify(body)
  });
}

async function fetchChain(node) {
  const list = await json(`${node.base}/receipts`);
  const receipts = [];
  for (const summary of list.receipts) receipts.push((await json(`${node.base}/receipts/${summary.receipt_id}`)).receipt);
  return receipts;
}

/**
 * @param {object} [options]
 * @param {string|null} [options.registryUrl]  a state registry (`iricity-state-stack` server); omit for peer-to-peer only
 * @param {(line: string) => void} [options.log]
 */
export async function runTwoNodesDemo({ registryUrl = process.env.REGISTRY_URL || null, log = () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "two-nodes-"));
  const checks = [];
  const check = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok), detail }); log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); };

  const [a, b] = await Promise.all([
    startNode({ id: "node_a_delhi", operator: "Operator A", site: { latitude: 28.6139, longitude: 77.209, altitude_m: 216 }, root }),
    startNode({ id: "node_b_pune", operator: "Operator B", site: { latitude: 18.5204, longitude: 73.8567, altitude_m: 560 }, root })
  ]);
  log(`A ${a.id} ${a.did} at ${a.base}`);
  log(`B ${b.id} ${b.did} at ${b.base}`);

  let registry = null;
  try {
    // 1. Each node learns the other's identity from its public surface, once.
    const identityA = await json(`${a.base}/identity`);
    const identityB = await json(`${b.base}/identity`);
    check("A publishes a durable did:key identity", identityA.identity.did === a.did && identityA.identity.durable);
    check("B publishes a durable did:key identity", identityB.identity.did === b.did && identityB.identity.durable);
    check("identities differ", a.did !== b.did);

    // 2. A produces: one observation (receipted) and one pass prediction (signed, not kept).
    const observationA = await post(a, "/observations", { observation: FIXTURE[0], source: "satnogs" });
    const passesA = await json(`${a.base}/passes?norad_id=25544&hours=24&start=2026-10-16T00:00:00Z&fixture=true`);
    check("A recorded an observation with a receipt", observationA.receipt?.signature_algorithm === "ed25519");
    check("A predicted passes over its own site", passesA.prediction.pass_count >= 1 && passesA.prediction.observer_id === a.id);

    // 3. B verifies A's objects offline, against A's DID, and through its own verifier route.
    const offline = verifyEnvelope(observationA.envelope, { expected_signer: identityA.identity.did });
    check("B verifies A's observation offline against A's DID", offline.verified, offline.errors.join("; "));
    const viaB = await json(`${b.base}/envelopes/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope: passesA.envelope, expected_signer: a.did }) });
    check("B's verifier accepts A's pass prediction", viaB.verified, viaB.errors?.join("; "));
    const wrongSigner = verifyEnvelope(observationA.envelope, { expected_signer: b.did });
    check("A's observation does not pass as B's", !wrongSigner.verified);
    const tampered = verifyEnvelope({ ...observationA.envelope, payload: { ...observationA.envelope.payload, value: { ...FIXTURE[0], status: "forged" } } }, { expected_signer: a.did });
    check("a tampered copy of A's observation is refused", !tampered.verified);
    const chainA = verifyReceiptChain(await fetchChain(a), { expected_issuer: a.did });
    check("A's receipt chain verifies end to end", chainA.verified && chainA.length === 1, chainA.errors.join("; "));

    // 4. B records what it verified, as its own signed observation that names A's object.
    const attestation = await post(b, "/observations", {
      observation: {
        measurement_type: "peer_verification",
        peer_node: a.id,
        peer_did: a.did,
        peer_envelope_hash: observationA.envelope.envelope_hash,
        peer_envelope_id: observationA.envelope.envelope_id,
        verified: true,
        observed_at: new Date().toISOString()
      },
      source: "peer"
    });
    check("B recorded its verification as a signed observation", attestation.envelope.signer === b.did && attestation.record.value.peer_envelope_hash === observationA.envelope.envelope_hash);

    // 5. A verifies B's attestation in turn.
    const viaA = await json(`${a.base}/envelopes/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope: attestation.envelope, expected_signer: b.did }) });
    check("A's verifier accepts B's attestation", viaA.verified, viaA.errors?.join("; "));
    const chainB = verifyReceiptChain(await fetchChain(b), { expected_issuer: b.did });
    check("B's receipt chain verifies end to end", chainB.verified && chainB.length === 1, chainB.errors.join("; "));

    // 6. Optionally, both envelopes go to a registry, which receipts them into one chain.
    if (registryUrl) {
      const base = registryUrl.replace(/\/$/, "");
      const registryIdentity = await json(`${base}/identity`);
      const ingestA = await json(`${base}/demo/ingest-envelope`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(observationA.envelope) });
      const ingestB = await json(`${base}/demo/ingest-envelope`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(attestation.envelope) });
      check("registry accepted A's observation and attributes it to A", ingestA.record.signer === a.did && ingestA.receipt.issuer === registryIdentity.did);
      check("registry accepted B's attestation and attributes it to B", ingestB.record.signer === b.did && ingestB.receipt.previous_hash === ingestA.receipt.receipt_hash);
      const chain = await json(`${base}/demo/receipts/verify-chain`);
      check("registry chain verifies with both nodes' records in it", chain.verified, chain.errors?.join("; "));
      let forgedRejected = false;
      try {
        await json(`${base}/demo/ingest-envelope`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...observationA.envelope, signer: b.did }) });
      } catch {
        forgedRejected = true;
      }
      check("registry refuses A's observation re-labelled as B's", forgedRejected);
      registry = { url: base, did: registryIdentity.did, receipts: { a: ingestA.receipt.receipt_id, b: ingestB.receipt.receipt_id }, chain_length: chain.length };
    }
  } finally {
    await Promise.all([a.stop(), b.stop()]);
    fs.rmSync(root, { recursive: true, force: true });
  }

  return {
    ok: checks.every((c) => c.ok),
    nodes: { a: { id: a.id, did: a.did }, b: { id: b.id, did: b.did } },
    registry,
    checks
  };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const flag = process.argv.indexOf("--registry");
  const registryUrl = flag >= 0 ? process.argv[flag + 1] : process.env.REGISTRY_URL || null;
  const result = await runTwoNodesDemo({ registryUrl, log: (line) => process.stdout.write(`${line}\n`) });
  process.stdout.write(`\n${result.ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}: ${result.checks.filter((c) => c.ok).length}/${result.checks.length}${result.registry ? ` (registry ${result.registry.did}, chain length ${result.registry.chain_length})` : " (no registry)"}\n`);
  process.exit(result.ok ? 0 : 1);
}
