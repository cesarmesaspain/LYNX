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
  const depth = args.depth ? Number(args.depth) : 3;
  const mode = (args.mode as string) || 'calls';
  const riskLabels = args.risk_labels === true;
  const includeTests = args.include_tests === true;
  const parameterName = args.parameter_name ? String(args.parameter_name) : undefined;
  const customEdgeTypes = args.edge_types as string[] | undefined;
  const maxResults = args.max_results ? Number(args.max_results) : 30;
  const page = args.page ? Number(args.page) : 0;
  const pageSize = args.page_size ? Number(args.page_size) : Math.min(maxResults, 12);
  const includeEdges = args.include_edges === true;

  const db = getDb(project);

  // Data retrieval: federated gateway if Team config present, else direct local core
  const fedConfig = getFederatedConfig();
  let root: { name: string; qualified_name: string; file_path: string; kind: string };
  let allCallers: TraceEntry[];
  let allCallees: TraceEntry[];
  let allEdges: TraceEdge[];
  let filteredCount: number;
  let maxHop: number;
  let totalCallers: number;
  let totalCallees: number;
  let provenanceSummary: Record<string, unknown> | undefined;

  if (fedConfig) {
    const fedResult = await federatedTracePath(db, {
      functionName, project,
      direction: direction as 'inbound' | 'outbound' | 'both',
      depth, mode, riskLabels, includeTests, customEdgeTypes,
      maxResults, page, pageSize,
    }, fedConfig);

    if (!fedResult) {
      const projectMeta = db.getProject(project);
      if (!projectMeta) return { ...projectNotIndexed(project) };
      const diag = noResults(functionName, 'function');
      return { ...diag, function_name: functionName };
    }

    root = fedResult.function;
    allCallers = fedResult.callers;
    allCallees = fedResult.callees;
    allEdges = fedResult.edges;
    filteredCount = fedResult.total_visited;
    maxHop = fedResult.max_depth;
    totalCallers = fedResult.pagination.total_callers;
    totalCallees = fedResult.pagination.total_callees;
    provenanceSummary = fedResult.provenance_summary as unknown as Record<string, unknown>;
  } else {
    const traceData = executeLocalTracePath(db, {
      functionName, project,
      direction: direction as 'inbound' | 'outbound' | 'both',
      depth, mode, riskLabels, includeTests, customEdgeTypes,
      maxResults, page, pageSize,
    });

    if (!traceData) {
      const projectMeta = db.getProject(project);
      if (!projectMeta) return { ...projectNotIndexed(project) };
      const diag = noResults(functionName, 'function');
      return { ...diag, function_name: functionName };
    }

    root = traceData.root;
    allCallers = traceData.callers;
    allCallees = traceData.callees;
    allEdges = traceData.edges;
    filteredCount = traceData.totalVisited;
    maxHop = traceData.maxHop;
    totalCallers = traceData.totalCallers;
    totalCallees = traceData.totalCallees;
  }

  // Convert TraceEntry[] to Record<string, unknown>[] for response building
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

  // Enrich entries with 1-line signatures to eliminate follow-up get_code_snippet calls.
  const projectMeta = db.getProject(project);
  const rootPath = projectMeta?.rootPath || process.cwd();
  const sigMap = new Map<string, string>();
  {
    const allQns = [...new Set([...allCallers, ...allCallees].map(e => e.qualified_name))];
    if (allQns.length > 0) {
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
          } catch { /* file unreadable — skip */ }
        }
      } catch { /* DB query failed — skip signatures */ }
    }
  }

  const callers: Record<string, unknown>[] = allCallers.map(e => toRecordEntry(e, sigMap.get(e.qualified_name)));
  const callees: Record<string, unknown>[] = allCallees.map(e => toRecordEntry(e, sigMap.get(e.qualified_name)));

  // Paginate
  const pagedCallers = callers.slice(page * pageSize, (page + 1) * pageSize);
  const pagedCallees = callees.slice(page * pageSize, (page + 1) * pageSize);

  const edges = allEdges.slice(0, pageSize).map((e: TraceEdge) => ({
    fromName: e.fromName,
    toName: e.toName,
    type: e.type,
  }));

  const narrative = narrateTraversal(
    root.name,
    filteredCount,
    maxHop,
    edges.map(e => ({ fromName: e.fromName, toName: e.toName }))
  );

  const response: Record<string, unknown> = {
    function: {
      name: root.name,
      qualified_name: root.qualified_name,
      file_path: root.file_path,
      kind: root.kind,
    },
    direction,
    mode,
    callers: pagedCallers,
    callees: pagedCallees,
    total_visited: filteredCount,
    max_depth: maxHop,
    path_summary: narrative.summary,
    deepest_path: narrative.deepestPath,
    pagination: {
      page,
      page_size: pageSize,
      total_callers: totalCallers,
      total_callees: totalCallees,
      callers_on_page: pagedCallers.length,
      callees_on_page: pagedCallees.length,
      has_more: (page + 1) * pageSize < Math.max(totalCallers, totalCallees),
    },
  };

  if (includeEdges) {
    response.edges = edges;
    response.edges_truncated = allEdges.length > edges.length;
  } else {
    response.edge_summary = {
      total_edges_seen: allEdges.length,
      omitted_by_default: true,
      hint: 'Pass include_edges=true to include a compact edge page.',
    };
  }

  // Truncation warning if results exceed max_results
  if (totalCallers > maxResults || totalCallees > maxResults) {
    response.truncated = true;
    response.max_results = maxResults;
  }

  if (provenanceSummary) {
    response.provenance_summary = provenanceSummary;
  }

  if (parameterName) {
    response.parameter_name = parameterName;
  }

  const value = estimateTokensSaved(filteredCount, filteredCount * 2);
  response.value_metrics = {
    estimated_files_avoided: value.filesAvoided,
    estimated_tokens_saved: value.tokensSaved,
    confidence: value.confidence,
    latency_ms: Date.now() - started,
  };
  const uniqueFiles = new Set(allCallers.map(v => v.file_path).concat(allCallees.map(v => v.file_path)));
  recordUsageEvent({
    type: 'trace_path',
    project,
    query: functionName,
    result_count: filteredCount,
    unique_files: uniqueFiles.size,
    files_avoided: value.filesAvoided,
    tokens_saved: value.tokensSaved,
    confidence: value.confidence,
    latency_ms: Date.now() - started,
    tool_hint: 'trace_path',
  });

  return response;
}
