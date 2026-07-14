/*
 * trace-core.ts — Pure trace path data retrieval core.
 *
 * Extracted from handleTracePath to avoid MCP coupling,
 * double metrics recording, and narrated-response merge issues.
 *
 * Takes a LynxDatabase + typed params. Returns structured data.
 * No metrics, narrative, or MCP serialization.
 */

import type { LynxDatabase } from '../store/database.js';
import { bfsTraverse } from '../store/traverse.js';
import { findNodeByQn } from '../store/nodes.js';
import type {
  FederatedTraceParams,
  TraceEntry,
  TraceEdge,
  TraceRoot,
  LocalTraceResult,
} from './types.js';

function hopToRisk(hop: number): string {
  if (hop === 1) return 'CRITICAL';
  if (hop === 2) return 'HIGH';
  if (hop === 3) return 'MEDIUM';
  return 'LOW';
}

export function edgeTypesForMode(mode: string): string[] {
  switch (mode) {
    case 'calls': return ['CALLS'];
    case 'references': return ['CALLS', 'READS', 'USAGE', 'REGISTRY_DISPATCH'];
    case 'data_flow': return ['CALLS', 'DATA_FLOWS', 'READS', 'USAGE', 'REGISTRY_DISPATCH'];
    case 'cross_service':
      return ['CALLS', 'HTTP_CALLS', 'ASYNC_CALLS', 'DATA_FLOWS',
              'CROSS_HTTP_CALLS', 'CROSS_ASYNC_CALLS', 'CROSS_CHANNEL',
              'CROSS_GRPC_CALLS', 'CROSS_GRAPHQL_CALLS', 'CROSS_TRPC_CALLS'];
    default: return ['CALLS'];
  }
}

function isTestFile(fp: string): boolean {
  return fp.includes('.test.') || fp.includes('.spec.') ||
         fp.includes('__tests__') || fp.includes('/test/');
}

/**
 * Pure core: execute a local trace without side effects.
 *
 * Returns null if the project is not indexed or the function is not found.
 * Callers handle diagnostics/metrics/narrative separately.
 *
 * Used by:
 *   - handleTracePath (when no Team config — identical to today)
 *   - LocalIndexProvider (called by FederatedGateway)
 */
export function executeLocalTracePath(
  db: LynxDatabase,
  params: FederatedTraceParams
): LocalTraceResult | null {
  const {
    functionName, project, direction, depth, mode,
    riskLabels, includeTests, customEdgeTypes,
    maxResults, page, pageSize,
  } = params;

  // Project must exist
  const projectMeta = db.getProject(project);
  if (!projectMeta) return null;

  // Find the starting node
  let nodeId: number | null = null;
  let resolvedKind = '';

  const exactMatch = findNodeByQn(db, project, functionName);
  if (exactMatch) {
    nodeId = exactMatch.id;
    resolvedKind = exactMatch.kind;
  }

  // Fuzzy fallback: find by exact name when QN lookup fails.
  // Uses a simple name match (not tokenized FTS) so "main" resolves but
  // "nonexistent_function_xyz" correctly returns nothing.
  if (!nodeId) {
    const nameMatch = db.db.prepare(
      `SELECT id, kind FROM nodes WHERE project = ? AND LOWER(name) = LOWER(?) AND kind IN ('Function', 'Method', 'Class') LIMIT 1`
    ).get(project, functionName) as { id: number; kind: string } | undefined;
    if (nameMatch) {
      nodeId = nameMatch.id;
      resolvedKind = nameMatch.kind;
    }
  }

  if (!nodeId) return null;

  let effectiveMode = mode === 'auto' ? 'calls' : mode;
  let edgeTypes = customEdgeTypes || edgeTypesForMode(effectiveMode);

  let traversal = bfsTraverse(
    db,
    nodeId,
    direction as 'inbound' | 'outbound' | 'both',
    edgeTypes,
    depth,
    maxResults * 3
  );

  if (!traversal) return null;

  // SwiftUI commonly expresses relevant dependencies through bindings and
  // state access.  Auto remains strict for all languages first; only a Swift
  // trace with no direct call edge expands to references, and the response
  // reports that expansion rather than presenting references as calls.
  if (mode === 'auto' && traversal.visited.length === 0 && /\.swift$/i.test(exactMatch?.file_path || '')) {
    effectiveMode = 'references';
    edgeTypes = customEdgeTypes || edgeTypesForMode(effectiveMode);
    traversal = bfsTraverse(
      db, nodeId, direction as 'inbound' | 'outbound' | 'both', edgeTypes, depth, maxResults * 3,
    );
    if (!traversal) return null;
  }

  const maxHop = traversal.visited.length > 0
    ? Math.max(...traversal.visited.map(v => v.hop))
    : 0;

  // Test file filter helper
  const testFilter = (fp: string) => includeTests || !isTestFile(fp);

  // Filter the first traversal visited (for maxHop/total_visited in 'both' case)
  const filtered = traversal.visited.filter(v => testFilter(v.node.filePath));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toEntry = (v: any): TraceEntry => {
    const entry: TraceEntry = {
      name: v.node.name,
      qualified_name: v.node.qualifiedName,
      file_path: v.node.filePath,
      hop: v.hop,
      provenance: 'local',
    };
    if (riskLabels) {
      entry.risk = hopToRisk(v.hop);
    }
    return entry;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filterAndMap = (visited: any[]): TraceEntry[] =>
    visited.filter((v: any) => testFilter(v.node.filePath)).map(toEntry);

  let callers: TraceEntry[] = [];
  let callees: TraceEntry[] = [];

  if (direction === 'both') {
    const inbound = bfsTraverse(db, nodeId, 'inbound', edgeTypes, depth, maxResults * 3);
    const outbound = bfsTraverse(db, nodeId, 'outbound', edgeTypes, depth, maxResults * 3);
    callers = inbound ? filterAndMap(inbound.visited) : [];
    callees = outbound ? filterAndMap(outbound.visited) : [];
  } else if (direction === 'inbound') {
    callers = filterAndMap(filtered);
  } else {
    callees = filterAndMap(filtered);
  }

  // Stable sort by hop
  callers.sort((a, b) => a.hop - b.hop);
  callees.sort((a, b) => a.hop - b.hop);

  const totalCallers = callers.length;
  const totalCallees = callees.length;

  // Keep the complete bounded traversal for relationship evidence and value
  // metrics. The MCP handler paginates presentation separately.
  const edges: TraceEdge[] = traversal.edges.map(e => ({
    fromName: e.fromName,
    toName: e.toName,
    type: e.type,
  }));

  const root: TraceRoot = {
    name: traversal.root.name,
    qualified_name: traversal.root.qualifiedName,
    file_path: traversal.root.filePath,
    kind: resolvedKind,
  };

  // Return structured data — no narrative, no metrics, no serialization
  return {
    root,
    direction,
    mode: effectiveMode,
    callers,
    callees,
    edges,
    totalVisited: filtered.length,
    maxHop,
    totalCallers,
    totalCallees,
    page,
    pageSize,
  };
}
