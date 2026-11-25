import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const cloneRow = (row) => (row && typeof row === 'object' ? { ...row } : null);

export async function openDatabase(filePath) {
  return openDatabaseSync(filePath);
}

export function openDatabaseSync(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('SQLite database filePath is required.');
  }
  if (filePath !== ':memory:') {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const runtime = typeof Bun !== 'undefined' ? 'bun' : 'node';
  const Database = runtime === 'bun' ? require('bun:sqlite').Database : require('node:sqlite').DatabaseSync;
  const raw = runtime === 'bun' ? new Database(filePath, { create: true }) : new Database(filePath);

  let txDepth = 0;

  const runStmt = (sql, method, params) => {
    const stmt = raw.prepare(sql);
    try {
      return stmt[method](...params);
    } finally {
      if (runtime === 'bun' && typeof stmt.finalize === 'function') stmt.finalize();
    }
  };

  raw.exec('PRAGMA busy_timeout = 5000;');
  raw.exec('PRAGMA foreign_keys = ON;');
  if (filePath !== ':memory:') {
    const modeRow = runStmt('PRAGMA journal_mode', 'get', []);
    const currentMode = String(modeRow?.journal_mode ?? '').toLowerCase();
    if (currentMode !== 'wal') {
      raw.exec('PRAGMA journal_mode = WAL;');
    }
  }

  return {
    filePath,
    runtime,
    exec(sql) {
      raw.exec(sql);
    },
    run(sql, ...params) {
      const res = runStmt(sql, 'run', params);
      return {
        changes: Number(res?.changes ?? 0),
        lastInsertRowid: Number(res?.lastInsertRowid ?? 0),
      };
    },
    get(sql, ...params) {
      return cloneRow(runStmt(sql, 'get', params));
    },
    all(sql, ...params) {
      const rows = runStmt(sql, 'all', params);
      return Array.isArray(rows) ? rows.map((row) => ({ ...row })) : [];
    },
    transaction(fn) {
      const savepoint = txDepth > 0 ? `gempt_sp_${txDepth}` : null;
      if (savepoint) raw.exec(`SAVEPOINT ${savepoint}`);
      else raw.exec('BEGIN IMMEDIATE');
      txDepth += 1;
      try {
        const result = fn();
        if (savepoint) raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
        else raw.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          if (savepoint) {
            raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
          } else {
            raw.exec('ROLLBACK');
          }
        } catch {
          /* Ignore rollback error when original error is propagated. */
        }
        throw err;
      } finally {
        txDepth -= 1;
      }
    },
    close() {
      if (runtime === 'bun') raw.close(true);
      else raw.close();
    },
  };
}
