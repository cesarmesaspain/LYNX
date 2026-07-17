/*
 * ddl.ts — SQLite DDL statements for the LYNX graph store.
 *
 * Extracted from LynxDatabase to keep the class focused on operations.
 * All CREATE TABLE, INDEX, and migration SQL lives here.
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { SchemaMigration } from './migrations.js';
import { createSacgVerticalSliceSchema } from './sacg-schema.js';

/** Full core schema: projects, graph data, file hashes, persistent LLM summaries, and metrics. */
export const CORE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    root_path TEXT NOT NULL,
    indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'ready',
    status_error TEXT,
    indexed_commit TEXT
  );

  CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL DEFAULT 0,
    end_line INTEGER NOT NULL DEFAULT 0,
    is_exported INTEGER NOT NULL DEFAULT 0,
    is_test INTEGER NOT NULL DEFAULT 0,
    is_entry_point INTEGER NOT NULL DEFAULT 0,
    properties TEXT NOT NULL DEFAULT '{}',
    UNIQUE(project, qualified_name)
  );

  CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project);
  CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(project, kind);
  CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(project, file_path);
  CREATE INDEX IF NOT EXISTS idx_nodes_qn ON nodes(qualified_name);

  CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    source_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    properties TEXT NOT NULL DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project);
  CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
  CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
  CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(project, type);

  CREATE TABLE IF NOT EXISTS edge_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    edge_id INTEGER NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
    evidence_type TEXT NOT NULL DEFAULT 'structural',
    source_kind TEXT NOT NULL DEFAULT 'resolver',
    source_path TEXT,
    start_line INTEGER,
    end_line INTEGER,
    extractor TEXT NOT NULL DEFAULT 'resolve',
    strength REAL NOT NULL DEFAULT 0.8,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_edge_evidence_project ON edge_evidence(project);
  CREATE INDEX IF NOT EXISTS idx_edge_evidence_edge ON edge_evidence(edge_id);
  CREATE INDEX IF NOT EXISTS idx_edge_evidence_type ON edge_evidence(project, evidence_type);

  CREATE TABLE IF NOT EXISTS file_hashes (
    project TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    mtime_ns INTEGER NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project, rel_path)
  );

  CREATE TABLE IF NOT EXISTS llm_summary_cache (
    project TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    summary TEXT NOT NULL,
    source_tokens_est INTEGER NOT NULL DEFAULT 0,
    summary_tokens_est INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project, source_hash)
  );

  CREATE INDEX IF NOT EXISTS idx_llm_summary_cache_project ON llm_summary_cache(project);

  CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    target_qn TEXT NOT NULL,
    target_file TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    metrics TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_findings_project ON findings(project);
  CREATE INDEX IF NOT EXISTS idx_findings_qn ON findings(target_qn);
  CREATE INDEX IF NOT EXISTS idx_findings_file ON findings(target_file);

  CREATE TABLE IF NOT EXISTS index_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    run_at TEXT NOT NULL DEFAULT (datetime('now')),
    total_nodes INTEGER NOT NULL DEFAULT 0,
    total_edges INTEGER NOT NULL DEFAULT 0,
    hotspot_count INTEGER NOT NULL DEFAULT 0,
    avg_complexity REAL NOT NULL DEFAULT 0,
    files_processed INTEGER NOT NULL DEFAULT 0,
    files_skipped INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'full',
    coverage_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_index_runs_project ON index_runs(project);

  CREATE TABLE IF NOT EXISTS file_call_coverage (
    project TEXT NOT NULL,
    file_path TEXT NOT NULL,
    total_calls INTEGER NOT NULL DEFAULT 0,
    unresolved_calls INTEGER NOT NULL DEFAULT 0,
    reasons_json TEXT NOT NULL DEFAULT '{}',
    partial_reasons_json TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (project, file_path)
  );

  CREATE INDEX IF NOT EXISTS idx_file_call_coverage_project
    ON file_call_coverage(project);

  CREATE TABLE IF NOT EXISTS project_briefs (
    project TEXT PRIMARY KEY,
    digest_hash TEXT NOT NULL,
    brief TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'local',
    generated_at TEXT NOT NULL DEFAULT (datetime('now')),
    input_tokens_est INTEGER NOT NULL DEFAULT 0,
    output_tokens_est INTEGER NOT NULL DEFAULT 0,
    cost_usd_est REAL NOT NULL DEFAULT 0,
    metrics_json TEXT NOT NULL DEFAULT '{}'
  );
`;

/** Drop edge indexes for bulk insert performance. */
export const DROP_EDGE_INDEXES = `
  DROP INDEX IF EXISTS idx_edges_project;
  DROP INDEX IF EXISTS idx_edges_source;
  DROP INDEX IF EXISTS idx_edges_target;
  DROP INDEX IF EXISTS idx_edges_type;
`;

/** Recreate edge indexes after bulk insert. */
export const CREATE_EDGE_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project);
  CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
  CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
  CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(project, type);
`;

function tableColumns(db: BetterSqlite3.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** Add v0.1 → v0.2 freshness columns (status, status_error) if missing. */
export function migrateV01toV02(db: BetterSqlite3.Database): void {
  const columns = tableColumns(db, 'projects');
  if (!columns.has('status')) {
    db.exec("ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'");
  }
  if (!columns.has('status_error')) {
    db.exec('ALTER TABLE projects ADD COLUMN status_error TEXT');
  }
}

/** Add the commit captured by the last successful index, if missing. */
export function migrateV02toV03(db: BetterSqlite3.Database): void {
  if (!tableColumns(db, 'projects').has('indexed_commit')) {
    db.exec('ALTER TABLE projects ADD COLUMN indexed_commit TEXT');
  }
}

/** Persist resolution coverage so no-op runs can report the last graph truth. */
export function migrateV03toV04(db: BetterSqlite3.Database): void {
  if (!tableColumns(db, 'index_runs').has('coverage_json')) {
    db.exec('ALTER TABLE index_runs ADD COLUMN coverage_json TEXT');
  }
}

/** Add per-file resolution denominators for truthful partial incremental totals. */
export function migrateV04toV05(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_call_coverage (
      project TEXT NOT NULL,
      file_path TEXT NOT NULL,
      total_calls INTEGER NOT NULL DEFAULT 0,
      unresolved_calls INTEGER NOT NULL DEFAULT 0,
      reasons_json TEXT NOT NULL DEFAULT '{}',
      partial_reasons_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (project, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_file_call_coverage_project
      ON file_call_coverage(project);
  `);
}

export const GRAPH_SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  { version: 1, name: 'project freshness columns', up: migrateV01toV02 },
  { version: 2, name: 'project indexed commit', up: migrateV02toV03 },
  { version: 3, name: 'SACG vertical slice tables', up: createSacgVerticalSliceSchema },
  { version: 4, name: 'index run resolution coverage', up: migrateV03toV04 },
  { version: 5, name: 'per-file call resolution coverage', up: migrateV04toV05 },
];
