'use strict';

// Node 22.13+; the same SQL is used by the Worker through its D1 binding.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openAuthDatabase(filename) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if (filename !== ':memory:') sqlite.exec('PRAGMA journal_mode=WAL;');
  sqlite.exec(fs.readFileSync(path.join(__dirname, '../worker/migrations/0001_accounts.sql'), 'utf8'));
  sqlite.exec(fs.readFileSync(path.join(__dirname, '../worker/migrations/0002_practice_papers.sql'), 'utf8'));
  sqlite.exec(fs.readFileSync(path.join(__dirname, '../worker/migrations/0003_account_roles.sql'), 'utf8'));
  if (filename !== ':memory:') {
    try { fs.chmodSync(filename, 0o600); } catch (_) { /* Windows uses ACLs. */ }
  }
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      function bound(values) {
        return {
          bind(...args) { return bound(args); },
          async first(column) {
            const row = statement.get(...values);
            if (!row) return null;
            return column ? row[column] : row;
          },
          async run() {
            const result = statement.run(...values);
            return { success: true, meta: { changes: Number(result.changes) } };
          },
          async all() { return { success: true, results: statement.all(...values) }; }
        };
      }
      return bound([]);
    },
    close() { sqlite.close(); }
  };
}

module.exports = { openAuthDatabase };
