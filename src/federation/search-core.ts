/*
 * search-core.ts — Pure search data retrieval core.
 *
 * Extracted from handleSearchGraph to avoid MCP coupling,
 * double metrics recording, and narrated-response merge issues.
 *
 * Takes a LynxDatabase + typed params. Returns structured data.
 * No metrics, narrative, LLM, or MCP serialization.
 */

import type { LynxDatabase } from '../store/database.js';
import { search, searchFullText, expandQuery } from '../store/search.js';
import type { SearchNode, LocalSearchResult, FederatedSearchParams } from './types.js';

/**
 * Pure core: execute a local search without side effects.
 *
 * Used by:
 *   - handleSearchGraph (when no Team config — identical to today)
 *   - LocalIndexProvider (called by FederatedGateway)
 */
export function executeLocalSearchGraph(
  db: LynxDatabase,
  params: FederatedSearchParams
): LocalSearchResult {
  const { project, query, label, namePattern, qnPattern, nameLike, qnLike, filePattern,
          limit, offset, minDegree, maxDegree, excludeEntryPoints } = params;

  const hasStructuredFilter = !!(namePattern || qnPattern || nameLike || qnLike || filePattern ||
    minDegree !== undefined || maxDegree !== undefined || excludeEntryPoints ||
    params.hasSemanticQuery);

  let mappedResults: SearchNode[] = [];
  let total = 0;

  if (query && !hasStructuredFilter) {
    const candidateLimit = Math.max(limit * 5, 30);
    const results = searchFullText(db, project, query, candidateLimit);
    mappedResults = results.map(r => ({
      name: r.node.name,
      qualified_name: r.node.qualifiedName,
      file_path: r.node.filePath,
      start_line: r.node.startLine,
      end_line: r.node.endLine,
      kind: r.node.kind,
      in_degree: r.inDegree,
      out_degree: r.outDegree,
      is_entry_point: r.node.isEntryPoint,
      is_test: r.node.isTest,
      provenance: 'local' as const,
      provider_count: 1,
      deterministic_score: r.score + r.tokenScore,
    }));
    total = results.length;
  } else {
    const searchParams: Record<string, unknown> = {
      project,
      label,
      limit,
      offset,
      excludeEntryPoints,
      sortBy: 'relevance',
    };
    if (namePattern) searchParams.namePattern = namePattern;
    if (qnPattern) searchParams.qnPattern = qnPattern;
    if (nameLike) searchParams.nameLike = nameLike;
    if (qnLike) searchParams.qnLike = qnLike;
    if (filePattern) searchParams.filePattern = filePattern;
    if (minDegree !== undefined) searchParams.minDegree = minDegree;
    if (maxDegree !== undefined) searchParams.maxDegree = maxDegree;
    if (query) {
      const tokens = expandQuery(query);
      if (tokens.length > 0) searchParams.textSearchTokens = tokens;
    }

    const results = search(db, searchParams as unknown as Parameters<typeof search>[1]);
    mappedResults = results.results.map(r => ({
      name: r.node.name,
      qualified_name: r.node.qualifiedName,
      file_path: r.node.filePath,
      start_line: r.node.startLine,
      end_line: r.node.endLine,
      kind: r.node.kind,
      in_degree: r.inDegree,
      out_degree: r.outDegree,
      is_entry_point: r.node.isEntryPoint,
      is_test: r.node.isTest,
      provenance: 'local' as const,
      provider_count: 1,
      deterministic_score: r.score + r.tokenScore,
    }));
    total = results.total;
  }

  // Dedup by qualified_name (stable sort order preserved)
  const seen = new Set<string>();
  const deduped = mappedResults.filter(r => {
    const key = r.qualified_name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { results: deduped, total };
}
