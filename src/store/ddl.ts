/*
 * ddl.ts — SQLite DDL statements for the LYNX graph store.
 *
 * Extracted from LynxDatabase to keep the class focused on operations.
 * All CREATE TABLE, INDEX, and migration SQL lives here.
 */

import type BetterSqlite3 from 'better-sqlite3';

/** Full core schema: projects, graph data, file hashes, persistent LLM summaries, and metrics. */
export const CORE_SCHEMA = `
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
    mode TEXT NOT NULL DEFAULT 'full'
  );

  CREATE INDEX IF NOT EXISTS idx_index_runs_project ON index_runs(project);

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

/** Add v0.1 → v0.2 freshness columns (status, status_error) if missing. */
export function migrateV01toV02(db: BetterSqlite3.Database): void {
  for (const { col, def } of [
    { col: 'status', def: "TEXT NOT NULL DEFAULT 'ready'" },
    { col: 'status_error', def: 'TEXT' },
  ]) {
    try {
      db.exec('ALTER TABLE projects ADD COLUMN ' + col + ' ' + def);
    } catch {
      // Column already exists
    }
  }
}

/** Add the commit captured by the last successful index, if missing. */
export function migrateV02toV03(db: BetterSqlite3.Database): void {
  try {
    db.exec('ALTER TABLE projects ADD COLUMN indexed_commit TEXT');
  } catch {
    // Column already exists, or the table will be created by CORE_SCHEMA.
  }
}
