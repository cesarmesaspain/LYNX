import type Database from 'better-sqlite3';

export const NATIVE_STAGING_SCHEMA_VERSION = 3;

const NATIVE_STAGING_COLUMNS = {
  native_run: ['singleton', 'schema_version', 'engine_version', 'project', 'repository_root', 'status', 'started_at', 'completed_at', 'error'],
  native_files: ['id', 'rel_path', 'language', 'sha256', 'size_bytes', 'status', 'partial_reasons_json'],
  native_nodes: ['id', 'file_id', 'kind', 'name', 'qualified_name', 'start_line', 'end_line', 'is_exported', 'is_test', 'is_entry_point', 'properties_json'],
  native_calls: ['id', 'file_id', 'enclosing_qualified_name', 'callee_name', 'dispatch_kind', 'receiver_text', 'start_line', 'start_column', 'arguments_json'],
  native_imports: ['id', 'file_id', 'local_name', 'imported_name', 'module_path', 'resolved_rel_path', 'start_line'],
  native_usages: ['id', 'file_id', 'enclosing_qualified_name', 'referenced_name', 'start_line', 'start_column', 'is_write'],
  native_edges: ['id', 'file_id', 'source_qualified_name', 'target_qualified_name', 'type', 'start_line', 'start_column', 'confidence', 'strategy', 'evidence_json'],
} as const;

