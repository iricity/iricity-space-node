import "./setup-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require_child_process = () => createRequire(import.meta.url)("node:child_process");
import { buildApp } from "../src/app.js";
import { resetDbForTests } from "../src/store/db.js";
import { resetRateLimitForTests } from "../src/auth.js";
import { getNodeIdentity } from "../src/identity.js";
import { resetElementsCacheForTests, resolveOmm } from "../src/connectors/celestrak.js";
import { verifyEnvelope, verifyReceiptChain, verifyReceiptRecord } from "@iricity/frontier-shared";

const OPERATOR = { "x-operator-key": "test-operator-key", "content-type": "application/json" };
const FIXTURE = JSON.parse(fs.readFileSync(new URL("../src/connectors/fixtures/satnogs-observations-25544.json", import.meta.url), "utf8"));
const START = "start=2026-10-16T00:00:00Z&fixture=true";

async function makeApp() {
  await resetDbForTests();
  resetElementsCacheForTests();
  resetRateLimitForTests();
  const app = buildApp({ logger: false });
  await app.ready();
  return app;
}

test("the node describes itself: did:key identity, identity record, self-declared authorizations, site", async () => {
  const app = await makeApp();

  const root = await app.inject({ method: "GET", url: "/" });
  assert.equal(root.statusCode, 200);
  assert.equal(root.json().node_id, "node_test_delhi");
  assert.ok(root.json().endpoints.identity);

  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.json().status, "ok");
  assert.equal(health.json().declared_site, true);
  assert.equal(health.json().receipt_count, 0);

  const res = await app.inject({ method: "GET", url: "/identity" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.match(body.identity.did, /^did:key:z6Mk/);
  assert.equal(body.identity.signer_mode, "ephemeral_dev");
  assert.equal(body.identity.durable, false);
  assert.equal(body.identity_record.record_type, "entity");
  assert.equal(body.identity_record.identity_type, "node");
  assert.equal(body.identity_record.did, body.identity.did);
  assert.equal(body.identity_record.controller_id, "Example Operator");
  assert.deepEqual(body.site, { latitude: 28.6139, longitude: 77.209, altitude_m: 216 });
  assert.equal(body.identity.did, getNodeIdentity().did);
  assert.equal(res.headers["x-node-id"], "node_test_delhi");

  const auth = await app.inject({ method: "GET", url: "/authorizations" });
  const capabilities = auth.json().authorizations.map((a) => a.capability).sort();
  assert.deepEqual(capabilities, ["publish_data", "receive"]);
  for (const authorization of auth.json().authorizations) {
    assert.equal(authorization.profile, "self_declared");
    assert.equal(authorization.jurisdiction, "IN");
    assert.equal(authorization.subject_id, "node_test_delhi");
    assert.match(authorization.authorization_id, /^auth_[0-9a-f]{24}$/);
  }

  const descriptor = await app.inject({ method: "GET", url: "/.well-known/frontier-node.json" });
  assert.equal(descriptor.statusCode, 200);
  const envelope = descriptor.json();
  assert.equal(envelope.payload_type, "node-descriptor.json/1");
  assert.equal(envelope.payload.node_id, "node_test_delhi");
  assert.equal(envelope.payload.did, getNodeIdentity().did);
  assert.equal(envelope.payload.endpoints.passes, "/passes", "relative endpoints without NODE_PUBLIC_URL");
  assert.equal(envelope.payload.authorizations.length, 2);
  assert.equal(verifyEnvelope(envelope, { expected_signer: getNodeIdentity().did, allowed_payload_types: ["node-descriptor.json/1"] }).verified, true);

  const spec = await app.inject({ method: "GET", url: "/openapi.yaml" });
  assert.equal(spec.statusCode, 200);
  assert.match(spec.body, /openapi: 3\.1\.0/);

  await app.close();
});

test("public passes are signed, never stored, rate limited, and reject bad input", async () => {
  const app = await makeApp();
  const res = await app.inject({ method: "GET", url: `/passes?norad_id=25544&hours=24&${START}` });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.node_id, "node_test_delhi");
  assert.equal(body.persisted, false);
  assert.equal(body.receipt, null);
  assert.ok(body.prediction.pass_count >= 2);
  assert.equal(body.prediction.observer_id, "node_test_delhi");
  assert.equal(body.prediction.observer_source, "node_declared_site");
  assert.equal(body.envelope.payload_type, "pass-prediction.json/1");
  assert.equal(body.envelope.signer, getNodeIdentity().did);
  assert.ok(res.headers["x-ratelimit-limit"]);
  assert.equal(verifyEnvelope(body.envelope).verified, true);

  const viaApi = await app.inject({ method: "POST", url: "/envelopes/verify", payload: { envelope: body.envelope, expected_signer: body.envelope.signer } });
  assert.equal(viaApi.json().verified, true);
  const tampered = await app.inject({ method: "POST", url: "/envelopes/verify", payload: { ...body.envelope, payload: { ...body.envelope.payload, pass_count: 99 } } });
  assert.equal(tampered.json().verified, false);
  assert.equal((await app.inject({ method: "POST", url: "/envelopes/verify", payload: [1] })).statusCode, 400);

  assert.equal((await app.inject({ method: "GET", url: "/receipts" })).json().count, 0);
  assert.equal((await app.inject({ method: "GET", url: "/orbital/passes/history" })).json().predictions.length, 0);

  const bare = await app.inject({ method: "GET", url: "/passes?norad_id=25544&hours=1&start=2026-10-16T00:00:00&fixture=true" });
  assert.equal(bare.json().prediction.window_start, "2026-10-16T00:00:00.000Z", "zone-less start is UTC");
  const clamped = await app.inject({ method: "GET", url: `/passes?norad_id=25544&hours=500&${START}` });
  assert.equal(clamped.json().prediction.window_end, "2026-10-18T00:00:00.000Z");

  for (const url of ["/passes?hours=0&fixture=true", "/passes?hours=abc&fixture=true", "/passes?start=yesterday&fixture=true", "/passes?norad_id=-1&fixture=true"]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 400, url);
  }
  const unknown = await app.inject({ method: "GET", url: "/passes?norad_id=424242&fixture=true" });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().code, "elements_not_bundled");
  const decayed = await app.inject({ method: "GET", url: "/passes?norad_id=25544&start=2036-10-16T00:00:00Z&hours=1&fixture=true" });
  assert.equal(decayed.statusCode, 422);
  assert.equal(decayed.json().code, "propagation_failed");

  resetRateLimitForTests();
  let limited = null;
  for (let i = 0; i < 40; i += 1) {
    const r = await app.inject({ method: "GET", url: `/passes?norad_id=25544&hours=1&${START}`, remoteAddress: "203.0.113.5" });
    if (r.statusCode === 429) { limited = r; break; }
  }
  assert.ok(limited, "keyless compute is rate limited per client");
  assert.ok(limited.headers["retry-after"]);

  await app.close();
});

