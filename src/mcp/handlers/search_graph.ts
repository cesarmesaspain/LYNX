/*
 * search_graph.ts — Graph search with full-text, regex, and structured filtering.
 *
 * Capabilities:
 *   - name_pattern, qn_pattern, file_pattern for regex matching
 *   - min_degree / max_degree for fan-in/out filtering
 *   - exclude_entry_points for filtering entry points
 *   - has_more pagination flag
 *   - semantic_query placeholder (vector search requires embeddings index)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDb } from '../server.js';
import { narrateSearchResults } from '../../intelligence/narrative.js';
import { getRerankProviderMode, rerankSearchWithMeta, type LlmUsage } from '../../llm/client.js';
import { estimateRerankCostUsd, estimateTokensSaved, recordUsageEvent } from '../../usage/metrics.js';
import { computeRealSavings } from '../../usage/session.js';
import { projectNotIndexed } from '../diagnostics.js';
import { executeLocalSearchGraph } from '../../federation/search-core.js';
import { federatedSearchGraph } from '../../federation/gateway.js';
import { getFederatedConfig } from '../../federation/handler-bridge.js';
import type { SearchNode } from '../../federation/types.js';
import type { LynxDatabase } from '../../store/database.js';
import { hasCapability } from '../../commercial/gate.js';

// ═══════════════════════════════════════════════════════════════
// Private helpers
// ═══════════════════════════════════════════════════════════════

interface RerankResult {
  deduped: SearchNode[];
  llmReranked: boolean;
  llmMetrics?: Record<string, unknown>;
  llmUsage: LlmUsage;
}

/** Apply LLM semantic re-rank to search results when applicable. */
async function applyLlmRerank(
  db: LynxDatabase,
  project: string,
  deduped: SearchNode[],
  query: string | undefined,
  enableLlm: boolean,
): Promise<RerankResult> {
  const llmUsage: LlmUsage = {
    enabled: enableLlm,
    used: false,
    provider: null,
    model: null,
    calls: 0,
    latency_ms: 0,
    fallback_used: false,
    fallback_reason: null,
  };

  if (!enableLlm || !query || deduped.length < 3) {
    if (!enableLlm) llmUsage.fallback_reason = 'enable_llm=false, skipped rerank';
    return { deduped, llmReranked: false, llmUsage };
  }

  try {
    const requestedProvider = getRerankProviderMode();
    const llmStart = Date.now();
    const originalOrder = deduped.map(r => r.qualified_name);

    const qnames = deduped.map(r => r.qualified_name);
    const placeholders = qnames.map(() => '?').join(',');
    const propRows = db.db
      .prepare(`SELECT qualified_name, properties FROM nodes WHERE project = ? AND qualified_name IN (${placeholders})`)
      .all(project, ...qnames) as Array<{ qualified_name: string; properties: string | null }>;
    const propsMap = new Map<string, string | null>();
    for (const pr of propRows) propsMap.set(pr.qualified_name, pr.properties);

    const candidates = deduped.map((r, i) => {
      let summary = '';
      try { const props = JSON.parse(propsMap.get(r.qualified_name) || '{}'); summary = props.llmSummary || ''; } catch { /* empty */ }
      const context = summary
        ? `${r.kind} \`${r.name}\` in ${r.file_path}:${r.start_line} — ${summary}`
        : `${r.kind} \`${r.name}\` in ${r.file_path}:${r.start_line}`;
      return { index: i, name: r.name, kind: r.kind, snippet: context };
    });

    const { items: ranked, provider, model, fallback } = await rerankSearchWithMeta(query, candidates);
    const llmLatency = Date.now() - llmStart;

    llmUsage.used = true;
    llmUsage.calls = 1;
    llmUsage.latency_ms = llmLatency;
    llmUsage.provider = provider;
    llmUsage.model = model || null;
    llmUsage.fallback_used = fallback;
    llmUsage.fallback_reason = fallback
      ? (provider === 'heuristic' && requestedProvider !== 'heuristic'
          ? `${requestedProvider} rerank failed after ${llmLatency}ms, used heuristic — kept BM25 order`
          : `${provider} rerank used — kept deterministic order`)
      : null;

    let llmReranked = false;
    let llmMetrics: Record<string, unknown> | undefined;

    if (ranked.length === deduped.length) {
      const reordered = ranked
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .map(r => deduped[r.index])
        .filter(Boolean);
      if (reordered.length === deduped.length) {
        const nextOrder = reordered.map(r => r.qualified_name);
        const rankChanged = nextOrder.some((qn, i) => qn !== originalOrder[i]);
        const topChanged = nextOrder[0] !== originalOrder[0];
        deduped = reordered;
        llmReranked = provider !== 'heuristic';
        llmMetrics = {
          provider, model: model || undefined, candidates: candidates.length,
          latency_ms: llmLatency, rank_changed: rankChanged, top_changed: topChanged,
          estimated_cost_usd: provider === 'heuristic' ? 0 : estimateRerankCostUsd(candidates.length),
          fallback,
        };
        recordUsageEvent({
          type: 'llm_rerank', project, query, result_count: candidates.length,
          latency_ms: llmLatency, llm_provider: provider, llm_latency_ms: llmLatency,
          estimated_llm_cost_usd: provider === 'heuristic' ? 0 : estimateRerankCostUsd(candidates.length),
          rank_changed: rankChanged, top_changed: topChanged, tool_hint: 'search_graph rerank',
        });
      }
    }

    return { deduped, llmReranked, llmMetrics, llmUsage };
  } catch {
    llmUsage.fallback_used = true;
    llmUsage.fallback_reason = `rerank exception (provider: ${getRerankProviderMode()}), kept BM25 order`;
    return { deduped, llmReranked: false, llmUsage };
  }
}

