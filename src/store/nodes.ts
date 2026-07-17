/*
 * nodes.ts — Node CRUD operations for the Lynx graph store.
 *
 * All nodes go through typed upserts. Properties are stored as JSON
 * in a TEXT column.
 */

import type { LynxDatabase } from './database.js';
import type { LynxNode, LynxNodeKind } from '../types.js';

interface NodeRow {
  id: number;
  project: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  is_exported: number;
  is_test: number;
  is_entry_point: number;
  properties: string;
}

// ── Upsert ──────────────────────────────────────────────────────

export function upsertNode(db: LynxDatabase, node: LynxNode): number {
  const props = extractProperties(node);
  const result = db.db
    .prepare(
      `INSERT INTO nodes (project, kind, name, qualified_name, file_path, start_line, end_line,
         is_exported, is_test, is_entry_point, properties)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project, qualified_name) DO UPDATE SET
         kind = excluded.kind, name = excluded.name, file_path = excluded.file_path,
         start_line = excluded.start_line, end_line = excluded.end_line,
         is_exported = excluded.is_exported, is_test = excluded.is_test,
         is_entry_point = excluded.is_entry_point, properties = excluded.properties`
    )
    .run(
      node.project,
      node.kind,
      node.name,
      node.qualifiedName,
      node.filePath,
      node.startLine,
      node.endLine,
      node.isExported ? 1 : 0,
      node.isTest ? 1 : 0,
      node.isEntryPoint ? 1 : 0,
      JSON.stringify(props)
    );
  return Number(result.lastInsertRowid);
}

export function upsertNodesBatch(db: LynxDatabase, nodes: LynxNode[]): number[] {
  const stmt = db.db.prepare(
    `INSERT INTO nodes (project, kind, name, qualified_name, file_path, start_line, end_line,
       is_exported, is_test, is_entry_point, properties)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project, qualified_name) DO UPDATE SET
       kind = excluded.kind, name = excluded.name, file_path = excluded.file_path,
       start_line = excluded.start_line, end_line = excluded.end_line,
       is_exported = excluded.is_exported, is_test = excluded.is_test,
       is_entry_point = excluded.is_entry_point, properties = excluded.properties`
  );

  const ids: number[] = [];
  const insert = db.db.transaction(() => {
    for (const node of nodes) {
      const props = extractProperties(node);
      const result = stmt.run(
        node.project,
        node.kind,
        node.name,
        node.qualifiedName,
        node.filePath,
        node.startLine,
        node.endLine,
        node.isExported ? 1 : 0,
        node.isTest ? 1 : 0,
        node.isEntryPoint ? 1 : 0,
        JSON.stringify(props)
      );
      ids.push(Number(result.lastInsertRowid));
    }
  });
  insert();
  return ids;
}

// ── Find ────────────────────────────────────────────────────────

export function findNodeById(db: LynxDatabase, id: number): NodeRow | null {
  const row = db.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
  return row ?? null;
}

export function findNodeByQn(db: LynxDatabase, project: string, qn: string): NodeRow | null {
  const row = db.db
    .prepare('SELECT * FROM nodes WHERE project = ? AND qualified_name = ?')
    .get(project, qn) as NodeRow | undefined;
  return row ?? null;
}

export function findNodeIdsByQns(
  db: LynxDatabase,
  project: string,
  qns: string[]
): Map<string, number> {
  const map = new Map<string, number>();
  if (qns.length === 0) return map;

  const placeholders = qns.map(() => '?').join(',');
  const rows = db.db
    .prepare(
      `SELECT id, qualified_name FROM nodes WHERE project = ? AND qualified_name IN (${placeholders})`
    )
    .all(project, ...qns) as { id: number; qualified_name: string }[];

  for (const row of rows) {
    map.set(row.qualified_name, row.id);
  }
  return map;
}

export function findNodesByFile(
  db: LynxDatabase,
  project: string,
  filePath: string
): NodeRow[] {
  return db.db
    .prepare('SELECT * FROM nodes WHERE project = ? AND file_path = ?')
    .all(project, filePath) as NodeRow[];
}

export function findNodesByKind(
  db: LynxDatabase,
  project: string,
  kind: LynxNodeKind
): NodeRow[] {
  return db.db
    .prepare('SELECT * FROM nodes WHERE project = ? AND kind = ?')
    .all(project, kind) as NodeRow[];
}

