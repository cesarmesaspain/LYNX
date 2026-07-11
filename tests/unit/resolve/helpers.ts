/*
 * helpers.ts — Shared factories for resolve pass unit tests.
 */

import { LynxDatabase } from '../../../src/store/database.js';
import { buildIndexes, type NodeRef, type ResolverIndexes } from '../../../src/pipeline/phases/resolve/indexes.js';
import type { ExtractionBatch } from '../../../src/pipeline/phases/extract.js';
import type { ExtractionResult } from '../../../src/extraction/extractor.js';
import type { LynxEdge } from '../../../src/types.js';

let _idCounter = 0;

export function nextId(): number {
  return ++_idCounter;
}

export function resetIdCounter(): void {
  _idCounter = 0;
}

export function makeNodeRef(overrides: Partial<NodeRef> & { id?: number; kind: string; name: string; qualified_name: string; file_path: string }): NodeRef {
  return {
    id: overrides.id ?? nextId(),
    kind: overrides.kind,
    name: overrides.name,
    qualified_name: overrides.qualified_name,
    file_path: overrides.file_path,
    start_line: overrides.start_line ?? 1,
    is_exported: overrides.is_exported ?? 1,
    properties: overrides.properties ?? null,
  };
}

export function makeFileNode(
  id: number,
  relPath: string,
  project: string = 'test'
): NodeRef {
  // Make the qualified_name look like how the extractor does it
  const moduleQn = relPath.replace(/^src\//, '').replace(/\//g, '.').replace(/\.[^.]+$/, '');
  return {
    id,
    kind: 'File',
    name: relPath.split('/').pop() || relPath,
    qualified_name: moduleQn,
    file_path: relPath,
    start_line: 1,
    properties: null,
  };
}

export function makeFuncNode(
  id: number,
  name: string,
  filePath: string,
  parentName?: string
): NodeRef {
  const baseQn = filePath.replace(/^src\//, '').replace(/\//g, '.').replace(/\.[^.]+$/, '');
  const qn = parentName ? `${baseQn}.${parentName}.${name}` : `${baseQn}.${name}`;
  return {
    id,
    kind: 'Function',
    name,
    qualified_name: qn,
    file_path: filePath,
    start_line: 1,
    properties: null,
  };
}

export function makeClassNode(
  id: number,
  name: string,
  filePath: string
): NodeRef {
  const baseQn = filePath.replace(/^src\//, '').replace(/\//g, '.').replace(/\.[^.]+$/, '');
  return {
    id,
    kind: 'Class',
    name,
    qualified_name: `${baseQn}.${name}`,
    file_path: filePath,
    start_line: 1,
    properties: null,
  };
}

export function makeInterfaceNode(
  id: number,
  name: string,
  filePath: string,
  baseInterfaces?: string[]
): NodeRef {
  const baseQn = filePath.replace(/^src\//, '').replace(/\//g, '.').replace(/\.[^.]+$/, '');
  return {
    id,
    kind: 'Interface',
    name,
    qualified_name: `${baseQn}.${name}`,
    file_path: filePath,
    start_line: 1,
    properties: baseInterfaces ? JSON.stringify({ baseInterfaces }) : null,
  };
}

export function makeVariableNode(
  id: number,
  name: string,
  filePath: string
): NodeRef {
  const baseQn = filePath.replace(/^src\//, '').replace(/\//g, '.').replace(/\.[^.]+$/, '');
  return {
    id,
    kind: 'Variable',
    name,
    qualified_name: `${baseQn}.${name}`,
    file_path: filePath,
    start_line: 1,
    properties: null,
  };
}

export function makeEmptyResult(): ExtractionResult {
  return {
    nodes: [],
    calls: [],
    imports: [],
    usages: [],
    channels: [],
    throws: [],
    decorators: [],
    hasError: false,
    errorMsg: null,
    isTestFile: false,
    language: 'typescript',
  };
}

export function makeBatch(
  relPath: string,
  absPath: string,
  result: ExtractionResult
): ExtractionBatch {
  return {
    file: {
      relPath,
      absPath,
      extension: relPath.split('.').pop() || 'ts',
      size: 0,
    },
    result,
  };
}

export function createEmptyIndexes(project: string = 'test'): ResolverIndexes {
  return {
    project,
    allRows: [],
    qnToId: new Map(),
    idToRow: new Map(),
    nameToRows: new Map(),
    kindNameToRows: new Map(),
    fileToNodes: new Map(),
    suffixToRows: new Map(),
    moduleToFileNode: new Map(),
    exportedByModule: new Map(),
    folderToId: new Map(),
    importedQnByFile: new Map(),
    hasExportedCallables: false,
  };
}

export function populateIndex(db: LynxDatabase, idx: ResolverIndexes, rows: NodeRef[]): void {
  for (const row of rows) {
    // Insert into DB so upsertNode in passes finds them
    db.db.prepare(
      `INSERT OR IGNORE INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, ?)`
    ).run(row.id, idx.project, row.kind, row.name, row.qualified_name, row.file_path, row.start_line, row.properties);

    idx.allRows.push(row);
    idx.qnToId.set(row.qualified_name, row.id);
    idx.idToRow.set(row.id, row);
    if (!idx.nameToRows.has(row.name)) idx.nameToRows.set(row.name, []);
    idx.nameToRows.get(row.name)!.push(row);
    if (!idx.kindNameToRows.has(`${row.kind}:${row.name}`)) idx.kindNameToRows.set(`${row.kind}:${row.name}`, []);
    idx.kindNameToRows.get(`${row.kind}:${row.name}`)!.push(row);
    if (!idx.fileToNodes.has(row.file_path)) idx.fileToNodes.set(row.file_path, []);
    idx.fileToNodes.get(row.file_path)!.push(row);

    if (row.kind === 'File') {
      const moduleKey = row.file_path.replace(/\\/g, '/').replace(/\.[^.]+$/, '').replace(/^src\//, '').replace(/\//g, '.');
      idx.moduleToFileNode.set(moduleKey, row);
    }

    if (['Function', 'Method', 'Class', 'Interface', 'Variable', 'Type', 'Enum'].includes(row.kind)) {
      const moduleKey = row.file_path.replace(/\\/g, '/').replace(/\.[^.]+$/, '').replace(/^src\//, '').replace(/\//g, '.');
      if (!idx.exportedByModule.has(moduleKey)) idx.exportedByModule.set(moduleKey, []);
      idx.exportedByModule.get(moduleKey)!.push(row);
    }

    // Build suffix index
    const parts = row.qualified_name.split('.');
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('.');
      if (!idx.suffixToRows.has(suffix)) idx.suffixToRows.set(suffix, []);
      idx.suffixToRows.get(suffix)!.push(row);
    }
  }
}

export function getEdgesByType(edges: LynxEdge[], type: string): LynxEdge[] {
  return edges.filter(e => e.type === type);
}
