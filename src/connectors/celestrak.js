/**
 * CelesTrak general-perturbations connector.
 *
 * Fetches the current CCSDS OMM (JSON key-value form) for a NORAD catalogue number
 * and returns it unchanged. Falls back to a bundled fixture when the network is
 * unavailable or `options.fixture` is set, and always says which it used.
 *
 * Upstream is protected from this node: one live request per catalogue number is
 * in flight at a time, successes are cached for ELEMENTS_CACHE_TTL_MS, and failures
 * are remembered for ELEMENTS_NEGATIVE_CACHE_TTL_MS so a burst of requests for an
 * unknown or unreachable object does not become a burst of upstream calls.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CELESTRAK_GP_BASE_URL,
  CONNECTOR_TIMEOUT_MS,
  DEFAULT_NORAD_CAT_ID,
  ELEMENTS_CACHE_TTL_MS,
  ELEMENTS_NEGATIVE_CACHE_TTL_MS
} from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../orbital/fixtures");
const cache = new Map();
const failures = new Map();
const inflight = new Map();

export const MIN_CONNECTOR_TIMEOUT_MS = 1000;
export const MAX_CONNECTOR_TIMEOUT_MS = 30000;

/** Bound a caller-supplied timeout so a request cannot hold an upstream socket open indefinitely. */
export function clampTimeoutMs(value, fallback = CONNECTOR_TIMEOUT_MS) {
  const parsed = Number(value);
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(Math.max(base, MIN_CONNECTOR_TIMEOUT_MS), MAX_CONNECTOR_TIMEOUT_MS);
}

function withStatus(error, status, code) {
  error.status = status;
  if (code) error.code = code;
  return error;
}

function loadFixture(noradId) {
  const file = path.join(fixturesDir, `omm-${noradId}.json`);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

export function listOmmFixtures() {
  return fs.readdirSync(fixturesDir)
    .filter((file) => /^omm-\d+\.json$/.test(file))
    .map((file) => Number(file.slice(4, -5)));
}

export function parseNoradId(value, fallback = DEFAULT_NORAD_CAT_ID) {
  if (value === undefined || value === null || value === "") return fallback;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > 999999999) throw new TypeError("norad_id must be a positive integer");
  return id;
}

async function fetchLive(id, url, timeoutMs) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`CelesTrak returned ${response.status}`);
  const body = await response.json();
  const omm = Array.isArray(body) ? body[0] : body;
  if (!omm || typeof omm !== "object" || !omm.EPOCH) throw new Error("CelesTrak response did not contain an OMM");
  if (Number(omm.NORAD_CAT_ID) !== id) throw new Error(`CelesTrak returned elements for NORAD ${omm.NORAD_CAT_ID}, not ${id}`);
  return omm;
}

function fallbackToFixture(id, now, url, reason, note) {
  const fixture = loadFixture(id);
  if (fixture) {
    return {
      omm: fixture,
      origin: "fixture",
      fetched_at: new Date(now).toISOString(),
      source_url: url,
      note: `${note} (${reason}); using bundled elements, which may be stale`
    };
  }
  throw withStatus(new Error(`no elements available for NORAD ${id}: ${reason}`), 502, "elements_unavailable");
}

/**
 * Resolve an OMM for `noradId`.
 * @returns {{ omm: object, origin: 'live'|'cache'|'fixture', fetched_at: string, source_url: string|null, note?: string }}
 */
export async function resolveOmm(noradId = DEFAULT_NORAD_CAT_ID, options = {}) {
  const id = parseNoradId(noradId);
  const url = `${CELESTRAK_GP_BASE_URL}?CATNR=${id}&FORMAT=json`;
  const now = Date.now();

  if (options.fixture) {
    const fixture = loadFixture(id);
    if (!fixture) throw withStatus(new Error(`no bundled elements for NORAD ${id}`), 404, "elements_not_bundled");
    return { omm: fixture, origin: "fixture", fetched_at: new Date(now).toISOString(), source_url: null };
  }

  const hit = cache.get(id);
  if (hit && now - hit.at < ELEMENTS_CACHE_TTL_MS && !options.refresh) {
    return { omm: hit.omm, origin: "cache", fetched_at: new Date(hit.at).toISOString(), source_url: url };
  }

  const recentFailure = failures.get(id);
  if (recentFailure && now - recentFailure.at < ELEMENTS_NEGATIVE_CACHE_TTL_MS && !options.refresh) {
    return fallbackToFixture(id, now, url, recentFailure.message, "live fetch skipped after a recent failure");
  }

  let pending = inflight.get(id);
  if (!pending) {
    pending = fetchLive(id, url, clampTimeoutMs(options.timeout_ms))
      .then((omm) => {
        cache.set(id, { omm, at: Date.now() });
        failures.delete(id);
        return omm;
      })
      .catch((error) => {
        failures.set(id, { at: Date.now(), message: error.message });
        throw error;
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, pending);
  }

  try {
    const omm = await pending;
    return { omm, origin: "live", fetched_at: new Date(cache.get(id)?.at ?? now).toISOString(), source_url: url };
  } catch (error) {
    return fallbackToFixture(id, now, url, error.message, "live fetch failed");
  }
}

/** Cache posture, for health surfaces and tests. */
export function describeElementsCache() {
  return {
    cached: [...cache.keys()],
    recent_failures: [...failures.entries()].map(([norad_cat_id, failure]) => ({ norad_cat_id, at: new Date(failure.at).toISOString(), message: failure.message })),
    in_flight: [...inflight.keys()],
    ttl_ms: ELEMENTS_CACHE_TTL_MS,
    negative_ttl_ms: ELEMENTS_NEGATIVE_CACHE_TTL_MS
  };
}

export function resetElementsCacheForTests() {
  cache.clear();
  failures.clear();
  inflight.clear();
}
