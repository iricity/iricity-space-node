import { ensureDb, persistDb } from "./db.js";

/**
 * Persistence for node-agent objects: signed pass predictions, signed observations
 * and the node's own receipt chain. Tables are created on first use so they coexist
 * with the existing schema and with test resets that recreate the database file.
 *
 * Node receipts are `state-receipt/1` records and live in their own table and their
 * own chain. They are never mixed into the application receipts table, whose rows
 * use a different hash scheme and verifier.
 *
 * Ordering: every list that feeds a chain orders by `rowid`, the append order, so
 * two rows written in the same millisecond cannot swap places.
 */

function getRows(db, sql, params = []) {
  const stmt = db.prepare(sql, params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.get());
  stmt.free();
  return rows;
}

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function clampLimit(value, fallback, max) {
  return Math.min(Math.max(Number(value) || fallback, 1), max);
}

async function dbWithTables() {
  const db = await ensureDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS pass_predictions (
      prediction_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      norad_cat_id INTEGER NOT NULL,
      elements_epoch TEXT,
      elements_origin TEXT,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      pass_count INTEGER NOT NULL,
      prediction_json TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      receipt_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS observations (
      observation_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      source TEXT NOT NULL,
      norad_cat_id INTEGER,
      observed_at TEXT,
      payload_profile TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      envelope_hash TEXT NOT NULL,
      signer TEXT NOT NULL,
      record_json TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      receipt_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS node_receipts (
      receipt_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      record_hash TEXT NOT NULL,
      previous_hash TEXT,
      receipt_hash TEXT NOT NULL,
      issuer TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS node_receipts_node_idx ON node_receipts (node_id);
    CREATE INDEX IF NOT EXISTS node_receipts_hash_idx ON node_receipts (receipt_hash);
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Pass predictions
// ---------------------------------------------------------------------------

export async function savePassPrediction(entry) {
  const db = await dbWithTables();
  db.run(
    `INSERT OR REPLACE INTO pass_predictions (
      prediction_id, node_id, norad_cat_id, elements_epoch, elements_origin, window_start, window_end,
      pass_count, prediction_json, envelope_json, receipt_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.prediction_id,
      entry.node_id,
      entry.prediction.norad_cat_id,
      entry.prediction.elements_epoch,
      entry.elements_origin,
      entry.prediction.window_start,
      entry.prediction.window_end,
      entry.prediction.pass_count,
      JSON.stringify(entry.prediction),
      JSON.stringify(entry.envelope),
      entry.receipt ? JSON.stringify(entry.receipt) : null,
      entry.created_at
    ]
  );
  await persistDb();
  return entry;
}

function mapPrediction(row) {
  return {
    prediction_id: row[0],
    node_id: row[1],
    norad_cat_id: row[2],
    elements_epoch: row[3],
    elements_origin: row[4],
    window_start: row[5],
    window_end: row[6],
    pass_count: row[7],
    prediction: parseJson(row[8], {}),
    envelope: parseJson(row[9], {}),
    receipt: parseJson(row[10], null),
    created_at: row[11]
  };
}

const PREDICTION_COLUMNS = `prediction_id, node_id, norad_cat_id, elements_epoch, elements_origin, window_start, window_end,
  pass_count, prediction_json, envelope_json, receipt_json, created_at`;

export async function listPassPredictions(filters = {}) {
  const db = await dbWithTables();
  const where = [];
  const params = [];
  if (filters.node_id) { where.push("node_id = ?"); params.push(String(filters.node_id)); }
  if (filters.norad_cat_id) { where.push("norad_cat_id = ?"); params.push(Number(filters.norad_cat_id)); }
  const limit = clampLimit(filters.limit, 20, 200);
  const rows = getRows(
    db,
    `SELECT ${PREDICTION_COLUMNS} FROM pass_predictions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`,
    params
  );
  return rows.map(mapPrediction);
}

export async function getPassPredictionById(predictionId) {
  const db = await dbWithTables();
  const rows = getRows(db, `SELECT ${PREDICTION_COLUMNS} FROM pass_predictions WHERE prediction_id = ? LIMIT 1`, [String(predictionId)]);
  return rows.length ? mapPrediction(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export async function saveObservation(entry) {
  const db = await dbWithTables();
  // Plain INSERT: an observation id is derived from its content, and a repeat is
  // answered with the stored entry by the agent, never by rewriting the row (which
  // would orphan every envelope chained to the original).
  db.run(
    `INSERT INTO observations (
      observation_id, node_id, source, norad_cat_id, observed_at, payload_profile, payload_hash, envelope_hash, signer,
      record_json, envelope_json, receipt_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.observation_id,
      entry.node_id,
      entry.source,
      entry.norad_cat_id ?? null,
      entry.observed_at ?? null,
      entry.payload_profile,
      entry.payload_hash,
      entry.envelope.envelope_hash,
      entry.envelope.signer,
      JSON.stringify(entry.record),
      JSON.stringify(entry.envelope),
      entry.receipt ? JSON.stringify(entry.receipt) : null,
      entry.created_at
    ]
  );
  await persistDb();
  return entry;
}

function mapObservation(row) {
  return {
    observation_id: row[0],
    node_id: row[1],
    source: row[2],
    norad_cat_id: row[3],
    observed_at: row[4],
    payload_profile: row[5],
    payload_hash: row[6],
    envelope_hash: row[7],
    signer: row[8],
    record: parseJson(row[9], {}),
    envelope: parseJson(row[10], {}),
    receipt: parseJson(row[11], null),
    created_at: row[12]
  };
}

const OBSERVATION_COLUMNS = `observation_id, node_id, source, norad_cat_id, observed_at, payload_profile, payload_hash, envelope_hash, signer,
  record_json, envelope_json, receipt_json, created_at`;

export async function listObservations(filters = {}) {
  const db = await dbWithTables();
  const where = [];
  const params = [];
  if (filters.node_id) { where.push("node_id = ?"); params.push(String(filters.node_id)); }
  if (filters.source) { where.push("source = ?"); params.push(String(filters.source)); }
  if (filters.norad_cat_id) { where.push("norad_cat_id = ?"); params.push(Number(filters.norad_cat_id)); }
  const limit = clampLimit(filters.limit, 50, 500);
  const rows = getRows(
    db,
    `SELECT ${OBSERVATION_COLUMNS} FROM observations ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`,
    params
  );
  return rows.map(mapObservation);
}

export async function getObservationById(observationId) {
  const db = await dbWithTables();
  const rows = getRows(db, `SELECT ${OBSERVATION_COLUMNS} FROM observations WHERE observation_id = ? LIMIT 1`, [String(observationId)]);
  return rows.length ? mapObservation(rows[0]) : null;
}

export async function getLatestObservationEnvelopeHash(nodeId) {
  const db = await dbWithTables();
  const rows = getRows(db, `SELECT envelope_hash FROM observations WHERE node_id = ? ORDER BY rowid DESC LIMIT 1`, [String(nodeId)]);
  return rows.length ? rows[0][0] : null;
}

// ---------------------------------------------------------------------------
// Node receipt chain
// ---------------------------------------------------------------------------

export const NODE_RECEIPT_SUBJECTS = ["pass_prediction", "observation"];

export async function saveNodeReceipt({ node_id, subject_kind, subject_id, receipt, created_at }) {
  if (!NODE_RECEIPT_SUBJECTS.includes(subject_kind)) throw new TypeError(`unknown node receipt subject: ${subject_kind}`);
  const db = await dbWithTables();
  db.run(
    `INSERT INTO node_receipts (
      receipt_id, node_id, subject_kind, subject_id, record_hash, previous_hash, receipt_hash, issuer, timestamp, receipt_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      receipt.receipt_id,
      node_id,
      subject_kind,
      subject_id,
      receipt.record_hash,
      receipt.previous_hash ?? null,
      receipt.receipt_hash,
      receipt.issuer,
      receipt.timestamp,
      JSON.stringify(receipt),
      created_at ?? new Date().toISOString()
    ]
  );
  await persistDb();
  return { node_id, subject_kind, subject_id, receipt };
}

function mapNodeReceipt(row) {
  return {
    receipt_id: row[0],
    node_id: row[1],
    subject_kind: row[2],
    subject_id: row[3],
    record_hash: row[4],
    previous_hash: row[5],
    receipt_hash: row[6],
    issuer: row[7],
    timestamp: row[8],
    receipt: parseJson(row[9], null),
    created_at: row[10],
    sequence: row[11]
  };
}

const NODE_RECEIPT_COLUMNS = "receipt_id, node_id, subject_kind, subject_id, record_hash, previous_hash, receipt_hash, issuer, timestamp, receipt_json, created_at, rowid";

/** Receipts in chain (append) order, oldest first. */
export async function listNodeReceipts(filters = {}) {
  const db = await dbWithTables();
  const where = [];
  const params = [];
  if (filters.node_id) { where.push("node_id = ?"); params.push(String(filters.node_id)); }
  if (filters.subject_kind) { where.push("subject_kind = ?"); params.push(String(filters.subject_kind)); }
  const limit = clampLimit(filters.limit, 100, 1000);
  const rows = getRows(
    db,
    `SELECT ${NODE_RECEIPT_COLUMNS} FROM node_receipts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid ASC LIMIT ${limit}`,
    params
  );
  return rows.map(mapNodeReceipt);
}

export async function countNodeReceipts(nodeId) {
  const db = await dbWithTables();
  const rows = getRows(db, "SELECT COUNT(*) FROM node_receipts WHERE node_id = ?", [String(nodeId)]);
  return rows.length ? Number(rows[0][0]) : 0;
}

export async function getNodeReceiptById(receiptId) {
  const db = await dbWithTables();
  const rows = getRows(db, `SELECT ${NODE_RECEIPT_COLUMNS} FROM node_receipts WHERE receipt_id = ? LIMIT 1`, [String(receiptId)]);
  return rows.length ? mapNodeReceipt(rows[0]) : null;
}

export async function getNodeReceiptByHash(receiptHash) {
  const db = await dbWithTables();
  const rows = getRows(db, `SELECT ${NODE_RECEIPT_COLUMNS} FROM node_receipts WHERE receipt_hash = ? LIMIT 1`, [String(receiptHash)]);
  return rows.length ? mapNodeReceipt(rows[0]) : null;
}

export async function getLatestNodeReceiptHash(nodeId) {
  const db = await dbWithTables();
  const rows = getRows(db, "SELECT receipt_hash FROM node_receipts WHERE node_id = ? ORDER BY rowid DESC LIMIT 1", [String(nodeId)]);
  return rows.length ? rows[0][0] : null;
}

/** The record a node receipt commits to, loaded from the subject table. */
export async function getNodeReceiptSubjectRecord(entry) {
  if (!entry) return null;
  if (entry.subject_kind === "observation") {
    const observation = await getObservationById(entry.subject_id);
    return observation ? observation.record : null;
  }
  if (entry.subject_kind === "pass_prediction") {
    const prediction = await getPassPredictionById(entry.subject_id);
    return prediction ? prediction.prediction : null;
  }
  return null;
}
