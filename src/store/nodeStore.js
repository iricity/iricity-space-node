/**
 * Persistence for node objects: signed pass predictions, signed observations and
 * the node's receipt chain.
 *
 * `createNodeStore({ ensureDb, persistDb })` binds the store to any database that
 * implements the interface in ./database.js (sql.js in process, or libSQL shared
 * across processes), so an operated stack can keep these tables in its own
 * database. The default export binds to this package's own SQLite file. Tables are
 * created on first use so they coexist with any existing schema.
 *
 * Chain integrity under concurrency: a unique index allows one receipt per
 * predecessor and one observation envelope per predecessor, so two writers that
 * read the same chain head cannot both extend it. The loser gets a
 * ChainConflictError and re-reads the head (see agent.js). Each object and its
 * receipt are written in one atomic batch, so a receipt never exists without its
 * subject.
 *
 * Every list that feeds a chain orders by `rowid`, the append order.
 */

import * as defaultDb from "./db.js";
import { isUniqueViolation } from "./database.js";

export const NODE_RECEIPT_SUBJECTS = ["pass_prediction", "observation"];

export class ChainConflictError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ChainConflictError";
    this.code = "chain_conflict";
    this.cause = cause;
  }
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

const SCHEMA = `
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
`;

// Added after the first release; older databases gain them on first use.
const MIGRATIONS = ["ALTER TABLE observations ADD COLUMN previous_envelope_hash TEXT"];

// One successor per predecessor. Genesis is stored as '' so it is unique too; rows
// written before this guard have NULL and are left alone.
const CHAIN_GUARDS = [
  "CREATE UNIQUE INDEX IF NOT EXISTS node_receipts_chain_guard ON node_receipts (node_id, COALESCE(previous_hash, ''))",
  "CREATE UNIQUE INDEX IF NOT EXISTS observations_chain_guard ON observations (node_id, previous_envelope_hash) WHERE previous_envelope_hash IS NOT NULL"
];

const PREDICTION_COLUMNS = `prediction_id, node_id, norad_cat_id, elements_epoch, elements_origin, window_start, window_end,
  pass_count, prediction_json, envelope_json, receipt_json, created_at`;
const OBSERVATION_COLUMNS = `observation_id, node_id, source, norad_cat_id, observed_at, payload_profile, payload_hash, envelope_hash, signer,
  record_json, envelope_json, receipt_json, created_at`;
const NODE_RECEIPT_COLUMNS = "receipt_id, node_id, subject_kind, subject_id, record_hash, previous_hash, receipt_hash, issuer, timestamp, receipt_json, created_at, rowid";

function mapPrediction(row) {
  return {
    prediction_id: row[0], node_id: row[1], norad_cat_id: row[2], elements_epoch: row[3], elements_origin: row[4],
    window_start: row[5], window_end: row[6], pass_count: row[7],
    prediction: parseJson(row[8], {}), envelope: parseJson(row[9], {}), receipt: parseJson(row[10], null), created_at: row[11]
  };
}

function mapObservation(row) {
  return {
    observation_id: row[0], node_id: row[1], source: row[2], norad_cat_id: row[3], observed_at: row[4], payload_profile: row[5],
    payload_hash: row[6], envelope_hash: row[7], signer: row[8],
    record: parseJson(row[9], {}), envelope: parseJson(row[10], {}), receipt: parseJson(row[11], null), created_at: row[12]
  };
}

function mapNodeReceipt(row) {
  return {
    receipt_id: row[0], node_id: row[1], subject_kind: row[2], subject_id: row[3], record_hash: row[4], previous_hash: row[5],
    receipt_hash: row[6], issuer: row[7], timestamp: row[8], receipt: parseJson(row[9], null), created_at: row[10], sequence: Number(row[11])
  };
}

function predictionInsert(entry, verb = "INSERT OR REPLACE") {
  return {
    sql: `${verb} INTO pass_predictions (${PREDICTION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      entry.prediction_id, entry.node_id, entry.prediction.norad_cat_id, entry.prediction.elements_epoch, entry.elements_origin,
      entry.prediction.window_start, entry.prediction.window_end, entry.prediction.pass_count,
      JSON.stringify(entry.prediction), JSON.stringify(entry.envelope), entry.receipt ? JSON.stringify(entry.receipt) : null, entry.created_at
    ]
  };
}

function observationInsert(entry) {
  return {
    sql: `INSERT INTO observations (${OBSERVATION_COLUMNS}, previous_envelope_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      entry.observation_id, entry.node_id, entry.source, entry.norad_cat_id ?? null, entry.observed_at ?? null, entry.payload_profile,
      entry.payload_hash, entry.envelope.envelope_hash, entry.envelope.signer,
      JSON.stringify(entry.record), JSON.stringify(entry.envelope), entry.receipt ? JSON.stringify(entry.receipt) : null, entry.created_at,
      entry.envelope.previous_envelope_hash ?? ""
    ]
  };
}

