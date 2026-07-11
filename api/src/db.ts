/*
 * db.ts — SQLite initialization and schema for the LYNX API server.
 *
 * Three databases:
 *   licenses.db  — users, license_keys, telemetry_daily
 *   provider.db  — intelligence_routing table (hot-swappable providers)
 *
 * WAL mode enabled for concurrent reads during writes.
 */

import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = path.resolve(import.meta.dirname, '../data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── Licenses DB ─────────────────────────────────────

const licensesDb: DatabaseType = new Database(path.join(DATA_DIR, 'licenses.db'));
licensesDb.pragma('journal_mode = WAL');
licensesDb.pragma('foreign_keys = ON');

licensesDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    stripe_customer_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    tier TEXT DEFAULT 'free',
    billing_status TEXT,
    current_period_end TEXT,
    machine_fingerprints TEXT DEFAULT '[]',
    max_machines INTEGER DEFAULT 3
  );

  CREATE TABLE IF NOT EXISTS license_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    jwt TEXT NOT NULL,
    issued_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    revoked INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS telemetry_daily (
    date TEXT,
    license_id TEXT,
    tool_calls INTEGER DEFAULT 0,
    search_graph_calls INTEGER DEFAULT 0,
    trace_path_calls INTEGER DEFAULT 0,
    index_calls INTEGER DEFAULT 0,
    detect_changes_calls INTEGER DEFAULT 0,
    PRIMARY KEY (date, license_id)
  );
`);

// ── Provider DB ─────────────────────────────────────

const providerDb: DatabaseType = new Database(path.join(DATA_DIR, 'provider.db'));
providerDb.pragma('journal_mode = WAL');

providerDb.exec(`
  CREATE TABLE IF NOT EXISTS intelligence_routing (
    task TEXT PRIMARY KEY,
    primary_provider TEXT NOT NULL DEFAULT 'heuristic',
    fallback_provider TEXT,
    max_tokens INTEGER DEFAULT 128,
    temperature REAL DEFAULT 0.1,
    cache_ttl_seconds INTEGER DEFAULT 604800,
    enabled INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed default routing if table is empty
const count = providerDb.prepare('SELECT COUNT(*) as c FROM intelligence_routing').get() as { c: number };
if (count.c === 0) {
  const insert = providerDb.prepare(
    'INSERT OR REPLACE INTO intelligence_routing (task, primary_provider, fallback_provider) VALUES (?, ?, ?)'
  );
  const defaults: Array<[string, string, string | null]> = [
    ['summarize_module', 'qwen-14b', 'deepseek'],
    ['rerank_search', 'qwen-14b', 'deepseek'],
    ['assess_change_risk', 'qwen-14b', 'deepseek'],
    ['detect_entry_point', 'heuristic', 'qwen-14b'],
    ['classify_code_smell', 'qwen-14b', 'heuristic'],
    ['detect_test', 'heuristic', null],
  ];
  for (const [task, primary, fallback] of defaults) {
    insert.run(task, primary, fallback);
  }
}

export { licensesDb, providerDb };
