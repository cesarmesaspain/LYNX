/*
 * trace_path.ts — Trace call/data_flow/cross_service paths through the graph.
 *
 * Capabilities:
 *   - risk_labels: hop_to_risk (hop=1→CRITICAL, 2→HIGH, 3→MED, 4+→LOW)
 *   - include_tests: filter test files in/out
 *   - mode: calls | data_flow | cross_service with correct edge type selection
 *   - parameter_name: scope data_flow to a specific parameter
 *   - edge_types: custom edge type filter array
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDb } from '../server.js';
import type { LynxDatabase } from '../../store/database.js';
import { narrateTraversal } from '../../intelligence/narrative.js';
import { estimateTokensSaved, recordUsageEvent } from '../../usage/metrics.js';
import { projectNotIndexed, noResults } from '../diagnostics.js';
import { executeLocalTracePath } from '../../federation/trace-core.js';
import { federatedTracePath } from '../../federation/gateway.js';
import { getFederatedConfig } from '../../federation/handler-bridge.js';
import type { TraceEntry, TraceEdge } from '../../federation/types.js';

export async function handleTracePath(args: Record<string, unknown>): Promise<unknown> {
  const started = Date.now();
  const functionName = String(args.function_name || '');
  const project = String(args.project || '');
  const direction = (args.direction as string) || 'both';
  const depth = args.depth !== undefined ? Number(args.depth) : 3;
  const mode = (args.mode as string) || 'calls';
  const riskLabels = args.risk_labels === true;
  const includeTests = args.include_tests === true;
  const parameterName = args.parameter_name ? String(args.parameter_name) : undefined;
  const customEdgeTypes = args.edge_types as string[] | undefined;
  const maxResults = args.max_results !== undefined ? Number(args.max_results) : 30;
  const page = args.page !== undefined ? Number(args.page) : 0;
  const pageSize = args.page_size !== undefined ? Number(args.page_size) : Math.min(maxResults, 12);
  const includeEdges = args.include_edges === true;

  const db = getDb(project);

  // Data retrieval: federated gateway if Team config present, else direct local core
  const traceResult = await fetchTraceData(db, {
    functionName, project, direction, depth, mode, riskLabels,
    includeTests, customEdgeTypes, maxResults, page, pageSize,
  });

  if (!traceResult) {
    const projectMeta = db.getProject(project);
    if (!projectMeta) return { ...projectNotIndexed(project) };
    return { ...noResults(functionName, 'function'), function_name: functionName };
  }

  const { root, allCallers, allCallees, allEdges, filteredCount, maxHop,
    totalCallers, totalCallees, provenanceSummary } = traceResult;

  // Enrich entries with 1-line signatures
  const sigMap = enrichSignatures(db, project, rootPath(db, project), allCallers, allCallees);

  return buildTraceResponse({
    root, allCallers, allCallees, allEdges, sigMap,
    direction, mode, filteredCount, maxHop,
    totalCallers, totalCallees, provenanceSummary,
    page, pageSize, maxResults, includeEdges, parameterName,
    project, functionName, started,
  });
}

// ── Data retrieval ─────────────────────────────────────

interface TraceFetchParams {
  functionName: string; project: string;
  direction: string; depth: number; mode: string;
  riskLabels: boolean; includeTests: boolean;
  customEdgeTypes?: string[]; maxResults: number; page: number; pageSize: number;
}

interface TraceFetchResult {
  root: { name: string; qualified_name: string; file_path: string; kind: string };
  allCallers: TraceEntry[];
  allCallees: TraceEntry[];
  allEdges: TraceEdge[];
  filteredCount: number;
  maxHop: number;
  totalCallers: number;
  totalCallees: number;
  provenanceSummary?: Record<string, unknown>;
}

async function fetchTraceData(
  db: LynxDatabase,
  p: TraceFetchParams,
): Promise<TraceFetchResult | null> {
  const fedConfig = getFederatedConfig();

  if (fedConfig) {
    const fedResult = await federatedTracePath(db, {
      functionName: p.functionName, project: p.project,
      direction: p.direction as 'inbound' | 'outbound' | 'both',
      depth: p.depth, mode: p.mode, riskLabels: p.riskLabels,
      includeTests: p.includeTests, customEdgeTypes: p.customEdgeTypes,
      maxResults: p.maxResults, page: p.page, pageSize: p.pageSize,
    }, fedConfig);

    if (!fedResult) return null;

    return {
      root: fedResult.function,
      allCallers: fedResult.callers,
      allCallees: fedResult.callees,
      allEdges: fedResult.edges,
      filteredCount: fedResult.total_visited,
      maxHop: fedResult.max_depth,
      totalCallers: fedResult.pagination.total_callers,
      totalCallees: fedResult.pagination.total_callees,
      provenanceSummary: fedResult.provenance_summary as unknown as Record<string, unknown>,
    };
  }

  const traceData = executeLocalTracePath(db, {
    functionName: p.functionName, project: p.project,
    direction: p.direction as 'inbound' | 'outbound' | 'both',
    depth: p.depth, mode: p.mode, riskLabels: p.riskLabels,
    includeTests: p.includeTests, customEdgeTypes: p.customEdgeTypes,
    maxResults: p.maxResults, page: p.page, pageSize: p.pageSize,
  });

  if (!traceData) return null;

  return {
    root: traceData.root,
    allCallers: traceData.callers,
    allCallees: traceData.callees,
    allEdges: traceData.edges,
    filteredCount: traceData.totalVisited,
    maxHop: traceData.maxHop,
    totalCallers: traceData.totalCallers,
    totalCallees: traceData.totalCallees,
  };
}

function rootPath(db: LynxDatabase, project: string): string {
  const meta = db.getProject(project);
  return meta?.rootPath || process.cwd();
}

// ── Signature enrichment ───────────────────────────────

function enrichSignatures(
  db: LynxDatabase,
  project: string,
  rootPath: string,
  allCallers: TraceEntry[],
  allCallees: TraceEntry[],
): Map<string, string> {
  const sigMap = new Map<string, string>();
  const allQns = [...new Set([...allCallers, ...allCallees].map(e => e.qualified_name))];

  if (allQns.length === 0) return sigMap;

  try {
    const placeholders = allQns.map(() => '?').join(',');
    const rows = db.db.prepare(
      `SELECT qualified_name, start_line, file_path FROM nodes WHERE project = ? AND qualified_name IN (${placeholders})`
    ).all(project, ...allQns) as Array<{ qualified_name: string; start_line: number; file_path: string }>;

    // Group by file to minimize I/O
    const byFile = new Map<string, { qn: string; line: number }[]>();
    for (const row of rows) {
      if (!byFile.has(row.file_path)) byFile.set(row.file_path, []);
      byFile.get(row.file_path)!.push({ qn: row.qualified_name, line: row.start_line });
    }

    for (const [fp, entries] of byFile) {
      try {
        const fullPath = path.join(rootPath, fp);
        const source = fs.readFileSync(fullPath, 'utf-8');
        const lines = source.split('\n');
        for (const e of entries) {
          const lineIdx = Math.max(0, e.line - 1);
          if (lineIdx < lines.length) {
            sigMap.set(e.qn, lines[lineIdx].trim());
          }
        }
      } catch { /* file unreadable */ }
    }
  } catch { /* DB query failed */ }

  return sigMap;
}

