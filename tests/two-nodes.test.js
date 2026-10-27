import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { runTwoNodesDemo } from "../examples/two-nodes.mjs";

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/** When STATE_STACK_DIR names a checkout of the reference registry, the demo also runs through it. */
async function startRegistry() {
  const dir = process.env.STATE_STACK_DIR;
  if (!dir) return null;
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(dir, "src", "server.js")], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" }, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url, stop: () => child.kill() };
}

test("two independent nodes verify each other's objects, and a registry receipts both into one chain", async () => {
  const registry = await startRegistry();
  try {
    const result = await runTwoNodesDemo({ registryUrl: registry?.url ?? null });
    const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    assert.equal(result.ok, true, failed.join("\n"));
    assert.notEqual(result.nodes.a.did, result.nodes.b.did);
    assert.ok(result.checks.length >= 12);
    if (registry) {
      assert.ok(result.registry);
      assert.equal(result.registry.chain_length >= 2, true);
    } else {
      assert.equal(result.registry, null);
    }
  } finally {
    registry?.stop();
  }
});