export function findNodesByFileOverlap(
  db: LynxDatabase,
  project: string,
  filePath: string,
  startLine: number,
  endLine: number
): NodeRow[] {
  return db.db
    .prepare(
      `SELECT * FROM nodes WHERE project = ? AND file_path = ?
       AND start_line <= ? AND end_line >= ?`
    )
    .all(project, filePath, endLine, startLine) as NodeRow[];
}

// ── Count / aggregate ──────────────────────────────────────────

export function countNodes(db: LynxDatabase, project: string): number {
  const row = db.db
    .prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?')
    .get(project) as { cnt: number };
  return row.cnt;
}

export function countNodesScoped(db: LynxDatabase, project: string, pathPrefix: string): number {
  const normalized = pathPrefix.endsWith('/') ? pathPrefix : pathPrefix + '/';
  const row = db.db
    .prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND file_path LIKE ?')
    .get(project, normalized + '%') as { cnt: number };
  return row.cnt;
}

export function getKindCounts(
  db: LynxDatabase,
  project: string
): { label: string; count: number }[] {
  return db.db
    .prepare(
      'SELECT kind as label, COUNT(*) as count FROM nodes WHERE project = ? GROUP BY kind ORDER BY count DESC'
    )
    .all(project) as { label: string; count: number }[];
}

// ── Delete ──────────────────────────────────────────────────────

export function deleteNodesByProject(db: LynxDatabase, project: string): void {
  db.db.prepare('DELETE FROM nodes WHERE project = ?').run(project);
}

export function deleteNodesByFile(db: LynxDatabase, project: string, filePath: string): void {
  db.db.prepare('DELETE FROM nodes WHERE project = ? AND file_path = ?').run(project, filePath);
}

// ── Helpers ─────────────────────────────────────────────────────

function extractProperties(node: LynxNode): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  switch (node.kind) {
    case 'Function':
      props.signature = node.signature;
      props.returnType = node.returnType;
      props.paramNames = node.paramNames;
      props.paramTypes = node.paramTypes || {};
      props.cyclomaticComplexity = node.cyclomaticComplexity;
      props.cognitiveComplexity = node.cognitiveComplexity;
      props.lineCount = node.lineCount;
      props.loopCount = node.loopCount;
      props.loopDepth = node.loopDepth;
      props.transitiveLoopDepth = node.transitiveLoopDepth;
      props.linearScanInLoop = node.linearScanInLoop;
      props.allocInLoop = node.allocInLoop;
      props.recursive = node.recursive;
      break;
    case 'Class':
      props.baseClasses = node.baseClasses;
      props.lineCount = node.lineCount;
      props.cyclomaticComplexity = node.cyclomaticComplexity;
      break;
    case 'Method':
      props.parentClass = node.parentClass;
      props.signature = node.signature;
      props.returnType = node.returnType;
      props.paramNames = node.paramNames;
      props.paramTypes = node.paramTypes || {};
      props.cyclomaticComplexity = node.cyclomaticComplexity;
      props.cognitiveComplexity = node.cognitiveComplexity;
      props.lineCount = node.lineCount;
      break;
    case 'Variable':
      props.typeAnnotation = node.typeAnnotation;
      break;
    case 'Interface':
      props.baseInterfaces = node.baseInterfaces;
      break;
    case 'Enum':
      props.members = node.members;
      break;
    case 'File':
      props.extension = node.extension;
      props.lastModified = node.lastModified;
      props.changeCount = node.changeCount;
      break;
    case 'Module':
      props.lineCount = node.lineCount;
      break;
    case 'Route':
      props.httpMethod = node.httpMethod;
      props.urlPath = node.urlPath;
      props.external = node.isExternal;
      break;
    case 'Branch':
      props.branchName = node.branchName;
      break;
    case 'Dependency':
      props.packageName = node.packageName;
      props.version = node.version;
      props.ecosystem = node.ecosystem;
      props.manifestPath = node.manifestPath;
      break;
    case 'Channel':
      props.channelName = node.channelName;
      props.transport = node.transport;
      break;
    case 'ExternalSymbol':
      props.symbolType = node.symbolType;
      break;
    case 'ConfigKey':
      props.keyName = node.keyName;
      break;
    // Folder and Project have no extra props
  }
  // LLM-enriched metadata (common to all node kinds)
  if (node.llmSummary) props.llmSummary = node.llmSummary;
  return props;
}
