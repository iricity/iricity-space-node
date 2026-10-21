/**
 * One SQLite file under NODE_DATA_DIR, through sql.js (no native build). The whole
 * database is written back after every change; node volumes are small (receipts,
 * observations, stored predictions) and this keeps the store portable.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { NODE_DATA_DIR } from "../config.js";

const require = createRequire(import.meta.url);
let sqlModulePromise = null;
let dbPromise = null;

export function dbPath() {
  return path.resolve(NODE_DATA_DIR, "node.sqlite");
}

async function sqlModule() {
  if (!sqlModulePromise) {
    sqlModulePromise = initSqlJs({ locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm") });
  }
  return sqlModulePromise;
}

export async function ensureDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const SQL = await sqlModule();
      const file = dbPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const db = fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database();
      return db;
    })();
  }
  return dbPromise;
}

export async function persistDb() {
  const db = await ensureDb();
  const file = dbPath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, file);
}

export async function resetDbForTests() {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  const file = dbPath();
  for (const candidate of [file, `${file}.tmp`]) {
    if (fs.existsSync(candidate)) fs.rmSync(candidate);
  }
}
