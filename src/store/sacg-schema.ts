import type BetterSqlite3 from "better-sqlite3";

/**
 * Additive schema for the first SACG evidence-native vertical slice.
 * Legacy nodes and edges remain authoritative until projection parity is complete.
 */
export const SACG_VERTICAL_SLICE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS graph_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id TEXT NOT NULL,
    project TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'building',
    source_commit TEXT,
    source_branch TEXT,
    working_tree INTEGER NOT NULL DEFAULT 0,
    valid_from TEXT NOT NULL DEFAULT (datetime('now')),
    valid_to TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(project, snapshot_id),
    CHECK (working_tree IN (0, 1))
  );

  CREATE INDEX IF NOT EXISTS idx_graph_snapshots_project_validity
    ON graph_snapshots(project, valid_from, valid_to);
  CREATE INDEX IF NOT EXISTS idx_graph_snapshots_project_status
    ON graph_snapshots(project, status);

  CREATE TABLE IF NOT EXISTS semantic_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    semantic_id TEXT NOT NULL,
    entity_class TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT,
    normalized_signature TEXT NOT NULL DEFAULT '',
    structural_context TEXT NOT NULL DEFAULT '',
    properties_json TEXT NOT NULL DEFAULT '{}',
    first_seen_snapshot TEXT NOT NULL,
    last_seen_snapshot TEXT NOT NULL,
    valid_from TEXT NOT NULL DEFAULT (datetime('now')),
    valid_to TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project, semantic_id),
    FOREIGN KEY (project, first_seen_snapshot)
      REFERENCES graph_snapshots(project, snapshot_id),
    FOREIGN KEY (project, last_seen_snapshot)
      REFERENCES graph_snapshots(project, snapshot_id)
  );

  CREATE INDEX IF NOT EXISTS idx_semantic_entities_project_id
    ON semantic_entities(project, semantic_id);
  CREATE INDEX IF NOT EXISTS idx_semantic_entities_project_class
    ON semantic_entities(project, entity_class);

  CREATE TABLE IF NOT EXISTS semantic_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    semantic_relation_id TEXT NOT NULL,
    source_semantic_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    target_semantic_id TEXT NOT NULL,
    scope_json TEXT NOT NULL DEFAULT '{}',
    properties_json TEXT NOT NULL DEFAULT '{}',
    confidence REAL NOT NULL DEFAULT 0,
    confidence_level TEXT NOT NULL DEFAULT 'hypothesis',
    first_seen_snapshot TEXT NOT NULL,
    last_seen_snapshot TEXT NOT NULL,
    valid_from TEXT NOT NULL DEFAULT (datetime('now')),
    valid_to TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project, semantic_relation_id),
    FOREIGN KEY (project, source_semantic_id)
      REFERENCES semantic_entities(project, semantic_id),
    FOREIGN KEY (project, target_semantic_id)
      REFERENCES semantic_entities(project, semantic_id),
    FOREIGN KEY (project, first_seen_snapshot)
      REFERENCES graph_snapshots(project, snapshot_id),
    FOREIGN KEY (project, last_seen_snapshot)
      REFERENCES graph_snapshots(project, snapshot_id),
    CHECK (confidence >= 0 AND confidence <= 1),
    CHECK (confidence_level IN ('verified', 'high', 'medium', 'low', 'hypothesis'))
  );

  CREATE INDEX IF NOT EXISTS idx_semantic_relations_source_type
    ON semantic_relations(project, source_semantic_id, relation_type);
  CREATE INDEX IF NOT EXISTS idx_semantic_relations_target_type
    ON semantic_relations(project, target_semantic_id, relation_type);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_relations_logical_identity
    ON semantic_relations(
      project, source_semantic_id, relation_type, target_semantic_id, scope_json
    );

  CREATE TABLE IF NOT EXISTS evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL,
    project TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    polarity TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_path TEXT,
    source_hash TEXT NOT NULL,
    start_line INTEGER,
    end_line INTEGER,
    symbol_semantic_id TEXT,
    extractor TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    strength REAL NOT NULL,
    independence_group TEXT,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    snapshot_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project, evidence_id),
    FOREIGN KEY (project, symbol_semantic_id)
      REFERENCES semantic_entities(project, semantic_id),
    FOREIGN KEY (project, snapshot_id)
      REFERENCES graph_snapshots(project, snapshot_id),
    CHECK (polarity IN ('supports', 'contradicts', 'neutral')),
    CHECK (strength >= 0 AND strength <= 1),
    CHECK (start_line IS NULL OR start_line >= 0),
    CHECK (end_line IS NULL OR end_line >= 0),
    CHECK (start_line IS NULL OR end_line IS NULL OR end_line >= start_line)
  );

  CREATE INDEX IF NOT EXISTS idx_evidence_source_hash
    ON evidence(project, source_hash);
  CREATE INDEX IF NOT EXISTS idx_evidence_snapshot
    ON evidence(project, snapshot_id);
  CREATE INDEX IF NOT EXISTS idx_evidence_symbol
    ON evidence(project, symbol_semantic_id);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_logical_identity
    ON evidence(
      project,
      evidence_type,
      source_hash,
      COALESCE(source_path, ''),
      COALESCE(start_line, -1),
      COALESCE(end_line, -1),
      COALESCE(symbol_semantic_id, ''),
      extractor_version
    );

`;

export function createSacgVerticalSliceSchema(
  db: BetterSqlite3.Database,
): void {
  db.exec(SACG_VERTICAL_SLICE_SCHEMA);
}