// ── Response building ──────────────────────────────────

interface BuildTraceResponseParams {
  root: { name: string; qualified_name: string; file_path: string; kind: string };
  allCallers: TraceEntry[]; allCallees: TraceEntry[]; allEdges: TraceEdge[];
  sigMap: Map<string, string>;
  direction: string; mode: string;
  filteredCount: number; maxHop: number;
  totalCallers: number; totalCallees: number;
  provenanceSummary?: Record<string, unknown>;
  page: number; pageSize: number; maxResults: number;
  includeEdges: boolean; parameterName?: string;
  project: string; functionName: string; started: number;
}

function buildTraceResponse(p: BuildTraceResponseParams): Record<string, unknown> {
  const toRecordEntry = (e: TraceEntry, sig?: string): Record<string, unknown> => {
    const entry: Record<string, unknown> = {
      name: e.name,
      qualified_name: e.qualified_name,
      file_path: e.file_path,
      hop: e.hop,
    };
    if (e.risk) entry.risk = e.risk;
    if (sig) entry.signature = sig;
    return entry;
  };

  const callers = p.allCallers.map(e => toRecordEntry(e, p.sigMap.get(e.qualified_name)));
  const callees = p.allCallees.map(e => toRecordEntry(e, p.sigMap.get(e.qualified_name)));

  // Paginate
  const pagedCallers = callers.slice(p.page * p.pageSize, (p.page + 1) * p.pageSize);
  const pagedCallees = callees.slice(p.page * p.pageSize, (p.page + 1) * p.pageSize);

  const edges = p.allEdges.slice(0, p.pageSize).map((e: TraceEdge) => ({
    fromName: e.fromName, toName: e.toName, type: e.type,
  }));

  const narrative = narrateTraversal(
    p.root.name, p.filteredCount, p.maxHop,
    edges.map(e => ({ fromName: e.fromName, toName: e.toName }))
  );

  const response: Record<string, unknown> = {
    function: {
      name: p.root.name,
      qualified_name: p.root.qualified_name,
      file_path: p.root.file_path,
      kind: p.root.kind,
    },
    direction: p.direction,
    mode: p.mode,
    callers: pagedCallers,
    callees: pagedCallees,
    total_visited: p.filteredCount,
    max_depth: p.maxHop,
    path_summary: narrative.summary,
    deepest_path: narrative.deepestPath,
    pagination: {
      page: p.page,
      page_size: p.pageSize,
      total_callers: p.totalCallers,
      total_callees: p.totalCallees,
      callers_on_page: pagedCallers.length,
      callees_on_page: pagedCallees.length,
      has_more: (p.page + 1) * p.pageSize < Math.max(p.totalCallers, p.totalCallees),
    },
  };

  if (p.includeEdges) {
    response.edges = edges;
    response.edges_truncated = p.allEdges.length > edges.length;
  } else {
    response.edge_summary = {
      total_edges_seen: p.allEdges.length,
      omitted_by_default: true,
      hint: 'Pass include_edges=true to include a compact edge page.',
    };
  }

  if (p.totalCallers > p.maxResults || p.totalCallees > p.maxResults) {
    response.truncated = true;
    response.max_results = p.maxResults;
  }

  if (p.provenanceSummary) {
    response.provenance_summary = p.provenanceSummary;
  }

  if (p.parameterName) {
    response.parameter_name = p.parameterName;
  }

  const value = estimateTokensSaved(p.filteredCount, p.filteredCount * 2);
  response.value_metrics = {
    estimated_files_avoided: value.filesAvoided,
    estimated_tokens_saved: value.tokensSaved,
    confidence: value.confidence,
    latency_ms: Date.now() - p.started,
  };

  const uniqueFiles = new Set(
    p.allCallers.map(v => v.file_path).concat(p.allCallees.map(v => v.file_path))
  );
  recordUsageEvent({
    type: 'trace_path',
    project: p.project,
    query: p.functionName,
    result_count: p.filteredCount,
    unique_files: uniqueFiles.size,
    files_avoided: value.filesAvoided,
    tokens_saved: value.tokensSaved,
    confidence: value.confidence,
    latency_ms: Date.now() - p.started,
    tool_hint: 'trace_path',
  });

  return response;
}
