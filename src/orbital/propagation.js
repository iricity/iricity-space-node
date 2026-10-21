/**
 * Orbit propagation and pass prediction.
 *
 * Input is a CCSDS OMM in JSON key-value form (as served by CelesTrak), propagated
 * with SGP4 via satellite.js. Output is geodetic state and predicted passes over an
 * observer, in the pass-prediction.json/1 profile shape.
 *
 * Failures are never silent: input problems raise TypeError (a client error), and
 * elements that cannot be propagated to the requested time raise an error with
 * `status: 422` and the SGP4 error code, instead of returning an empty window.
 */

import * as satellite from "satellite.js";
import { hashPayload } from "@iricity/frontier-shared";

export const PROPAGATOR = "sgp4 (satellite.js 7)";
export const MAX_WINDOW_HOURS = 168;

const OMM_REQUIRED = [
  "EPOCH",
  "MEAN_MOTION",
  "ECCENTRICITY",
  "INCLINATION",
  "RA_OF_ASC_NODE",
  "ARG_OF_PERICENTER",
  "MEAN_ANOMALY",
  "NORAD_CAT_ID"
];

/** SGP4 error codes as documented for the Vallado implementation satellite.js wraps. */
export const SGP4_ERRORS = {
  1: "mean elements out of range (eccentricity >= 1 or < -0.001, or semi-major axis < 0.95 earth radii)",
  2: "mean motion is not positive",
  3: "perturbed elements out of range (eccentricity < 0 or > 1)",
  4: "semi-latus rectum is negative",
  5: "epoch elements are sub-orbital",
  6: "satellite has decayed"
};

function propagationError(code, at) {
  const reason = SGP4_ERRORS[code] ?? `SGP4 error ${code}`;
  const error = new Error(`elements cannot be propagated${at ? ` to ${at.toISOString()}` : ""}: ${reason} (sgp4 error ${code})`);
  error.status = 422;
  error.code = "propagation_failed";
  error.sgp4_error = code;
  return error;
}

export function assertOmm(omm) {
  if (!omm || typeof omm !== "object" || Array.isArray(omm)) throw new TypeError("OMM payload must be an object");
  const missing = OMM_REQUIRED.filter((key) => !(key in omm));
  if (missing.length) throw new TypeError(`OMM payload missing: ${missing.join(", ")}`);
  return omm;
}

const ZONE_SUFFIX = /([zZ]|[+-]\d{2}(:?\d{2})?)$/;
const BARE_INSTANT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?)?$/;

/**
 * Parse an instant. ISO-8601 strings without a zone designator are read as UTC,
 * never as the server's local time. Anything unparseable is a TypeError.
 */
export function parseInstant(value, label = "start") {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`${label} must be a valid date`);
    return new Date(value.getTime());
  }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be an ISO-8601 date-time`);
  const text = value.trim();
  const normalized = ZONE_SUFFIX.test(text) ? text : BARE_INSTANT.test(text) ? `${text}${text.includes("T") ? "" : "T00:00:00"}Z` : text;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} must be an ISO-8601 date-time`);
  return date;
}

export function ommEpochIso(omm) {
  return parseInstant(String(omm.EPOCH), "OMM EPOCH").toISOString();
}

export function satrecFromOmm(omm) {
  assertOmm(omm);
  let satrec;
  try {
    satrec = satellite.json2satrec(omm);
  } catch (error) {
    throw new TypeError(`OMM payload could not be initialised: ${error.message}`);
  }
  if (!satrec) throw new TypeError("OMM payload could not be initialised");
  if (satrec.error) throw propagationError(satrec.error, null);
  return satrec;
}

function toRadiansObserver(observer) {
  return {
    latitude: satellite.degreesToRadians(Number(observer.latitude)),
    longitude: satellite.degreesToRadians(Number(observer.longitude)),
    height: Number(observer.altitude_m ?? 0) / 1000
  };
}

export function assertObserver(observer) {
  const latitude = Number(observer?.latitude);
  const longitude = Number(observer?.longitude);
  const altitude = Number(observer?.altitude_m ?? 0);
  if (!observer || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new TypeError("observer needs numeric latitude and longitude");
  }
  if (latitude < -90 || latitude > 90) throw new TypeError("observer latitude must be between -90 and 90");
  if (longitude < -180 || longitude > 180) throw new TypeError("observer longitude must be between -180 and 180");
  if (!Number.isFinite(altitude) || altitude < -500 || altitude > 100000) throw new TypeError("observer altitude_m must be between -500 and 100000");
  return { latitude, longitude, altitude_m: altitude };
}