export const NATIVE_STAGING_DDL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE native_run (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL,
    engine_version TEXT NOT NULL,
    project TEXT NOT NULL,
    repository_root TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('building', 'complete', 'failed')),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT
  );

  CREATE TABLE native_files (
    id INTEGER PRIMARY KEY,
    rel_path TEXT NOT NULL UNIQUE,
    language TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    status TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'failed')),
    partial_reasons_json TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE native_nodes (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES native_files(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL UNIQUE,
    start_line INTEGER NOT NULL CHECK (start_line >= 0),
    end_line INTEGER NOT NULL CHECK (end_line >= start_line),
    is_exported INTEGER NOT NULL CHECK (is_exported IN (0, 1)),
    is_test INTEGER NOT NULL CHECK (is_test IN (0, 1)),
    is_entry_point INTEGER NOT NULL CHECK (is_entry_point IN (0, 1)),
    properties_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE native_calls (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES native_files(id) ON DELETE CASCADE,
    enclosing_qualified_name TEXT NOT NULL,
    callee_name TEXT NOT NULL,
    dispatch_kind TEXT NOT NULL CHECK (dispatch_kind IN ('direct', 'member', 'qualified', 'template')),
    receiver_text TEXT,
    start_line INTEGER NOT NULL CHECK (start_line >= 0),
    start_column INTEGER NOT NULL DEFAULT 0 CHECK (start_column >= 0),
    arguments_json TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE native_imports (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES native_files(id) ON DELETE CASCADE,
    local_name TEXT NOT NULL,
    imported_name TEXT,
    module_path TEXT NOT NULL,
    resolved_rel_path TEXT,
    start_line INTEGER NOT NULL CHECK (start_line >= 0)
  );

  CREATE TABLE native_edges (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES native_files(id) ON DELETE CASCADE,
    source_qualified_name TEXT NOT NULL,
    target_qualified_name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('CALLS', 'READS', 'WRITES')),
    start_line INTEGER NOT NULL CHECK (start_line >= 0),
    start_column INTEGER NOT NULL DEFAULT 0 CHECK (start_column >= 0),
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    strategy TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE native_usages (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES native_files(id) ON DELETE CASCADE,
    enclosing_qualified_name TEXT NOT NULL,
    referenced_name TEXT NOT NULL,
    start_line INTEGER NOT NULL CHECK (start_line >= 0),
    start_column INTEGER NOT NULL DEFAULT 0 CHECK (start_column >= 0),
    is_write INTEGER NOT NULL CHECK (is_write IN (0, 1))
  );

  CREATE INDEX native_nodes_file ON native_nodes(file_id);
  CREATE INDEX native_nodes_name_kind ON native_nodes(name, kind);
  CREATE INDEX native_nodes_file_name_kind ON native_nodes(file_id, name, kind);
  CREATE INDEX native_calls_file ON native_calls(file_id);
  CREATE INDEX native_calls_file_dispatch_name ON native_calls(file_id, dispatch_kind, callee_name);
  CREATE INDEX native_imports_file ON native_imports(file_id);
  CREATE INDEX native_imports_file_resolved ON native_imports(file_id, resolved_rel_path);
  CREATE INDEX native_usages_file ON native_usages(file_id);
  CREATE INDEX native_usages_file_name ON native_usages(file_id, referenced_name, is_write);
  CREATE INDEX native_edges_file ON native_edges(file_id);
  CREATE UNIQUE INDEX native_edges_observation_identity
    ON native_edges(file_id, source_qualified_name, target_qualified_name, type, start_line, start_column);
  CREATE INDEX native_edges_source ON native_edges(source_qualified_name, type);
  CREATE INDEX native_edges_target ON native_edges(target_qualified_name, type);
`;

export interface NativeStagingValidation {
  valid: boolean;
  errors: string[];
  counts: {
    files: number;
    nodes: number;
    calls: number;
    imports: number;
    usages: number;
    edges: number;
    partialFiles: number;
  };
}

function scalar(db: Database.Database, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { value: number };
  return Number(row.value);
}

function validateShape(db: Database.Database): string[] {
  const errors: string[] = [];
  for (const [table, expected] of Object.entries(NATIVE_STAGING_COLUMNS)) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const actual = rows.map((row) => row.name);
    if (actual.length === 0) {
      errors.push(`missing staging table ${table}`);
    } else if (actual.join('\0') !== expected.join('\0')) {
      errors.push(`staging table ${table} has incompatible columns`);
    }
  }
  return errors;
}

/** Validate a completed native artifact before it can enter the canonical graph. */
export function validateNativeStaging(
  db: Database.Database,
  expectedProject: string,
): NativeStagingValidation {
  const errors = validateShape(db);
  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      counts: { files: 0, nodes: 0, calls: 0, imports: 0, usages: 0, edges: 0, partialFiles: 0 },
    };
  }
  const run = db.prepare(
    'SELECT schema_version, project, status, completed_at FROM native_run WHERE singleton = 1',
  ).get() as {
    schema_version: number;
    project: string;
    status: string;
    completed_at: string | null;
  } | undefined;

  if (!run) errors.push('missing native_run record');
  else {
    if (run.schema_version !== NATIVE_STAGING_SCHEMA_VERSION) {
      errors.push(`unsupported schema version ${run.schema_version}`);
    }
    if (run.project !== expectedProject) errors.push('project identity mismatch');
    if (run.status !== 'complete' || !run.completed_at) errors.push('native run is not complete');
  }

  const duplicateQns = scalar(
    db,
    `SELECT COUNT(*) AS value FROM (
       SELECT qualified_name FROM native_nodes GROUP BY qualified_name HAVING COUNT(*) > 1
     )`,
  );
  if (duplicateQns > 0) errors.push(`${duplicateQns} duplicate qualified names`);

  const invalidJson = scalar(
    db,
    `SELECT
       (SELECT COUNT(*) FROM native_files WHERE NOT json_valid(partial_reasons_json)) +
       (SELECT COUNT(*) FROM native_nodes WHERE NOT json_valid(properties_json)) +
       (SELECT COUNT(*) FROM native_calls WHERE NOT json_valid(arguments_json)) +
       (SELECT COUNT(*) FROM native_edges WHERE NOT json_valid(evidence_json)) AS value`,
  );
  if (invalidJson > 0) errors.push(`${invalidJson} invalid JSON payloads`);

  const orphanEdges = scalar(
    db,
    `SELECT COUNT(*) AS value FROM native_edges e
     WHERE NOT EXISTS (SELECT 1 FROM native_nodes n WHERE n.qualified_name=e.source_qualified_name)
        OR NOT EXISTS (SELECT 1 FROM native_nodes n WHERE n.qualified_name=e.target_qualified_name)`,
  );
  if (orphanEdges > 0) errors.push(`${orphanEdges} edges reference missing nodes`);

  return {
    valid: errors.length === 0,
    errors,
    counts: {
      files: scalar(db, 'SELECT COUNT(*) AS value FROM native_files'),
      nodes: scalar(db, 'SELECT COUNT(*) AS value FROM native_nodes'),
      calls: scalar(db, 'SELECT COUNT(*) AS value FROM native_calls'),
      imports: scalar(db, 'SELECT COUNT(*) AS value FROM native_imports'),
      usages: scalar(db, 'SELECT COUNT(*) AS value FROM native_usages'),
      edges: scalar(db, 'SELECT COUNT(*) AS value FROM native_edges'),
      partialFiles: scalar(db, "SELECT COUNT(*) AS value FROM native_files WHERE status != 'complete'"),
    },
  };
}