test("operator routes need the key, store predictions with receipts, and expose state", async () => {
  const app = await makeApp();
  assert.equal((await app.inject({ method: "GET", url: "/orbital/passes?fixture=true" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/orbital/passes?fixture=true", headers: { "x-operator-key": "wrong" } })).statusCode, 401);

  const res = await app.inject({ method: "GET", url: `/orbital/passes?norad_id=25544&latitude=18.5204&longitude=73.8567&altitude_m=560&hours=12&${START}`, headers: OPERATOR });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.prediction.observer_id, null);
  assert.equal(body.prediction.observer_source, "request");
  assert.equal(body.persisted, true);
  assert.equal(body.receipt.signature_algorithm, "ed25519");
  assert.equal(verifyReceiptRecord(body.receipt, { record: body.prediction }).verified, true);

  const declared = await app.inject({ method: "GET", url: `/orbital/passes?norad_id=25544&hours=12&${START}`, headers: OPERATOR });
  assert.equal(declared.statusCode, 200, declared.body);
  assert.notEqual(declared.json().prediction_id, body.prediction_id);
  assert.equal(declared.json().prediction.observer_id, "node_test_delhi");
  assert.equal(declared.json().receipt.previous_hash, body.receipt.receipt_hash);

  const stored = await app.inject({ method: "GET", url: `/orbital/passes/${body.prediction_id}` });
  assert.equal(stored.json().verification.verified, true);
  assert.equal(stored.json().receipt_verification.verified, true);
  assert.equal((await app.inject({ method: "GET", url: "/orbital/passes/history?norad_id=25544" })).json().predictions.length, 2);

  for (const url of ["/orbital/passes?latitude=abc&longitude=1&fixture=true", "/orbital/passes?latitude=91&longitude=1&fixture=true", "/orbital/passes?latitude=1&fixture=true", "/orbital/state?norad_id=25544&at=noon&fixture=true", "/orbital/state?norad_id=x&fixture=true"]) {
    assert.equal((await app.inject({ method: "GET", url, headers: OPERATOR })).statusCode, 400, url);
  }
  const state = await app.inject({ method: "GET", url: "/orbital/state?norad_id=25544&at=2026-10-16T00:00:00Z&latitude=28.6139&longitude=77.209&fixture=true", headers: OPERATOR });
  assert.equal(state.statusCode, 200, state.body);
  assert.ok(state.json().state.geodetic.altitude_km > 300);
  assert.ok(state.json().state.look_angles);
  assert.equal((await app.inject({ method: "GET", url: "/orbital/state?norad_id=25544&at=2036-10-16T00:00:00Z&fixture=true", headers: OPERATOR })).statusCode, 422);

  const receipts = await app.inject({ method: "GET", url: "/receipts?subject_kind=pass_prediction" });
  assert.equal(receipts.json().count, 2);
  assert.equal((await app.inject({ method: "GET", url: "/health" })).json().receipt_count, 2);
  await app.close();
});

test("observations are wrapped, signed, chained, idempotent and verifiable; the chain verifies online and offline", async () => {
  const app = await makeApp();

  const first = await app.inject({ method: "POST", url: "/observations", headers: OPERATOR, payload: { observation: FIXTURE[0], source: "satnogs" } });
  assert.equal(first.statusCode, 201, first.body);
  const firstBody = first.json();
  assert.match(firstBody.observation_id, /^obs_[0-9a-f]{24}$/);
  assert.equal(firstBody.record.measurement_type, "rf_observation");
  assert.equal(firstBody.record.payload_profile, "satnogs.observation.json/1");
  assert.deepEqual(firstBody.record.value, FIXTURE[0]);
  assert.equal(firstBody.envelope.previous_envelope_hash, null);
  assert.equal(firstBody.receipt.previous_hash, null);

  const local = await app.inject({ method: "POST", url: "/observations", headers: OPERATOR, payload: { observation: { measurement_type: "noise_floor", value_dbm: -104.2, observed_at: "2026-10-16T01:00:00" } } });
  assert.equal(local.statusCode, 201, local.body);
  const localBody = local.json();
  assert.equal(localBody.record.payload_profile, "opaque.json/1");
  assert.equal(localBody.record.sensor_id, "node_test_delhi");
  assert.equal(localBody.record.timestamp, "2026-10-16T01:00:00.000Z");
  assert.equal(localBody.envelope.previous_envelope_hash, firstBody.envelope.envelope_hash);
  assert.equal(localBody.receipt.previous_hash, firstBody.receipt.receipt_hash);

  const repeat = await app.inject({ method: "POST", url: "/observations", headers: OPERATOR, payload: { observation: FIXTURE[0], source: "satnogs" } });
  assert.equal(repeat.statusCode, 200);
  assert.equal(repeat.json().already_recorded, true);
  assert.equal(repeat.json().envelope.envelope_hash, firstBody.envelope.envelope_hash);

  const third = await app.inject({ method: "POST", url: "/observations", headers: OPERATOR, payload: { observation: { measurement_type: "noise_floor", value_dbm: -101 } } });
  assert.equal(third.json().envelope.previous_envelope_hash, localBody.envelope.envelope_hash);
  assert.equal(third.json().record.timestamp_source, "recorded_at");

  const verify = await app.inject({ method: "GET", url: `/observations/${firstBody.observation_id}/verify` });
  assert.equal(verify.json().verified, true, verify.body);
  assert.equal((await app.inject({ method: "GET", url: "/observations?source=satnogs" })).json().observations.length, 1);
  assert.equal((await app.inject({ method: "GET", url: `/observations/${localBody.observation_id}` })).json().record.measurement_type, "noise_floor");

  assert.equal((await app.inject({ method: "POST", url: "/observations", headers: OPERATOR, payload: { observation: { id: 1 }, source: "satnogs" } })).statusCode, 400);
  let nested = { leaf: true };
  for (let i = 0; i < 300; i += 1) nested = { nested };
  assert.equal((await app.inject({ method: "POST", url: "/observations", headers: OPERATOR, payload: { observation: nested } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/observations", headers: OPERATOR, payload: { node_id: "someone_else", observation: { a: 1 } } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/observations", payload: { observation: { a: 1 } } })).statusCode, 401);

  const ingest = await app.inject({ method: "POST", url: "/observations/ingest", headers: OPERATOR, payload: { options: { norad_id: 25544, limit: 2, fixture: true } } });
  assert.equal(ingest.statusCode, 201, ingest.body);
  assert.equal(ingest.json().ingested_count, 2);
  assert.equal(ingest.json().duplicate_count, 1);
  assert.equal(ingest.json().recorded_count, 1);

  const receipts = await app.inject({ method: "GET", url: "/receipts" });
  assert.equal(receipts.json().count, 4);
  assert.equal(receipts.json().issuer, getNodeIdentity().did);
  const chain = await app.inject({ method: "GET", url: "/receipts/verify" });
  assert.equal(chain.json().verified, true, chain.json().errors.join("; "));
  assert.equal(chain.json().records_verified, 4);

  const single = await app.inject({ method: "GET", url: `/receipts/${localBody.receipt.receipt_id}` });
  assert.equal(single.json().verified, true);
  assert.equal(single.json().previous_receipt_id, firstBody.receipt.receipt_id);
  assert.equal((await app.inject({ method: "GET", url: "/receipts/rcp_nope" })).statusCode, 404);

  const stored = [];
  for (const summary of receipts.json().receipts) stored.push((await app.inject({ method: "GET", url: `/receipts/${summary.receipt_id}` })).json().receipt);
  assert.equal(verifyReceiptChain(stored, { expected_issuer: getNodeIdentity().did }).verified, true);

  await app.close();
});

test("the CelesTrak connector remembers failures and shares in-flight fetches", async () => {
  resetElementsCacheForTests();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("network down"); };
  try {
    assert.equal((await resolveOmm(25544)).origin, "fixture");
    assert.match((await resolveOmm(25544)).note, /skipped after a recent failure/);
    assert.equal(calls, 1);
    await assert.rejects(() => resolveOmm(424242), (error) => error.status === 502);
  } finally {
    globalThis.fetch = original;
    resetElementsCacheForTests();
  }
});

test("without an operator key configured the write routes refuse instead of accepting anonymous writes", () => {
  const { spawnSync } = require_child_process();
  const code = `
    const { requireOperatorKey } = await import("./src/auth.js");
    const out = [];
    const reply = { code(s) { out.push(s); return this; }, send(b) { out.push(b.code); return this; } };
    await requireOperatorKey({ headers: { "x-operator-key": "anything" } }, reply);
    console.log(JSON.stringify(out));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: new URL("..", import.meta.url), env: { ...process.env, NODE_OPERATOR_KEY: "" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), [503, "operator_key_unset"]);
});
