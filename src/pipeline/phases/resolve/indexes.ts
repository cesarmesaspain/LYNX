/*
 * resolve/indexes.ts — In-memory index construction for the resolver.
 */

import type { LynxDatabase } from '../../../store/database.js';
import { pushMap, qnSuffixes, filePathToModuleKey } from './utils.js';
import { symbolKinds } from './constants.js';

export interface NodeRef {
  id: number;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  is_exported: number;
  properties: string | null;
}

export interface ResolverIndexes {
  project: string;
  allRows: NodeRef[];
  qnToId: Map<string, number>;
  idToRow: Map<number, NodeRef>;
  nameToRows: Map<string, NodeRef[]>;
  kindNameToRows: Map<string, NodeRef[]>;
  fileToNodes: Map<string, NodeRef[]>;
  suffixToRows: Map<string, NodeRef[]>;
  moduleToFileNode: Map<string, NodeRef>;
  /** Header basename -> candidate File nodes. Used for conservative C/C++ include-path resolution. */
  headerBasenameToFileNodes: Map<string, NodeRef[]>;
  exportedByModule: Map<string, NodeRef[]>;
  folderToId: Map<string, number>;
  /** file_path → set of qualified_names that file imports. Built by passImports, consumed by resolveCallee. */
  importedQnByFile: Map<string, Set<string>>;
  /** True if at least one Function/Method has is_exported=1 (extractor populated the field). */
  hasExportedCallables: boolean;
}

export interface ResolverState {
  totalCalls: number;
  unresolvedCalls: number;
  unresolvedCallReasons: Record<string, number>;
}

export function buildIndexes(db: LynxDatabase, project: string): ResolverIndexes {
  const allRows = db.db
    .prepare('SELECT id, kind, name, qualified_name, file_path, start_line, is_exported, properties FROM nodes WHERE project = ?')
    .all(project) as NodeRef[];

  const idx: ResolverIndexes = {
    project,
    allRows,
    qnToId: new Map(),
    idToRow: new Map(),
    nameToRows: new Map(),
    kindNameToRows: new Map(),
    fileToNodes: new Map(),
    suffixToRows: new Map(),
    moduleToFileNode: new Map(),
    headerBasenameToFileNodes: new Map(),
    exportedByModule: new Map(),
    folderToId: new Map(),
    importedQnByFile: new Map(),
    hasExportedCallables: allRows.some((r) => r.is_exported !== 0 && (r.kind === 'Function' || r.kind === 'Method')),
  };

  for (const row of allRows) {
    idx.qnToId.set(row.qualified_name, row.id);
    idx.idToRow.set(row.id, row);
    pushMap(idx.nameToRows, row.name, row);
    pushMap(idx.kindNameToRows, `${row.kind}:${row.name}`, row);
    pushMap(idx.fileToNodes, row.file_path, row);

    for (const suffix of qnSuffixes(row.qualified_name)) {
      pushMap(idx.suffixToRows, suffix, row);
    }

    if (row.kind === 'File') {
      idx.moduleToFileNode.set(filePathToModuleKey(row.file_path), row);
      if (/\.(?:h|hh|hpp|hxx)$/i.test(row.file_path)) {
        const basename = row.file_path.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
        pushMap(idx.headerBasenameToFileNodes, basename, row);
      }
    }

    if (symbolKinds.has(row.kind)) {
      const moduleKey = filePathToModuleKey(row.file_path);
      pushMap(idx.exportedByModule, moduleKey, row);
    }
  }

  return idx;
}
