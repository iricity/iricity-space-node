/** Runtime configuration. Every value has a default that works for a local trial. */

const env = process.env;

function number(name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export const NODE_ENV = String(env.NODE_ENV || "development").toLowerCase();
export const IS_PRODUCTION = NODE_ENV === "production";

export const NODE_MANIFEST_PATH = env.NODE_MANIFEST_PATH || "node.json";
export const NODE_ID = env.NODE_ID || "";
export const NODE_NAME = env.NODE_NAME || "";
export const NODE_OPERATOR = env.NODE_OPERATOR || "";
export const NODE_JURISDICTION = env.NODE_JURISDICTION || "";
export const NODE_SITE_LATITUDE = env.NODE_SITE_LATITUDE ?? "";
export const NODE_SITE_LONGITUDE = env.NODE_SITE_LONGITUDE ?? "";
export const NODE_SITE_ALTITUDE_M = env.NODE_SITE_ALTITUDE_M ?? "";

export const NODE_SIGNING_PRIVATE_KEY = env.NODE_SIGNING_PRIVATE_KEY || "";
export const NODE_SIGNING_KEY_LABEL = env.NODE_SIGNING_KEY_LABEL || "node_key_v1";
export const NODE_OPERATOR_KEY = env.NODE_OPERATOR_KEY || "";

export const NODE_DATA_DIR = env.NODE_DATA_DIR || "data";
export const PORT = number("PORT", 3100);
export const HOST = env.HOST || "0.0.0.0";

export const CELESTRAK_GP_BASE_URL = env.CELESTRAK_GP_BASE_URL || "https://celestrak.org/NORAD/elements/gp.php";
export const SATNOGS_API_BASE_URL = env.SATNOGS_API_BASE_URL || "https://network.satnogs.org/api";
export const CONNECTOR_TIMEOUT_MS = number("CONNECTOR_TIMEOUT_MS", 8000);
export const ELEMENTS_CACHE_TTL_MS = number("ELEMENTS_CACHE_TTL_MS", 3600000);
export const ELEMENTS_NEGATIVE_CACHE_TTL_MS = number("ELEMENTS_NEGATIVE_CACHE_TTL_MS", 300000);
export const DEFAULT_NORAD_CAT_ID = number("DEFAULT_NORAD_CAT_ID", 25544);

export const PUBLIC_RATE_LIMIT_WINDOW_MS = number("PUBLIC_RATE_LIMIT_WINDOW_MS", 60000);
export const PUBLIC_RATE_LIMIT_MAX_REQUESTS = number("PUBLIC_RATE_LIMIT_MAX_REQUESTS", 30);

export const PUBLIC_PASS_WINDOW_MAX_HOURS = 48;
export const OPERATOR_PASS_WINDOW_MAX_HOURS = 168;
