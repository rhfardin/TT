// node:sqlite adapter for src/core/store.js (Node server and tests).
import { DatabaseSync } from 'node:sqlite';

export function openSqlite(file) {
  const sqlite = new DatabaseSync(file);
  if (file !== ':memory:') sqlite.exec('PRAGMA journal_mode = WAL');
  return {
    sqlite,
    all: async (sql, ...args) => sqlite.prepare(sql).all(...args),
    get: async (sql, ...args) => sqlite.prepare(sql).get(...args) ?? null,
    run: async (sql, ...args) => {
      const r = sqlite.prepare(sql).run(...args);
      return { lastId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    // One transaction, so a big import doesn't commit row by row.
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        for (const [sql, ...args] of statements) sqlite.prepare(sql).run(...args);
        sqlite.exec('COMMIT');
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