/** Inject source snippets into results by reading the first 5 lines of each file. */
function injectSnippets(
  db: LynxDatabase,
  project: string,
  resultsArray: Record<string, unknown>[],
): void {
  if (resultsArray.length === 0) return;
  const projectMeta = db.getProject(project);
  const rootPath = projectMeta?.rootPath || process.cwd();
  const byFile = new Map<string, { idx: number; start: number; end: number }[]>();
  resultsArray.forEach((r, i) => {
    const fp = String(r.file);
    if (!byFile.has(fp)) byFile.set(fp, []);
    byFile.get(fp)!.push({ idx: i, start: Number(r.start_line), end: Number(r.end_line) });
  });
  for (const [fp, entries] of byFile) {
    try {
      const fullPath = path.join(rootPath, fp);
      const source = fs.readFileSync(fullPath, 'utf-8');
      const lines = source.split('\n');
      for (const e of entries) {
        const start = Math.max(0, e.start - 1);
        const end = Math.min(lines.length, start + 5);
        (resultsArray[e.idx] as Record<string, unknown>).snippet = lines.slice(start, end).join('\n');
      }
    } catch { /* File unreadable */ }
  }
}

// ═══════════════════════════════════════════════════════════════
// Argument parsing
// ═══════════════════════════════════════════════════════════════

interface SearchGraphArgs {
  project: string;
  query: string | undefined;
  label: string | undefined;
  namePattern: string | undefined;
  qnPattern: string | undefined;
  nameLike: string | undefined;
  qnLike: string | undefined;
  filePattern: string | undefined;
  limit: number;
  offset: number;
  minDegree: number | undefined;
  maxDegree: number | undefined;
  excludeEntryPoints: boolean;
  includeNarrative: boolean;
  semanticQuery: string[] | undefined;
  enableLlm: boolean;
  includeSnippets: boolean;
}

