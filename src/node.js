/**
 * The node's self-description: who operates it, where it is, under which
 * jurisdiction. Read once from the manifest file, with environment overrides, and
 * validated so a node never publishes a site it cannot express.
 */

import fs from "node:fs";
import path from "node:path";
import {
  NODE_ID,
  NODE_JURISDICTION,
  NODE_MANIFEST_PATH,
  NODE_NAME,
  NODE_OPERATOR,
  NODE_SITE_ALTITUDE_M,
  NODE_SITE_LATITUDE,
  NODE_SITE_LONGITUDE
} from "./config.js";

let cached = null;

function readManifest() {
  const file = path.resolve(NODE_MANIFEST_PATH);
  if (!fs.existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`node manifest ${file} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`node manifest ${file} must be a JSON object`);
  return parsed;
}

function siteFrom(manifest) {
  const latitude = NODE_SITE_LATITUDE !== "" ? Number(NODE_SITE_LATITUDE) : manifest.site?.latitude;
  const longitude = NODE_SITE_LONGITUDE !== "" ? Number(NODE_SITE_LONGITUDE) : manifest.site?.longitude;
  const altitude = NODE_SITE_ALTITUDE_M !== "" ? Number(NODE_SITE_ALTITUDE_M) : manifest.site?.altitude_m ?? 0;
  if (latitude === undefined && longitude === undefined) return null;
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) throw new Error("node site needs numeric latitude and longitude");
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error("node site latitude or longitude out of range");
  return { latitude: Number(latitude), longitude: Number(longitude), altitude_m: Number.isFinite(Number(altitude)) ? Number(altitude) : 0 };
}

/** @returns {{node_id: string, name: string, operator: string, jurisdiction: string, site: object|null, created_at: string, source: string}} */
export function getNodeDescription() {
  if (cached) return cached;
  const manifest = readManifest();
  const nodeId = NODE_ID || manifest.node_id || "node_local";
  if (!/^[a-z0-9][a-z0-9_\-]{1,63}$/i.test(nodeId)) throw new Error("node_id must be 2-64 characters of letters, digits, _ or -");
  const jurisdiction = (NODE_JURISDICTION || manifest.jurisdiction || "").toUpperCase();
  if (jurisdiction && !/^[A-Z]{2}$/.test(jurisdiction)) throw new Error("jurisdiction must be an ISO 3166-1 alpha-2 code");
  cached = {
    node_id: nodeId,
    name: NODE_NAME || manifest.name || nodeId,
    operator: NODE_OPERATOR || manifest.operator || nodeId,
    jurisdiction: jurisdiction || null,
    site: siteFrom(manifest),
    created_at: manifest.created_at || "2026-01-01T00:00:00.000Z",
    source: fs.existsSync(path.resolve(NODE_MANIFEST_PATH)) ? path.resolve(NODE_MANIFEST_PATH) : "environment"
  };
  return cached;
}

export function resetNodeDescriptionForTests() {
  cached = null;
}
