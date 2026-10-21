/**
 * Two guards. Public compute routes are limited per client address. Write routes
 * need the operator key; without one configured they refuse, so a node never
 * accepts anonymous writes by accident.
 */

import { timingSafeEqual } from "node:crypto";
import { NODE_OPERATOR_KEY, PUBLIC_RATE_LIMIT_MAX_REQUESTS, PUBLIC_RATE_LIMIT_WINDOW_MS } from "./config.js";

const buckets = new Map();

export function enforcePublicRateLimit(req, reply, done) {
  const key = `public:${req.ip || "unknown"}`;
  const now = Date.now();
  const current = buckets.get(key) || { count: 0, resetAt: now + PUBLIC_RATE_LIMIT_WINDOW_MS };
  if (now > current.resetAt) {
    current.count = 0;
    current.resetAt = now + PUBLIC_RATE_LIMIT_WINDOW_MS;
  }
  current.count += 1;
  buckets.set(key, current);
  if (buckets.size > 5000) {
    for (const [k, bucket] of buckets) if (now > bucket.resetAt) buckets.delete(k);
  }

  reply.header("x-ratelimit-limit", PUBLIC_RATE_LIMIT_MAX_REQUESTS);
  reply.header("x-ratelimit-remaining", Math.max(PUBLIC_RATE_LIMIT_MAX_REQUESTS - current.count, 0));
  reply.header("x-ratelimit-reset", current.resetAt);
  if (current.count > PUBLIC_RATE_LIMIT_MAX_REQUESTS) {
    reply.header("retry-after", Math.max(Math.ceil((current.resetAt - now) / 1000), 1));
    reply.code(429).send({ error: "Too Many Requests", request_id: req.id });
    return;
  }
  done();
}

function keysMatch(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function requireOperatorKey(req, reply) {
  if (!NODE_OPERATOR_KEY) {
    return reply.code(503).send({ error: "operator key not configured; set NODE_OPERATOR_KEY to enable write routes", code: "operator_key_unset" });
  }
  const given = req.headers["x-operator-key"];
  if (!given || !keysMatch(given, NODE_OPERATOR_KEY)) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
}

export function resetRateLimitForTests() {
  buckets.clear();
}
