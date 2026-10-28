/**
 * The database interface every store uses, with one adapter per engine.
 *
 *   all(sql, params)     -> Promise<Array<Array>>   rows as positional arrays
 *   run(sql, params)     -> Promise<{ changes }>
 *   exec(sql)            -> Promise<void>           one or more statements, no params
 *   batch(statements)    -> Promise<void>           [{ sql, params }], atomic: all or none
 *   kind                 -> "sqljs" | "libsql"
 *
 * sql.js runs in process (local nodes, tests). libSQL (a hosted SQLite such as Turso,
 * or a local file) is shared across processes, which is what makes writes from
 * concurrent serverless instances safe. Both speak SQLite, so the SQL is the same.
 */

export function isUniqueViolation(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`;
  return /SQLITE_CONSTRAINT|UNIQUE constraint failed|PRIMARYKEY|PRIMARY KEY/i.test(text);
}

/** Wrap a sql.js Database. */
export function wrapSqlJsDatabase(db) {
  function all(sql, params = []) {
    const stmt = db.prepare(sql, params);
    const rows = [];
    try {
      while (stmt.step()) rows.push(stmt.get());
    } finally {
      stmt.free();
    }
    return rows;
  }
  return {
    kind: "sqljs",
    raw: db,
    async all(sql, params = []) {
      return all(sql, params);
    },
    async run(sql, params = []) {
      db.run(sql, params);
      return { changes: db.getRowsModified() };
    },
    async exec(sql) {
      db.exec(sql);
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        for (const { sql, params = [] } of statements) db.run(sql, params);
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw error;
      }
    },
    export() {
      return db.export();
    },
    close() {
      db.close();
    }
  };
}

/** Wrap a @libsql/client Client. */
export function wrapLibsqlClient(client) {
  const toArrays = (result) => result.rows.map((row) => Array.from({ length: result.columns.length }, (_, i) => row[i]));
  return {
    kind: "libsql",
    raw: client,
    async all(sql, params = []) {
      return toArrays(await client.execute({ sql, args: params }));
    },
    async run(sql, params = []) {
      const result = await client.execute({ sql, args: params });
      return { changes: result.rowsAffected };
    },
    async exec(sql) {
      await client.executeMultiple(sql);
    },
    async batch(statements) {
      await client.batch(statements.map(({ sql, params = [] }) => ({ sql, args: params })), "write");
    },
    close() {
      client.close();
    }
  };
}