function receiptInsert({ node_id, subject_kind, subject_id, receipt, created_at }) {
  if (!NODE_RECEIPT_SUBJECTS.includes(subject_kind)) throw new TypeError(`unknown node receipt subject: ${subject_kind}`);
  return {
    sql: `INSERT INTO node_receipts (receipt_id, node_id, subject_kind, subject_id, record_hash, previous_hash, receipt_hash, issuer, timestamp, receipt_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [receipt.receipt_id, node_id, subject_kind, subject_id, receipt.record_hash, receipt.previous_hash ?? null, receipt.receipt_hash, receipt.issuer, receipt.timestamp, JSON.stringify(receipt), created_at ?? new Date().toISOString()]
  };
}

/** Bind the node store to a database provider: `{ ensureDb(): Promise<Database>, persistDb(): Promise<void> }`. */
export function createNodeStore({ ensureDb, persistDb }) {
  if (typeof ensureDb !== "function" || typeof persistDb !== "function") throw new TypeError("createNodeStore needs ensureDb and persistDb");
  const prepared = new WeakMap();

  async function dbWithTables() {
    const db = await ensureDb();
    if (!prepared.has(db)) {
      await db.exec(SCHEMA);
      for (const sql of MIGRATIONS) {
        try { await db.exec(sql); } catch { /* column already present */ }
      }
      const guards = [];
      for (const sql of CHAIN_GUARDS) {
        try {
          await db.exec(sql);
          guards.push({ index: sql.split(" ")[6], active: true });
        } catch (error) {
          // An existing fork prevents the index; report it rather than refuse to start.
          guards.push({ index: sql.split(" ")[6], active: false, reason: error?.message || String(error) });
        }
      }
      prepared.set(db, guards);
    }
    return db;
  }

  async function write(statements) {
    const db = await dbWithTables();
    try {
      await db.batch(statements);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Primary-key duplicates (the same object twice) are not chain conflicts.
        const message = String(error?.message || "");
        if (/chain_guard|previous_hash|previous_envelope_hash/i.test(message)) {
          throw new ChainConflictError("another writer extended the chain first", error);
        }
      }
      throw error;
    }
    await persistDb();
  }

  async function chainGuards() {
    const db = await ensureDb();
    await dbWithTables();
    return prepared.get(db) || [];
  }

  async function savePassPrediction(entry) {
    await write([predictionInsert(entry)]);
    return entry;
  }

  /** A stored prediction and its receipt, atomically. */
  async function savePassPredictionWithReceipt(entry, { node_id, created_at }) {
    await write([
      predictionInsert(entry),
      receiptInsert({ node_id, subject_kind: "pass_prediction", subject_id: entry.prediction_id, receipt: entry.receipt, created_at })
    ]);
    return entry;
  }

  async function listPassPredictions(filters = {}) {
    const db = await dbWithTables();
    const where = [];
    const params = [];
    if (filters.node_id) { where.push("node_id = ?"); params.push(String(filters.node_id)); }
    if (filters.norad_cat_id) { where.push("norad_cat_id = ?"); params.push(Number(filters.norad_cat_id)); }
    const limit = clampLimit(filters.limit, 20, 200);
    return (await db.all(`SELECT ${PREDICTION_COLUMNS} FROM pass_predictions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`, params)).map(mapPrediction);
  }

  async function getPassPredictionById(predictionId) {
    const db = await dbWithTables();
    const rows = await db.all(`SELECT ${PREDICTION_COLUMNS} FROM pass_predictions WHERE prediction_id = ? LIMIT 1`, [String(predictionId)]);
    return rows.length ? mapPrediction(rows[0]) : null;
  }

  /**
   * An observation and its receipt, atomically. A repeated observation id is not a
   * chain conflict; the caller checks for it and returns the stored entry.
   */
  async function saveObservationWithReceipt(entry, { node_id, created_at }) {
    await write([
      observationInsert(entry),
      receiptInsert({ node_id, subject_kind: "observation", subject_id: entry.observation_id, receipt: entry.receipt, created_at })
    ]);
    return entry;
  }

  async function saveObservation(entry) {
    await write([observationInsert(entry)]);
    return entry;
  }

  async function listObservations(filters = {}) {
    const db = await dbWithTables();
    const where = [];
    const params = [];
    if (filters.node_id) { where.push("node_id = ?"); params.push(String(filters.node_id)); }
    if (filters.source) { where.push("source = ?"); params.push(String(filters.source)); }
    if (filters.norad_cat_id) { where.push("norad_cat_id = ?"); params.push(Number(filters.norad_cat_id)); }
    const limit = clampLimit(filters.limit, 50, 500);
    return (await db.all(`SELECT ${OBSERVATION_COLUMNS} FROM observations ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`, params)).map(mapObservation);
  }

  async function getObservationById(observationId) {
    const db = await dbWithTables();
    const rows = await db.all(`SELECT ${OBSERVATION_COLUMNS} FROM observations WHERE observation_id = ? LIMIT 1`, [String(observationId)]);
    return rows.length ? mapObservation(rows[0]) : null;
  }

  async function getLatestObservationEnvelopeHash(nodeId) {
    const db = await dbWithTables();
    const rows = await db.all("SELECT envelope_hash FROM observations WHERE node_id = ? ORDER BY rowid DESC LIMIT 1", [String(nodeId)]);
    return rows.length ? rows[0][0] : null;
  }

  async function saveNodeReceipt(args) {
    await write([receiptInsert(args)]);
    return { node_id: args.node_id, subject_kind: args.subject_kind, subject_id: args.subject_id, receipt: args.receipt };
  }

  /** Receipts in chain (append) order, oldest first. */
  async function listNodeReceipts(filters = {}) {
    const db = await dbWithTables();
    const where = [];
    const params = [];
    if (filters.node_id) { where.push("node_id = ?"); params.push(String(filters.node_id)); }
    if (filters.subject_kind) { where.push("subject_kind = ?"); params.push(String(filters.subject_kind)); }
    const limit = clampLimit(filters.limit, 100, 1000);
    return (await db.all(`SELECT ${NODE_RECEIPT_COLUMNS} FROM node_receipts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid ASC LIMIT ${limit}`, params)).map(mapNodeReceipt);
  }

  async function countNodeReceipts(nodeId) {
    const db = await dbWithTables();
    const rows = await db.all("SELECT COUNT(*) FROM node_receipts WHERE node_id = ?", [String(nodeId)]);
    return rows.length ? Number(rows[0][0]) : 0;
  }

  async function getNodeReceiptById(receiptId) {
    const db = await dbWithTables();
    const rows = await db.all(`SELECT ${NODE_RECEIPT_COLUMNS} FROM node_receipts WHERE receipt_id = ? LIMIT 1`, [String(receiptId)]);
    return rows.length ? mapNodeReceipt(rows[0]) : null;
  }

  async function getNodeReceiptByHash(receiptHash) {
    const db = await dbWithTables();
    const rows = await db.all(`SELECT ${NODE_RECEIPT_COLUMNS} FROM node_receipts WHERE receipt_hash = ? LIMIT 1`, [String(receiptHash)]);
    return rows.length ? mapNodeReceipt(rows[0]) : null;
  }

  async function getLatestNodeReceiptHash(nodeId) {
    const db = await dbWithTables();
    const rows = await db.all("SELECT receipt_hash FROM node_receipts WHERE node_id = ? ORDER BY rowid DESC LIMIT 1", [String(nodeId)]);
    return rows.length ? rows[0][0] : null;
  }

  /** The record a node receipt commits to, loaded from the subject table. */
  async function getNodeReceiptSubjectRecord(entry) {
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

  return {
    chainGuards,
    savePassPrediction, savePassPredictionWithReceipt, listPassPredictions, getPassPredictionById,
    saveObservation, saveObservationWithReceipt, listObservations, getObservationById, getLatestObservationEnvelopeHash,
    saveNodeReceipt, listNodeReceipts, countNodeReceipts, getNodeReceiptById, getNodeReceiptByHash, getLatestNodeReceiptHash, getNodeReceiptSubjectRecord
  };
}

const store = createNodeStore(defaultDb);
export const {
  chainGuards,
  savePassPrediction, savePassPredictionWithReceipt, listPassPredictions, getPassPredictionById,
  saveObservation, saveObservationWithReceipt, listObservations, getObservationById, getLatestObservationEnvelopeHash,
  saveNodeReceipt, listNodeReceipts, countNodeReceipts, getNodeReceiptById, getNodeReceiptByHash, getLatestNodeReceiptHash, getNodeReceiptSubjectRecord
} = store;
export { wrapSqlJsDatabase, wrapLibsqlClient, isUniqueViolation } from "./database.js";