function parseSearchGraphArgs(args: Record<string, unknown>): SearchGraphArgs | { error: string } {
  const query = args.query ? String(args.query) : undefined;
  if (query === '') return { error: 'query must not be empty. Provide at least one search term, or use name_pattern/qn_pattern for structural queries.' };
  const limit = args.limit !== undefined ? Number(args.limit) : 10;
  return {
    project: String(args.project || ''),
    query,
    label: args.label ? String(args.label) : undefined,
    namePattern: args.name_pattern ? String(args.name_pattern) : undefined,
    qnPattern: args.qn_pattern ? String(args.qn_pattern) : undefined,
    nameLike: args.name_like ? String(args.name_like) : undefined,
    qnLike: args.qn_like ? String(args.qn_like) : undefined,
    filePattern: args.file_pattern ? String(args.file_pattern) : undefined,
    limit,
    offset: args.offset !== undefined ? Number(args.offset) : 0,
    minDegree: args.min_degree !== undefined ? Number(args.min_degree) : undefined,
    maxDegree: args.max_degree !== undefined ? Number(args.max_degree) : undefined,
    excludeEntryPoints: args.exclude_entry_points === true,
    includeNarrative: args.narrative !== false,
    semanticQuery: args.semantic_query as string[] | undefined,
    enableLlm: args.enable_llm !== false,
    includeSnippets: args.include_snippets === true || (args.include_snippets !== false && limit <= 5),
  };
}

// ═══════════════════════════════════════════════════════════════
// Response building
// ═══════════════════════════════════════════════════════════════

function buildSearchResponse(
  a: SearchGraphArgs,
  started: number,
  deduped: SearchNode[],
  total: number,
  provenanceSummary: Record<string, unknown> | undefined,
  projectCheck: ReturnType<typeof import('../diagnostics.js').projectNotIndexed> | null,
  llmReranked: boolean,
  llmMetrics: Record<string, unknown> | undefined,
  llmUsage: LlmUsage,
  db: LynxDatabase,
  project: string,
): Record<string, unknown> {
  const hasMore = a.offset + a.limit < total;
  const limitedResults = deduped.slice(a.offset, a.offset + a.limit);
  const resultsArray = limitedResults.map(r => {
    const item: Record<string, unknown> = {
      name: r.name,
      qualified_name: r.qualified_name,
      kind: r.kind,
      file: r.file_path,
      start_line: r.start_line,
      end_line: r.end_line,
      in_degree: r.in_degree,
      out_degree: r.out_degree,
    };
    if (r.is_entry_point) item.is_entry_point = true;
    if (r.is_test) item.is_test = true;
    return item;
  });

  if (a.includeSnippets && resultsArray.length > 0) {
    injectSnippets(db, project, resultsArray);
  }

  const response: Record<string, unknown> = {
    results: resultsArray,
    total,
    has_more: hasMore,
    match_status: total === 0 ? 'no_indexed_match' : 'matches_found',
  };

  if (total === 0 && a.query) {
    response.no_match_guidance = {
      requested_query: a.query,
      inference: 'No indexed symbol matched the requested concept. Do not relabel an unrelated workflow as the requested domain.',
      next_step: 'Run at most one exact search_code check for the key domain noun. If it is also empty, report that the project contains insufficient evidence for the requested feature.',
    };
  }

  if (projectCheck) response.diagnostic = projectCheck;
  if (provenanceSummary) response.provenance_summary = provenanceSummary;

  const value = estimateTokensSaved(resultsArray.length, Math.max(total, resultsArray.length));
  response.value_metrics = {
    measurement: 'estimated',
    estimated_files_avoided: value.filesAvoided,
    estimated_tokens_saved: value.tokensSaved,
    confidence: value.confidence,
    latency_ms: Date.now() - started,
  };

  try {
    const meta = db.getProject(project);
    if (meta) {
      const real = computeRealSavings(project, meta.rootPath, meta.rootPath);
      if (real.tokensSaved > 0) {
        (response.value_metrics as Record<string, unknown>).observed_measurement = 'session_file_reads';
        (response.value_metrics as Record<string, unknown>).observed_files_avoided = real.filesAvoided;
        (response.value_metrics as Record<string, unknown>).observed_tokens_saved = real.tokensSaved;
        (response.value_metrics as Record<string, unknown>).observed_suggestions_resolved = real.suggestionsResolved;
        (response.value_metrics as Record<string, unknown>).real_files_avoided = real.filesAvoided;
        (response.value_metrics as Record<string, unknown>).real_tokens_saved = real.tokensSaved;
        (response.value_metrics as Record<string, unknown>).real_confidence =
          real.suggestionsResolved >= 2 ? 'high' : real.suggestionsResolved >= 1 ? 'medium' : 'low';
      }
    }
  } catch { /* Session tracking is best-effort */ }

  if (llmReranked) response.llm_reranked = true;
  if (llmMetrics) response.llm_metrics = llmMetrics;
  response.llm_usage = llmUsage;

  if (a.semanticQuery && a.semanticQuery.length > 0) {
    response.semantic_query = a.semanticQuery;
    response.semantic_note =
      'semantic_query received but vector search is not yet active. ' +
      'Results are from text/regex matching. ' +
      'Install embeddings index for cosine search.';
  }

  if (a.includeNarrative && a.query) {
    const narrative = narrateSearchResults(
      limitedResults.map(r => ({
        node: {
          id: 0, project, kind: r.kind as never, name: r.name,
          qualifiedName: r.qualified_name, filePath: r.file_path,
          startLine: r.start_line, endLine: r.end_line,
          isExported: false, isTest: r.is_test, isEntryPoint: r.is_entry_point,
        },
      })),
      total, a.query,
    );
    response.narrative = narrative.summary;
    response.top3 = narrative.top3;
  }

  return response;
}

