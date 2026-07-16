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
import { estimateTokensFromFiles, recordUsageEvent } from '../../usage/metrics.js';
import { projectNotIndexed, noResults } from '../diagnostics.js';
import { executeLocalTracePath } from '../../federation/trace-core.js';
import { federatedTracePath } from '../../federation/gateway.js';
import { getFederatedConfig } from '../../federation/handler-bridge.js';
import type { TraceEntry, TraceEdge } from '../../federation/types.js';
import { readLynxConfig } from '../../config/runtime.js';
import { getBulkEdgeEvidence, classifyConfidence } from '../../store/edge-evidence.js';

export async function handleTracePath(args: Record<string, unknown>): Promise<unknown> {
  const started = Date.now();
  // `function_name` is canonical, but accept the identifier names exposed by
  // other discovery tools so a user can pass their result through directly.
  const functionName = String(
    args.function_name || args.qualified_name || args.symbol || args.name || '',
  );
  const project = String(args.project || '');
  const direction = (args.direction as string) || 'both';
  const savingsMode = readLynxConfig().agent_response?.enabled && readLynxConfig().agent_response?.budget === 'max_savings';
  const defaultDepth = savingsMode && args.risk_labels !== true ? 2 : 3;
  const rawDepth = args.depth !== undefined ? Number(args.depth) : defaultDepth;
  const depth = Number.isFinite(rawDepth) ? Math.max(1, Math.min(Math.floor(rawDepth), 10)) : defaultDepth;
  const requestedMode = (args.mode as string) || 'calls';
  const mode = ['calls', 'references', 'data_flow', 'cross_service', 'auto'].includes(requestedMode)
    ? requestedMode
    : 'calls';
  const riskLabels = args.risk_labels === true;
  const includeTests = args.include_tests === true;
  const parameterName = args.parameter_name ? String(args.parameter_name) : undefined;
  const customEdgeTypes = args.edge_types as string[] | undefined;
  const defaultMaxResults = savingsMode && args.risk_labels !== true ? 15 : 30;
  const rawMaxResults = args.max_results !== undefined ? Number(args.max_results) : defaultMaxResults;
  const maxResults = Number.isFinite(rawMaxResults) ? Math.max(1, Math.min(Math.floor(rawMaxResults), 100)) : defaultMaxResults;
  const rawPage = args.page !== undefined ? Number(args.page) : 0;
  const page = Number.isFinite(rawPage) ? Math.max(0, Math.floor(rawPage)) : 0;
  const defaultPageSize = savingsMode && args.risk_labels !== true ? 8 : 12;
  const rawPageSize = args.page_size !== undefined ? Number(args.page_size) : Math.min(maxResults, defaultPageSize);
  const pageSize = Number.isFinite(rawPageSize) ? Math.max(1, Math.min(Math.floor(rawPageSize), maxResults, 100)) : Math.min(maxResults, defaultPageSize);
  const includeEdges = args.include_edges === true;
  const includeEvidence = args.include_evidence === true;

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

  const { root, allCallers, allCallees, allEdges, filteredCount, maxHop, effectiveMode,
    totalCallers, totalCallees, provenanceSummary } = traceResult;

  // Enrich entries with 1-line signatures
  const sigMap = enrichSignatures(db, project, rootPath(db, project), allCallers, allCallees);
  const callers = allCallers.filter(entry => isLikelyCallableSignature(sigMap.get(entry.qualified_name)));
  const callees = allCallees.filter(entry => isLikelyCallableSignature(sigMap.get(entry.qualified_name)));
  const traceNames = new Set([root.name, ...callers.map(entry => entry.name), ...callees.map(entry => entry.name)]);
  const edges = allEdges.filter(edge => traceNames.has(edge.fromName) && traceNames.has(edge.toName));

  return buildTraceResponse({
    root, allCallers: callers, allCallees: callees, allEdges: edges, sigMap,
    direction, mode: effectiveMode, requestedMode, filteredCount: callers.length + callees.length, maxHop,
    totalCallers: callers.length, totalCallees: callees.length, provenanceSummary,
    page, pageSize, maxResults, includeEdges, includeEvidence, parameterName,
    project, functionName, started,
  });
}

/**
 * Graph extraction can occasionally classify a local value as a function.
 * When the source line is available, do not expose it as a call-path node
 * unless it has an invocable declaration shape. Missing source remains
 * permissive so traces for generated or unavailable files are unaffected.
 */
