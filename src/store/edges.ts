/*
 * edges.ts — Edge CRUD operations for the Lynx graph store.
 *
 * Edges connect nodes with typed relationships.
 * Batch inserts use transactions for performance.
 */

import type { LynxDatabase } from './database.js';
import type { LynxEdge, LynxEdgeType } from '../types.js';

interface EdgeRow {
  id: number;
  project: string;
  source_id: number;
  target_id: number;
  type: string;
  properties: string;
}

// ── Insert ──────────────────────────────────────────────────────

function insertStructuralEvidence(db: LynxDatabase, edgeId: number, edge: LynxEdge): void {
  const line = typeof edge.properties.line === 'number' ? edge.properties.line : null;
  const confidence = typeof edge.properties.confidence === 'number' ? edge.properties.confidence : 0.8;
  const resolution = typeof edge.properties.resolution === 'string' ? edge.properties.resolution : 'structural';
  db.db.prepare('INSERT INTO edge_evidence (project, edge_id, evidence_type, source_kind, start_line, end_line, extractor, strength, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    edge.project,
    edgeId,
    'structural',
    resolution,
    line,
    line,
    'resolve',
    Math.max(0, Math.min(1, confidence)),
    JSON.stringify(edge.properties),
  );
}

export function insertEdge(db: LynxDatabase, edge: LynxEdge): number {
  const result = db.db
    .prepare(
      'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)'
    )
    .run(edge.project, edge.sourceId, edge.targetId, edge.type, JSON.stringify(edge.properties));
  const edgeId = Number(result.lastInsertRowid);
  insertStructuralEvidence(db, edgeId, edge);
  return edgeId;
}

export function insertEdgesBatch(db: LynxDatabase, edges: LynxEdge[]): void {
  const stmt = db.db.prepare(
    'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)'
  );

  const insert = db.db.transaction(() => {
    for (const edge of edges) {
      const result = stmt.run(edge.project, edge.sourceId, edge.targetId, edge.type, JSON.stringify(edge.properties));
      insertStructuralEvidence(db, Number(result.lastInsertRowid), edge);
    }
  });
  insert();
}

// ── Find ────────────────────────────────────────────────────────

export function findEdgesBySource(db: LynxDatabase, sourceId: number): EdgeRow[] {
  return db.db.prepare('SELECT * FROM edges WHERE source_id = ?').all(sourceId) as EdgeRow[];
}

export function findEdgesByTarget(db: LynxDatabase, targetId: number): EdgeRow[] {
  return db.db.prepare('SELECT * FROM edges WHERE target_id = ?').all(targetId) as EdgeRow[];
}

export function findEdgesBySourceType(
  db: LynxDatabase,
  sourceId: number,
  type: LynxEdgeType
): EdgeRow[] {
  return db.db
    .prepare('SELECT * FROM edges WHERE source_id = ? AND type = ?')
    .all(sourceId, type) as EdgeRow[];
}

export function findEdgesByTargetType(
  db: LynxDatabase,
  targetId: number,
  type: LynxEdgeType
): EdgeRow[] {
  return db.db
    .prepare('SELECT * FROM edges WHERE target_id = ? AND type = ?')
    .all(targetId, type) as EdgeRow[];
}

export function findEdgesByType(
  db: LynxDatabase,
  project: string,
  type: LynxEdgeType
): EdgeRow[] {
  return db.db
    .prepare('SELECT * FROM edges WHERE project = ? AND type = ?')
    .all(project, type) as EdgeRow[];
}

// ── Count ──────────────────────────────────────────────────────

export function countEdges(db: LynxDatabase, project: string): number {
  const row = db.db
    .prepare('SELECT COUNT(*) as cnt FROM edges WHERE project = ?')
    .get(project) as { cnt: number };
  return row.cnt;
}

export function countEdgesScoped(db: LynxDatabase, project: string, pathPrefix: string): number {
  const normalized = pathPrefix.endsWith('/') ? pathPrefix : pathPrefix + '/';
  const row = db.db
    .prepare(
      `SELECT COUNT(*) as cnt FROM edges e
       JOIN nodes n ON e.source_id = n.id
       WHERE e.project = ? AND n.file_path LIKE ?`
    )
    .get(project, normalized + '%') as { cnt: number };
  return row.cnt;
}

export function countEdgesByType(
  db: LynxDatabase,
  project: string,
  type: LynxEdgeType
): number {
  const row = db.db
    .prepare('SELECT COUNT(*) as cnt FROM edges WHERE project = ? AND type = ?')
    .get(project, type) as { cnt: number };
  return row.cnt;
}

export function getEdgeTypeCounts(
  db: LynxDatabase,
  project: string
): { type: string; count: number }[] {
  return db.db
    .prepare('SELECT type, COUNT(*) as count FROM edges WHERE project = ? GROUP BY type ORDER BY count DESC')
    .all(project) as { type: string; count: number }[];
}

// ── Degree ─────────────────────────────────────────────────────

export function getNodeDegree(
  db: LynxDatabase,
  nodeId: number
): { inDegree: number; outDegree: number } {
  const inRow = db.db
    .prepare('SELECT COUNT(*) as cnt FROM edges WHERE target_id = ?')
    .get(nodeId) as { cnt: number };
  const outRow = db.db
    .prepare('SELECT COUNT(*) as cnt FROM edges WHERE source_id = ?')
    .get(nodeId) as { cnt: number };
  return { inDegree: inRow.cnt, outDegree: outRow.cnt };
}

export function batchCountDegrees(
  db: LynxDatabase,
  nodeIds: number[],
  edgeType?: string
): { inDegrees: number[]; outDegrees: number[] } {
  const inDegrees: number[] = [];
  const outDegrees: number[] = [];

  const inStmt = edgeType
    ? 'SELECT COUNT(*) as cnt FROM edges WHERE target_id = ? AND type = ?'
    : 'SELECT COUNT(*) as cnt FROM edges WHERE target_id = ?';
  const outStmt = edgeType
    ? 'SELECT COUNT(*) as cnt FROM edges WHERE source_id = ? AND type = ?'
    : 'SELECT COUNT(*) as cnt FROM edges WHERE source_id = ?';

  for (const id of nodeIds) {
    const inRow = db.db.prepare(inStmt).get(id, ...(edgeType ? [edgeType] : [])) as { cnt: number };
    const outRow = db.db.prepare(outStmt).get(id, ...(edgeType ? [edgeType] : [])) as { cnt: number };
    inDegrees.push(inRow.cnt);
    outDegrees.push(outRow.cnt);
  }

  return { inDegrees, outDegrees };
}

// ── Delete ──────────────────────────────────────────────────────

export function deleteEdgesByProject(db: LynxDatabase, project: string): void {
  db.db.prepare('DELETE FROM edges WHERE project = ?').run(project);
}

export function deleteEdgesByType(db: LynxDatabase, project: string, type: LynxEdgeType): void {
  db.db.prepare('DELETE FROM edges WHERE project = ? AND type = ?').run(project, type);
}

export function deleteEdgesForNodesInFile(db: LynxDatabase, project: string, filePath: string): void {
  db.db
    .prepare(
      `DELETE FROM edges WHERE project = ? AND (
         source_id IN (SELECT id FROM nodes WHERE project = ? AND file_path = ?) OR
         target_id IN (SELECT id FROM nodes WHERE project = ? AND file_path = ?)
       )`
    )
    .run(project, project, filePath, project, filePath);
}
