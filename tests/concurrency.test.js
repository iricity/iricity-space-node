import "./setup-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { resetDbForTests } from "../src/store/db.js";
import { recordObservation, verifyNodeReceiptChain } from "../src/agent.js";
import { ChainConflictError, createNodeStore, listObservations, wrapLibsqlClient } from "../src/store/nodeStore.js";
import { issueNodeReceipt } from "../src/identity.js";

const FIXTURE = JSON.parse(fs.readFileSync(new URL("../src/connectors/fixtures/satnogs-observations-25544.json", import.meta.url), "utf8"));

test("concurrent observations extend one linear chain; a repeated observation is recorded once", async () => {
  await resetDbForTests();
  const observations = Array.from({ length: 6 }, (_, i) => ({ ...FIXTURE[i % FIXTURE.length], id: 900000 + i }));
  const results = await Promise.all([
    ...observations.map((observation) => recordObservation({ observation, source: "satnogs" })),
    recordObservation({ observation: observations[0], source: "satnogs" }),
    recordObservation({ observation: observations[1], source: "satnogs" })
  ]);
  assert.equal(results.length, 8);
  assert.equal(new Set(results.map((entry) => entry.observation_id)).size, observations.length);

  const chain = await verifyNodeReceiptChain();
  assert.equal(chain.length, observations.length);
  assert.equal(chain.verified, true, chain.errors.join("; "));

  // Envelope chain: each envelope names a distinct predecessor, starting from genesis.
  const stored = await listObservations({ limit: 100 });
  const predecessors = stored.map((entry) => entry.envelope.previous_envelope_hash ?? "genesis");
  assert.equal(new Set(predecessors).size, stored.length);
  assert.equal(predecessors.filter((value) => value === "genesis").length, 1);
});

function sampleReceipt(previous_hash, n) {
  return issueNodeReceipt({ record: { record_type: "measurement", n }, previous_hash });
}

async function assertGuards(store, label) {
  const guards = await store.chainGuards();
  assert.ok(guards.length >= 2 && guards.every((guard) => guard.active), `${label}: ${JSON.stringify(guards)}`);

  const first = sampleReceipt(null, 1);
  await store.saveNodeReceipt({ node_id: "n1", subject_kind: "observation", subject_id: "a", receipt: first });
  // A second genesis, and a second successor of the same receipt, are refused.
  await assert.rejects(
    () => store.saveNodeReceipt({ node_id: "n1", subject_kind: "observation", subject_id: "b", receipt: sampleReceipt(null, 2) }),
    ChainConflictError, `${label}: second genesis`
  );
  await store.saveNodeReceipt({ node_id: "n1", subject_kind: "observation", subject_id: "c", receipt: sampleReceipt(first.receipt_hash, 3) });
  await assert.rejects(
    () => store.saveNodeReceipt({ node_id: "n1", subject_kind: "observation", subject_id: "d", receipt: sampleReceipt(first.receipt_hash, 4) }),
    ChainConflictError, `${label}: fork`
  );
  // Another node has its own chain.
  await store.saveNodeReceipt({ node_id: "n2", subject_kind: "observation", subject_id: "e", receipt: sampleReceipt(null, 5) });

  // Object and receipt are written together or not at all.
  const entry = {
    observation_id: "obs_atomic", node_id: "n1", source: "local", norad_cat_id: null, observed_at: null, payload_profile: "opaque.json/1",
    payload_hash: "sha256:x", record: { n: 6 }, envelope: { envelope_hash: "sha256:e1", signer: "did:key:z", previous_envelope_hash: null },
    receipt: sampleReceipt(first.receipt_hash, 6), created_at: new Date().toISOString()
  };
  await assert.rejects(() => store.saveObservationWithReceipt(entry, { node_id: "n1" }), ChainConflictError, `${label}: atomic`);
  assert.equal(await store.getObservationById("obs_atomic"), null, `${label}: observation without its receipt`);
  assert.equal(await store.countNodeReceipts("n1"), 2);
}

test("the chain guards hold on sql.js", async () => {
  await resetDbForTests();
  const store = createNodeStore(await import("../src/store/db.js"));
  await assertGuards(store, "sqljs");
});

test("the chain guards hold on libSQL, shared by two clients of one database", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "space-node-libsql-"));
  const url = pathToFileURL(path.join(dir, "node.db")).href;
  const clients = [createClient({ url }), createClient({ url })];
  try {
    const [a, b] = clients.map((client) => {
      const db = wrapLibsqlClient(client);
      return createNodeStore({ ensureDb: async () => db, persistDb: async () => {} });
    });
    await assertGuards(a, "libsql");
    // The second client sees the first client's chain and cannot fork it.
    const head = (await b.listNodeReceipts({ node_id: "n1" })).at(-1);
    await assert.rejects(
      () => b.saveNodeReceipt({ node_id: "n1", subject_kind: "observation", subject_id: "z", receipt: sampleReceipt(head.previous_hash, 9) }),
      ChainConflictError
    );
    await b.saveNodeReceipt({ node_id: "n1", subject_kind: "observation", subject_id: "z", receipt: sampleReceipt(head.receipt_hash, 9) });
    assert.equal(await a.countNodeReceipts("n1"), 3);
  } finally {
    for (const client of clients) client.close();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows may hold the file briefly */ }
  }
});