export function isLikelyCallableSignature(signature: string | undefined): boolean {
  if (!signature) return true;
  const source = signature.trim();
  return /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class)\b/.test(source)
    || /\bfunction\b/.test(source)
    || /=>/.test(source)
    // TS/JS class methods commonly carry accessibility/static decorators.
    || /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|readonly|abstract|declare|static|async|override|get|set)\s+)*[A-Za-z_$][\w$]*(?:<[^>{}]*>)?\s*\(/.test(source)
    // Swift declarations can carry attributes and many modifiers before func.
    || /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|fileprivate|internal|open|final|override|static|class|mutating|nonmutating|async|throws|rethrows|isolated|nonisolated)\s+)*func\s+[A-Za-z_]\w*/.test(source)
    || /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|fileprivate|internal|open|final|override|convenience|required)\s+)*(?:init|subscript)\s*(?:\?|\(|<)/.test(source)
    // Do not suppress valid graph paths merely because their source syntax is
    // not JavaScript-like. These patterns cover the callable declarations
    // emitted by the supported Python, JVM, Go, Rust, Ruby and PHP extractors.
    || /^(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/.test(source)
    || /^(?:(?:public|private|protected|static|final|abstract|synchronized|native|async)\s+)*(?:[A-Za-z_$][\w$<>\[\]?]*\s+)+[A-Za-z_$][\w$]*\s*\(/.test(source)
    || /^(?:suspend\s+)?fun\s+[A-Za-z_]\w*/.test(source)
    || /^(?:pub\s+)?(?:async\s+)?fn\s+[A-Za-z_]\w*/.test(source)
    || /^func\s+(?:\([^)]*\)\s+)?[A-Za-z_]\w*/.test(source)
    || /^def\s+[A-Za-z_]\w*/.test(source)
    || /^(?:(?:public|private|protected|static)\s+)*function\s+[A-Za-z_]\w*/.test(source);
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
  effectiveMode: string;
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
      effectiveMode: fedResult.mode,
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
    effectiveMode: traceData.mode,
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
  direction: string; mode: string; requestedMode: string;
  filteredCount: number; maxHop: number;
  totalCallers: number; totalCallees: number;
  provenanceSummary?: Record<string, unknown>;
  page: number; pageSize: number; maxResults: number;
  includeEdges: boolean; includeEvidence: boolean; parameterName?: string;
  project: string; functionName: string; started: number;
}

interface AggregatedTraceEdge extends TraceEdge {
  occurrenceCount: number;
}

/**
 * A call graph can legitimately contain several call sites between the same
 * two symbols. Present that as one relationship with an occurrence count,
 * while retaining every captured evidence location for the relationship.
 */
export function aggregateTraceEdges(edges: TraceEdge[]): AggregatedTraceEdge[] {
  const grouped = new Map<string, AggregatedTraceEdge>();
  for (const edge of edges) {
    const key = `${edge.fromName}\u0000${edge.toName}\u0000${edge.type}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.occurrenceCount += 1;
    } else {
      grouped.set(key, { ...edge, occurrenceCount: 1 });
    }
  }
  return [...grouped.values()];
}

function buildTraceResponse(p: BuildTraceResponseParams): Record<string, unknown> {
  const aggregatedEdges = aggregateTraceEdges(p.allEdges);
  const relationshipFor = (entry: TraceEntry): { types: string[]; kind: string } => {
    const types = [...new Set(p.allEdges
      .filter(edge => edge.fromName === entry.name || edge.toName === entry.name)
      .map(edge => edge.type))];
    return { types, kind: types.includes('CALLS') ? 'direct_call' : 'reference' };
  };
  const toRecordEntry = (e: TraceEntry, sig?: string): Record<string, unknown> => {
    const entry: Record<string, unknown> = {
      name: e.name,
      qualified_name: e.qualified_name,
      file_path: e.file_path,
      hop: e.hop,
    };
    const relationship = relationshipFor(e);
    if (relationship.types.length > 0) {
      entry.relationship_types = relationship.types;
      entry.relationship_kind = relationship.kind;
    }
    if (e.risk) entry.risk = e.risk;
    if (sig) entry.signature = sig;
    return entry;
  };

  const callers = p.allCallers.map(e => toRecordEntry(e, p.sigMap.get(e.qualified_name)));
  const callees = p.allCallees.map(e => toRecordEntry(e, p.sigMap.get(e.qualified_name)));

  // Paginate
  const pagedCallers = callers.slice(p.page * p.pageSize, (p.page + 1) * p.pageSize);
  const pagedCallees = callees.slice(p.page * p.pageSize, (p.page + 1) * p.pageSize);

  const edges = aggregatedEdges.slice(0, p.pageSize).map((e: AggregatedTraceEdge) => ({
    fromName: e.fromName, toName: e.toName, type: e.type,
    ...(e.occurrenceCount > 1 ? { occurrence_count: e.occurrenceCount } : {}),
  }));

  // ── Evidence enrichment (improvement #2) ──────────────────
  let edgeEvidenceMap: Map<string, Array<Record<string, unknown>>> | undefined;
  if (p.includeEvidence) {
    edgeEvidenceMap = new Map();
    try {
      const evidenceDb = getDb(p.project);
      // Batch lookup edge IDs from (fromName, toName, type)
      const uniqueEdges = new Map<string, AggregatedTraceEdge>();
      for (const e of aggregatedEdges) uniqueEdges.set(`${e.fromName}|${e.toName}|${e.type}`, e);
      const edgeIds: number[] = [];
      const edgeIdsByKey = new Map<string, number[]>();
      for (const [key, e] of uniqueEdges) {
        const rows = evidenceDb.db.prepare(
          `SELECT e.id FROM edges e
           JOIN nodes ns ON e.source_id = ns.id
           JOIN nodes nt ON e.target_id = nt.id
           WHERE e.project = ? AND ns.name = ? AND nt.name = ? AND e.type = ?
           ORDER BY e.id`
        ).all(p.project, e.fromName, e.toName, e.type) as Array<{ id: number }>;
        if (rows.length > 0) {
          const ids = rows.map(row => row.id);
          edgeIds.push(...ids);
          edgeIdsByKey.set(key, ids);
        }
      }
      if (edgeIds.length > 0) {
        const rawEvidence = getBulkEdgeEvidence(evidenceDb, p.project, edgeIds);
        // Convert all call-site records to a relationship-keyed map.
        for (const [key, ids] of edgeIdsByKey) {
          const compactRecords = ids.flatMap(id => (rawEvidence.get(id) || []).map(r => ({
                evidence_type: r.evidence_type,
                source_path: r.source_path,
                start_line: r.start_line,
                end_line: r.end_line,
                extractor: r.extractor,
                confidence_tier: r.confidence_tier,
                strength: r.strength,
                location: r.source_path
                  ? `${r.source_path}${r.start_line ? `:${r.start_line}${r.end_line && r.end_line !== r.start_line ? `-${r.end_line}` : ''}` : ''}`
                  : null,
                payload: r.payload,
              })));
          edgeEvidenceMap.set(key, compactRecords as Array<Record<string, unknown>>);
        }
      }
    } catch { /* evidence unavailable — omit gracefully */ }
  }

  // Enrich edges with evidence annotations
  const enrichedEdges = edgeEvidenceMap
    ? edges.map(e => {
        const evidenceRecords = edgeEvidenceMap!.get(`${e.fromName}|${e.toName}|${e.type}`);
        return {
          ...e,
          ...(evidenceRecords && evidenceRecords.length > 0
            ? { evidence: evidenceRecords }
            : {}),
        };
      })
    : edges;

  // ── Response building ──────────────────────────────────────
  // Use enriched or plain edges for the narrative (names suffice)
  const responseEdges = p.includeEvidence ? enrichedEdges : edges;
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
    response.edges = responseEdges;
    response.edges_truncated = aggregatedEdges.length > edges.length;
  } else {
    response.edge_summary = {
      total_edges_seen: p.allEdges.length,
      unique_relationships_seen: aggregatedEdges.length,
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

  const uniqueFiles = [...new Set(
    p.allCallers.map(v => v.file_path).concat(p.allCallees.map(v => v.file_path))
  )];
  const fullFileValue = estimateTokensFromFiles(uniqueFiles, rootPath(getDb(p.project), p.project), p.project);
  // A trace returns names, signatures and relationships, not full files. Its
  // observed value is the incremental manual inspection avoided; full source
  // volume remains an explicit potential upper bound for consumers who would
  // otherwise have opened every involved file.
  const observedTokens = p.filteredCount === 0 ? 0 : Math.min(
    fullFileValue.tokensSaved,
    p.filteredCount * 220 + uniqueFiles.length * 80,
  );
  const value = {
    filesAvoided: uniqueFiles.length,
    tokensSaved: observedTokens,
    confidence: fullFileValue.confidence,
  };
  response.value_metrics = {
    estimated_files_avoided: value.filesAvoided,
    estimated_tokens_saved: value.tokensSaved,
    confidence: value.confidence,
    full_file_potential_tokens: fullFileValue.tokensSaved,
    measurement: 'incremental_trace_context',
    latency_ms: Date.now() - p.started,
  };

  const edgeCounts = p.allEdges.reduce<Record<string, number>>((counts, edge) => {
    counts[edge.type] = (counts[edge.type] || 0) + 1;
    return counts;
  }, {});
  response.relationship_profile = {
    requested: p.requestedMode,
    effective: p.mode,
    edge_types: Object.keys(edgeCounts),
    edge_counts: edgeCounts,
  };
  recordUsageEvent({
    type: 'trace_path',
    project: p.project,
    query: p.functionName,
    result_count: p.filteredCount,
    unique_files: uniqueFiles.length,
    files_avoided: value.filesAvoided,
    tokens_saved: value.tokensSaved,
    confidence: value.confidence,
    latency_ms: Date.now() - p.started,
    tool_hint: 'trace_path',
  });

  return response;
}