// ═══════════════════════════════════════════════════════════════
// Handler
// ═══════════════════════════════════════════════════════════════

export async function handleSearchGraph(args: Record<string, unknown>): Promise<unknown> {
  const started = Date.now();
  const parsed = parseSearchGraphArgs(args);
  if ('error' in parsed) return parsed;

  let { project, query, label, namePattern, qnPattern, nameLike, qnLike, filePattern,
        limit, offset, minDegree, maxDegree, excludeEntryPoints,
        semanticQuery, enableLlm } = parsed;

  // Free tier: LLM rerank degrades to heuristic silently
  if (enableLlm && !hasCapability('semantic_rerank')) {
    enableLlm = false;
  }

  const db = getDb(project);

  const projectCheck = db.getProject(project) ? null : projectNotIndexed(project);

  // Data retrieval: federated gateway or direct local core
  const fedConfig = getFederatedConfig();
  let deduped: SearchNode[];
  let total: number;
  let provenanceSummary: Record<string, unknown> | undefined;

  const searchParams = {
    project, query, label, namePattern, qnPattern, nameLike, qnLike, filePattern,
    limit, offset, minDegree, maxDegree, excludeEntryPoints,
    hasSemanticQuery: !!(semanticQuery && semanticQuery.length > 0),
  };

  if (fedConfig) {
    const fedResult = await federatedSearchGraph(db, searchParams, fedConfig);
    deduped = fedResult.results;
    total = fedResult.total;
    provenanceSummary = fedResult.provenance_summary as unknown as Record<string, unknown>;
  } else {
    const localResult = executeLocalSearchGraph(db, searchParams);
    deduped = localResult.results;
    total = localResult.total;
  }

  const { deduped: reRanked, llmReranked, llmMetrics, llmUsage } =
    await applyLlmRerank(db, project, deduped, query, enableLlm);

  const response = buildSearchResponse(
    parsed, started, reRanked, total, provenanceSummary,
    projectCheck, llmReranked, llmMetrics, llmUsage, db, project,
  );

  const resultsArray = response.results as Array<Record<string, unknown>>;
  recordUsageEvent({
    type: 'search_graph',
    project,
    query: query || namePattern || qnPattern || nameLike || qnLike || filePattern || '',
    result_count: resultsArray.length,
    unique_files: new Set(resultsArray.map((r) => String(r.file))).size,
    files_avoided: (response.value_metrics as Record<string, unknown>).estimated_files_avoided as number,
    tokens_saved: (response.value_metrics as Record<string, unknown>).estimated_tokens_saved as number,
    confidence: ((response.value_metrics as Record<string, unknown>).confidence as string) as "high" | "medium" | "low",
    latency_ms: Date.now() - started,
    tool_hint: 'search_graph',
  });

  return response;
}