export function assertWindowHours(hours, fallback = 24, max = MAX_WINDOW_HOURS) {
  if (hours === undefined || hours === null || hours === "") return Math.min(fallback, max);
  const value = Number(hours);
  if (!Number.isFinite(value) || value <= 0) throw new TypeError("hours must be a positive number");
  return Math.min(value, max);
}

function normalizeAzimuth(deg) {
  const value = deg % 360;
  return value < 0 ? value + 360 : value;
}

/** Position of the satellite at `date`: ECI, geodetic, and look angles from an optional observer. */
export function propagateState(omm, date = new Date(), observer = null) {
  const at = parseInstant(date, "at");
  const satrec = satrecFromOmm(omm);
  const site = observer ? assertObserver(observer) : null;
  const pv = satellite.propagate(satrec, at);
  if (!pv || !pv.position || typeof pv.position !== "object") {
    throw propagationError(satrec.error, at);
  }

  const gmst = satellite.gstime(at);
  const geodetic = satellite.eciToGeodetic(pv.position, gmst);
  const state = {
    norad_cat_id: Number(omm.NORAD_CAT_ID),
    object_name: omm.OBJECT_NAME ?? null,
    at: at.toISOString(),
    elements_epoch: ommEpochIso(omm),
    propagator: PROPAGATOR,
    position_eci_km: { x: pv.position.x, y: pv.position.y, z: pv.position.z },
    velocity_eci_km_s: { x: pv.velocity.x, y: pv.velocity.y, z: pv.velocity.z },
    geodetic: {
      latitude_deg: satellite.degreesLat(geodetic.latitude),
      longitude_deg: satellite.degreesLong(geodetic.longitude),
      altitude_km: geodetic.height
    }
  };

  if (site) {
    const look = satellite.ecfToLookAngles(toRadiansObserver(site), satellite.eciToEcf(pv.position, gmst));
    state.look_angles = {
      azimuth_deg: normalizeAzimuth(satellite.radiansToDegrees(look.azimuth)),
      elevation_deg: satellite.radiansToDegrees(look.elevation),
      range_km: look.rangeSat
    };
  }

  return state;
}

function lookAt(satrec, observerRad, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv || !pv.position || typeof pv.position !== "object") return null;
  const gmst = satellite.gstime(date);
  const look = satellite.ecfToLookAngles(observerRad, satellite.eciToEcf(pv.position, gmst));
  return {
    elevation: satellite.radiansToDegrees(look.elevation),
    azimuth: normalizeAzimuth(satellite.radiansToDegrees(look.azimuth)),
    range: look.rangeSat
  };
}

/** Bisect a crossing of `threshold` between two instants, to ~1 second. */
function refineCrossing(satrec, observerRad, before, after, threshold, rising) {
  let lo = before;
  let hi = after;
  for (let i = 0; i < 24 && hi - lo > 1000; i += 1) {
    const mid = new Date((lo.getTime() + hi.getTime()) / 2);
    const look = lookAt(satrec, observerRad, mid);
    if (!look) break;
    const above = look.elevation >= threshold;
    if (above === rising) hi = mid;
    else lo = mid;
  }
  return rising ? hi : lo;
}

/**
 * Predict passes of the object described by `omm` over `observer`.
 * @param {object} args
 * @param {object} args.omm
 * @param {{latitude:number, longitude:number, altitude_m?:number}} args.observer
 * @param {Date|string} [args.start]            default now; zone-less strings are UTC
 * @param {number} [args.hours]                 search window, default 24, max 168
 * @param {number} [args.min_elevation_deg]     default 10
 * @param {number} [args.step_seconds]          coarse step, default 30
 * @param {string|null} [args.observer_id]
 */
