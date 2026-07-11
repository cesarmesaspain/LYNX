/*
 * traverse.ts — BFS graph traversal.
 *
 * Walks CALLS/HTTP_CALLS/ASYNC_CALLS edges from a starting node,
 * returning visited nodes with hop distances and edge info.
 */

import type { LynxDatabase } from './database.js';
import type { LynxNodeBase, LynxTraversal, LynxNodeHop, LynxEdgeInfo, LynxNodeKind } from '../types.js';

interface RawNode {
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
  hop: number;
}

interface RawEdge {
  source_id: number;
  target_id: number;
  type: string;
  from_name: string;
  to_name: string;
}

export function bfsTraverse(
  db: LynxDatabase,
  startId: number,
  direction: 'inbound' | 'outbound' | 'both',
  edgeTypes: string[] | null,
  maxDepth: number,
  maxResults: number
): LynxTraversal | null {
  const rootRow = db.db.prepare('SELECT * FROM nodes WHERE id = ?').get(startId) as {
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
  } | undefined;

  if (!rootRow) return null;

  const root: LynxNodeBase & { id: number } = {
    id: rootRow.id,
    project: rootRow.project,
    kind: rootRow.kind as LynxNodeKind,
    name: rootRow.name,
    qualifiedName: rootRow.qualified_name,
    filePath: rootRow.file_path,
    startLine: rootRow.start_line,
    endLine: rootRow.end_line,
    isExported: rootRow.is_exported === 1,
    isTest: rootRow.is_test === 1,
    isEntryPoint: rootRow.is_entry_point === 1,
  };

  const visited = new Map<number, number>(); // nodeId -> min hop
  const edges: LynxEdgeInfo[] = [];
  let queue: number[] = [startId];
  visited.set(startId, 0);

  const edgeFilter =
    edgeTypes && edgeTypes.length > 0
      ? `AND e.type IN (${edgeTypes.map(() => '?').join(',')})`
      : '';

  for (let depth = 0; depth < maxDepth; depth++) {
    const nextQueue: number[] = [];

    for (const currentId of queue) {
      const queries: string[] = [];

      if (direction === 'outbound' || direction === 'both') {
        queries.push(
          `SELECT e.source_id, e.target_id, e.type, ns.name as from_name, nt.name as to_name
           FROM edges e
           JOIN nodes ns ON e.source_id = ns.id
           JOIN nodes nt ON e.target_id = nt.id
           WHERE e.source_id = ? ${edgeFilter}`
        );
      }
      if (direction === 'inbound' || direction === 'both') {
        queries.push(
          `SELECT e.source_id, e.target_id, e.type, ns.name as from_name, nt.name as to_name
           FROM edges e
           JOIN nodes ns ON e.source_id = ns.id
           JOIN nodes nt ON e.target_id = nt.id
           WHERE e.target_id = ? ${edgeFilter}`
        );
      }

      for (const sql of queries) {
        const bindings: (number | string)[] = [currentId];
        if (edgeTypes && edgeTypes.length > 0) {
          bindings.push(...edgeTypes);
        }

        const edgeRows = db.db.prepare(sql).all(...bindings) as RawEdge[];
        for (const edge of edgeRows) {
          edges.push({
            sourceId: edge.source_id,
            targetId: edge.target_id,
            type: edge.type,
            fromName: edge.from_name,
            toName: edge.to_name,
          });

          const neighborId =
            edge.source_id === currentId ? edge.target_id : edge.source_id;
          if (!visited.has(neighborId)) {
            visited.set(neighborId, depth + 1);
            nextQueue.push(neighborId);
          }
        }
      }
    }

    queue = nextQueue;
    if (queue.length === 0) break;
    if (visited.size >= maxResults) break;
  }

  const visitedNodes: LynxNodeHop[] = [];
  let count = 0;
  for (const [nodeId, hop] of visited) {
    if (count >= maxResults) break;
    if (nodeId === startId) continue; // Skip root, added separately

    const nodeRow = db.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId) as RawNode | undefined;
    if (!nodeRow) continue;

    visitedNodes.push({
      node: {
        id: nodeRow.id,
        project: nodeRow.project,
        kind: nodeRow.kind as LynxNodeKind,
        name: nodeRow.name,
        qualifiedName: nodeRow.qualified_name,
        filePath: nodeRow.file_path,
        startLine: nodeRow.start_line,
        endLine: nodeRow.end_line,
        isExported: nodeRow.is_exported === 1,
        isTest: nodeRow.is_test === 1,
        isEntryPoint: nodeRow.is_entry_point === 1,
      },
      hop,
    });
    count++;
  }

  return { root, visited: visitedNodes, edges };
}

// ── Quick neighbors (names only, no BFS) ────────────────────────

export function getNeighborNames(
  db: LynxDatabase,
  nodeId: number,
  limit: number
): { callers: string[]; callees: string[] } {
  const callers = db.db
    .prepare(
      `SELECT DISTINCT ns.name FROM edges e
       JOIN nodes ns ON e.source_id = ns.id
       WHERE e.target_id = ? AND e.type IN ('CALLS', 'HTTP_CALLS', 'ASYNC_CALLS')
       LIMIT ?`
    )
    .all(nodeId, limit)
    .map((r: unknown) => (r as { name: string }).name);

  const callees = db.db
    .prepare(
      `SELECT DISTINCT nt.name FROM edges e
       JOIN nodes nt ON e.target_id = nt.id
       WHERE e.source_id = ? AND e.type IN ('CALLS', 'HTTP_CALLS', 'ASYNC_CALLS')
       LIMIT ?`
    )
    .all(nodeId, limit)
    .map((r: unknown) => (r as { name: string }).name);

  return { callers, callees };
}
