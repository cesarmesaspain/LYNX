/*
 * resolve/pass-definitions.ts — DEFINES and DEFINES_METHOD edges.
 */

import type { LynxEdge } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import type { ResolverIndexes } from './indexes.js';
import { addEdge, getFileNode, getFileNodes, findParentSymbol } from './utils.js';

/** Split a comma-separated list of type names, respecting angle-bracket nesting */
export function splitTypeList(raw: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '<') depth++;
    else if (raw[i] === '>') depth--;
    else if (raw[i] === ',' && depth === 0) {
      const name = raw.substring(start, i).trim().split(/\s+/)[0];
      if (name) names.push(name);
      start = i + 1;
    }
  }
  const last = raw.substring(start).trim().split(/\s+/)[0];
  if (last) names.push(last);
  return names.filter(Boolean);
}

export function passDefinitions(batches: ExtractionBatch[], idx: ResolverIndexes, edges: LynxEdge[]): void {
  for (const batch of batches) {
    const fileNode = getFileNode(idx, batch.file.relPath);
    if (!fileNode) continue;

    for (const node of getFileNodes(idx, batch.file.relPath)) {
      if (node.kind !== 'File' && node.kind !== 'Folder') {
        addEdge(edges, idx.project, fileNode.id, node.id, 'DEFINES');
      }

      if (node.kind === 'Function' || node.kind === 'Method') {
        const parent = findParentSymbol(idx, node);
        if (parent && (parent.kind === 'Class' || parent.kind === 'Interface' ||
            parent.kind === 'Type' || parent.kind === 'Enum')) {
          addEdge(edges, idx.project, parent.id, node.id, 'DEFINES_METHOD');
        }
      }
    }
  }
}
