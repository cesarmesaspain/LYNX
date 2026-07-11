/*
 * resolve/pass-structure.ts — Folder hierarchy and CONTAINS edges.
 */

import type { LynxDatabase } from '../../../store/database.js';
import { upsertNode } from '../../../store/nodes.js';
import type { LynxEdge, LynxFolder } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import type { NodeRef, ResolverIndexes } from './indexes.js';
import { addEdge, getFileNode } from './utils.js';

export function passStructure(
  db: LynxDatabase,
  batches: ExtractionBatch[],
  idx: ResolverIndexes,
  edges: LynxEdge[]
): void {
  // Ensure Project node exists
  const projectQn = `${idx.project}.project`;
  let projectId = idx.qnToId.get(projectQn);
  if (!projectId) {
    const projectNode = {
      project: idx.project,
      kind: 'Project' as const,
      name: idx.project,
      qualifiedName: projectQn,
      filePath: '',
      startLine: 0,
      endLine: 0,
      isExported: false,
      isTest: false,
      isEntryPoint: false,
    };
    projectId = upsertNode(db, projectNode);
    const row: NodeRef = {
      id: projectId,
      kind: 'Project',
      name: idx.project,
      qualified_name: projectQn,
      file_path: '',
      start_line: 0,
      is_exported: 0,
      properties: null,
    };
    idx.qnToId.set(projectQn, projectId);
    idx.idToRow.set(projectId, row);
    idx.allRows.push(row);
  }

  const folderSet = new Set<string>();
  for (const batch of batches) {
    const parts = batch.file.relPath.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join('/');
      if (dirPath && dirPath !== '.') folderSet.add(dirPath);
    }
  }

  for (const folderPath of [...folderSet].sort()) {
    const folderName = folderPath.split('/').pop() || folderPath;
    const folderQn = `${idx.project}.folder.${folderPath.replace(/\//g, '.')}`;
    let folderId = idx.qnToId.get(folderQn);
    if (!folderId) {
      const folderNode: LynxFolder = {
        project: idx.project,
        kind: 'Folder',
        name: folderName,
        qualifiedName: folderQn,
        filePath: folderPath,
        startLine: 0,
        endLine: 0,
        isExported: false,
        isTest: false,
        isEntryPoint: false,
      };
      folderId = upsertNode(db, folderNode);
      const row: NodeRef = {
        id: folderId,
        kind: 'Folder',
        name: folderName,
        qualified_name: folderQn,
        file_path: folderPath,
        start_line: 0,
        is_exported: 0,
        properties: null,
      };
      idx.qnToId.set(folderQn, folderId);
      idx.idToRow.set(folderId, row);
    }

    idx.folderToId.set(folderPath, folderId);
    const parentPath = folderPath.split('/').slice(0, -1).join('/');
    const parentId = parentPath ? idx.folderToId.get(parentPath) : undefined;
    if (parentId) addEdge(edges, idx.project, parentId, folderId, 'CONTAINS_FOLDER');
  }

  for (const batch of batches) {
    const fileNode = getFileNode(idx, batch.file.relPath);
    const parentDir = batch.file.relPath.split('/').slice(0, -1).join('/');
    const parentId = parentDir ? idx.folderToId.get(parentDir) : undefined;
    if (fileNode && parentId) addEdge(edges, idx.project, parentId, fileNode.id, 'CONTAINS_FILE');
  }
}
