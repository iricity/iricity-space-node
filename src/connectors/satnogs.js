/**
 * SatNOGS Network connector (read-only).
 *
 * Pulls observations from the public SatNOGS Network API and returns them unchanged
 * so they can be wrapped under the satnogs.observation.json/1 profile. Scheduling
 * stays with SatNOGS; this node only ingests and signs what the network publishes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_NORAD_CAT_ID, SATNOGS_API_BASE_URL } from "../config.js";
import { clampTimeoutMs, parseNoradId } from "./celestrak.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");

export const MAX_OBSERVATIONS_PER_FETCH = 50;
export const MAX_DEMODDATA_PER_OBSERVATION = 25;

function loadFixture(noradId) {
  const specific = path.join(fixturesDir, `satnogs-observations-${noradId}.json`);
  const generic = path.join(fixturesDir, "satnogs-observations-25544.json");
  const file = fs.existsSync(specific) ? specific : generic;
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(parsed) ? parsed : [];
}

function trim(observation) {
  // Keep the object as SatNOGS published it; only bound the demod list so a single
  // observation cannot carry hundreds of URLs into every envelope. The truncation
  // is recorded on the object, so the signed value says it is not the full list.
  if (Array.isArray(observation?.demoddata) && observation.demoddata.length > MAX_DEMODDATA_PER_OBSERVATION) {
    return {
      ...observation,
      demoddata: observation.demoddata.slice(0, MAX_DEMODDATA_PER_OBSERVATION),
      demoddata_truncated: true,
      demoddata_total: observation.demoddata.length
    };
  }
  return observation;
}

function matchesFilter(observation, noradId) {
  return noradId === null || Number(observation?.norad_cat_id) === noradId;
}

function fixtureResult(noradId, limit, url, note) {
  return {
    source: "satnogs",
    event_type: "ground_observation",
    payload: {
      payload_profile: "satnogs.observation.json/1",
      observations: loadFixture(noradId ?? DEFAULT_NORAD_CAT_ID).filter((o) => matchesFilter(o, noradId)).slice(0, limit).map(trim),
      observations_origin: "fixture",
      requested_norad_cat_id: noradId,
      ...(note ? { note } : {}),
      fetched_at: new Date().toISOString(),
      source_url: url
    }
  };
}

/**
 * Fetch observations.
 * @param {object} options
 * @param {number} [options.norad_id]         when set, only observations of this object are returned
 * @param {number} [options.ground_station]
 * @param {string} [options.status]           e.g. good, bad, failed, future
 * @param {number} [options.limit]            default 10, max 50
 * @param {number} [options.timeout_ms]       clamped to 1-30 s
 * @param {boolean} [options.fixture]         force the bundled fixture
 */
export async function fetchSatnogsObservations(options = {}) {
  const noradId = options.norad_id === null ? null : parseNoradId(options.norad_id ?? options.norad_cat_id);
  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), MAX_OBSERVATIONS_PER_FETCH);
  const params = new URLSearchParams({ format: "json" });
  if (noradId !== null) params.set("norad_cat_id", String(noradId));
  if (options.ground_station !== undefined && options.ground_station !== null) {
    const station = Number(options.ground_station);
    if (!Number.isInteger(station) || station <= 0) throw new TypeError("ground_station must be a positive integer");
    params.set("ground_station", String(station));
  }
  if (options.status !== undefined && options.status !== null) {
    const status = String(options.status);
    if (!/^[a-z_]{1,32}$/.test(status)) throw new TypeError("status must be a SatNOGS status word");
    params.set("status", status);
  }
  const url = `${SATNOGS_API_BASE_URL}/observations/?${params.toString()}`;

  if (options.fixture) return fixtureResult(noradId, limit, null, null);

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(clampTimeoutMs(options.timeout_ms))
    });
    if (!response.ok) throw new Error(`SatNOGS returned ${response.status}`);
    const body = await response.json();
    const list = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : [];
    // The upstream filter is applied again here. If SatNOGS ignored it, the answer
    // is the matching subset (possibly empty), never an unrelated list.
    const filtered = list.filter((observation) => matchesFilter(observation, noradId));
    return {
      source: "satnogs",
      event_type: "ground_observation",
      payload: {
        payload_profile: "satnogs.observation.json/1",
        observations: filtered.slice(0, limit).map(trim),
        observations_origin: "live",
        requested_norad_cat_id: noradId,
        filter_applied_upstream: filtered.length === list.length,
        filtered_out_count: list.length - filtered.length,
        fetched_at: new Date().toISOString(),
        source_url: url
      }
    };
  } catch (error) {
    return fixtureResult(noradId, limit, url, `live fetch failed (${error.message}); using bundled observations`);
  }
}