export function predictPasses({
  omm,
  observer,
  start = new Date(),
  hours = 24,
  min_elevation_deg = 10,
  step_seconds = 30,
  observer_id = null
}) {
  assertOmm(omm);
  const site = assertObserver(observer);
  const windowHours = assertWindowHours(hours);
  const threshold = Math.min(Math.max(Number(min_elevation_deg) || 0, 0), 89);
  const stepMs = Math.min(Math.max(Number(step_seconds) || 30, 5), 300) * 1000;
  const startDate = parseInstant(start, "start");
  const endDate = new Date(startDate.getTime() + windowHours * 3600 * 1000);

  const satrec = satrecFromOmm(omm);
  const observerRad = toRadiansObserver(site);
  const elementsHash = hashPayload(omm);
  const elementsEpoch = ommEpochIso(omm);
  const passes = [];

  let previous = null;
  let previousDate = null;
  let current = null;
  let propagationFailure = null;

  for (let t = startDate.getTime(); t <= endDate.getTime(); t += stepMs) {
    const date = new Date(t);
    const look = lookAt(satrec, observerRad, date);
    if (!look) {
      // The elements stop being usable inside the window (typically decay). The
      // first step failing means nothing can be said; later it truncates the window.
      if (t === startDate.getTime()) throw propagationError(satrec.error, date);
      propagationFailure = { sgp4_error: satrec.error, reason: SGP4_ERRORS[satrec.error] ?? `SGP4 error ${satrec.error}`, at: date.toISOString() };
      break;
    }
    const above = look.elevation >= threshold;

    if (above && !current) {
      const startedAboveThreshold = !previous;
      const aos = previous && previous.elevation < threshold
        ? refineCrossing(satrec, observerRad, previousDate, date, threshold, true)
        : date;
      const aosLook = lookAt(satrec, observerRad, aos) ?? look;
      current = { aos, aosLook, max: { date, look }, startedAboveThreshold };
    }

    if (above && current && look.elevation > current.max.look.elevation) {
      current.max = { date, look };
    }

    if (!above && current) {
      const los = refineCrossing(satrec, observerRad, previousDate, date, threshold, false);
      const losLook = lookAt(satrec, observerRad, los) ?? previous;
      passes.push(buildPass(current, los, losLook));
      current = null;
    }

    previous = look;
    previousDate = date;
  }

  if (current) {
    // Pass still in progress at the end of the window: report it truncated.
    const losLook = previous;
    passes.push({ ...buildPass(current, previousDate, losLook), truncated_at_window_end: true });
  }

  const enriched = passes.map((pass) => ({
    norad_cat_id: Number(omm.NORAD_CAT_ID),
    object_name: omm.OBJECT_NAME ?? null,
    object_id: omm.OBJECT_ID ?? null,
    observer_id,
    observer: site,
    ...pass,
    min_elevation_deg: threshold,
    elements_epoch: elementsEpoch,
    elements_hash: elementsHash,
    propagator: PROPAGATOR
  }));

  return {
    norad_cat_id: Number(omm.NORAD_CAT_ID),
    object_name: omm.OBJECT_NAME ?? null,
    observer_id,
    observer: site,
    window_start: startDate.toISOString(),
    window_end: endDate.toISOString(),
    min_elevation_deg: threshold,
    step_seconds: stepMs / 1000,
    elements_epoch: elementsEpoch,
    elements_hash: elementsHash,
    elements_age_hours: Number(((startDate.getTime() - new Date(elementsEpoch).getTime()) / 3600000).toFixed(2)),
    propagator: PROPAGATOR,
    pass_count: enriched.length,
    passes: enriched,
    ...(propagationFailure ? { truncated_by_propagation_error: true, propagation_error: propagationFailure } : {})
  };
}

function buildPass(current, los, losLook) {
  const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
  return {
    aos: current.aos.toISOString(),
    tca: current.max.date.toISOString(),
    los: los.toISOString(),
    duration_seconds: round((los.getTime() - current.aos.getTime()) / 1000, 0),
    max_elevation_deg: round(current.max.look.elevation),
    aos_azimuth_deg: round(current.aosLook.azimuth),
    tca_azimuth_deg: round(current.max.look.azimuth),
    los_azimuth_deg: round(losLook?.azimuth ?? current.max.look.azimuth),
    tca_range_km: round(current.max.look.range, 1),
    ...(current.startedAboveThreshold ? { truncated_at_window_start: true } : {})
  };
}

/** The next pass at or after `from`, or null. Convenience for the comm-window planner. */
export function nextPass(args) {
  const prediction = predictPasses({ hours: 48, ...args });
  return prediction.passes[0] ?? null;
}
