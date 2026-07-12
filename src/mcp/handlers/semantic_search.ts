/*
 * semantic_search — Fuzzy semantic search across the code graph.
 *
 * Unlike search_graph (keyword/regex BM25), this uses multiple scoring dimensions:
 *  - Name token overlap (camelCase/PascalCase/snake_case splitting)
 *  - Substring match bonus
 *  - Graph importance (fan-in, complexity)
 *  - Kind boosting (Function > Class > Variable > File)
 *  - Recent findings bonus (symbols with known issues surface higher)
 *
 * Use when the user describes what they want in natural language or when
 * keyword search returns too many/too few results.
 */

import { getDb } from '../server.js';
import { expandTokens } from '../../store/search.js';
import type { LynxDatabase } from '../../store/database.js';
import { estimateTokensSaved, recordUsageEvent } from '../../usage/metrics.js';

interface SemanticResult {
  name: string;
  qualified_name: string;
  kind: string;
  file: string;
  line: number;
  score: number;
  match_reasons: string[];
  fan_in: number;
  complexity: number;
  has_findings: boolean;
  signature?: string;
  line_count?: number;
}

export async function handleSemanticSearch(
  args: Record<string, unknown>
): Promise<unknown> {
  const started = Date.now();
  const project = String(args.project || '');
  const query = args.query ? String(args.query) : undefined;
  const keywords = args.keywords as string[] | undefined;
  const kind = args.kind ? String(args.kind) : undefined;
  const filePattern = args.file_pattern ? String(args.file_pattern) : undefined;
  const limit = args.limit !== undefined ? Number(args.limit) : 10;

  if (!project) return { error: 'project is required' };
  if (!query && (!keywords || keywords.length === 0)) {
    return { error: 'query or keywords is required' };
  }

  const db = getDb(project);

  const { uniqueTokens, expandedTokens } = buildSearchTokens(query, keywords);
  if (expandedTokens.length === 0) return { error: 'No searchable tokens after normalization.' };

  const { scored, meaningfulQueryTokens } =
    fetchAndScoreCandidates(db, project, expandedTokens, uniqueTokens, kind, filePattern);

  // Sort by score desc
  scored.sort((a, b) => b.score - a.score);

  return buildSemanticResponse(
    db, project, scored, limit, query, keywords,
    meaningfulQueryTokens, started,
  );
}

// ── Token extraction ───────────────────────────────────

function buildSearchTokens(
  query?: string,
  keywords?: string[],
): { uniqueTokens: string[]; expandedTokens: string[] } {
  const searchTokens: string[] = [];
  if (query) {
    const normalized = query.toLowerCase().replace(/[-_./\\:]/g, ' ');
    searchTokens.push(...normalized.split(/\s+/).filter(t => t.length > 0));
  }
  if (keywords) {
    searchTokens.push(...keywords.map(k => k.toLowerCase()));
  }
  const uniqueTokens = [...new Set(searchTokens)];
  const expandedTokens = expandTokens(uniqueTokens);
  return { uniqueTokens, expandedTokens };
}

// ── Candidate fetching & scoring ───────────────────────

interface CandidateRow {
  id: number; kind: string; name: string; qualified_name: string;
  file_path: string; start_line: number; properties: string;
}

function fetchAndScoreCandidates(
  db: LynxDatabase,
  project: string,
  expandedTokens: string[],
  uniqueTokens: string[],
  kind?: string,
  filePattern?: string,
): { scored: SemanticResult[]; meaningfulQueryTokens: string[] } {
  let nodeQuery = `SELECT id, kind, name, qualified_name, file_path, start_line, properties FROM nodes WHERE project = ? AND kind IN ('Function', 'Method', 'Class', 'Interface', 'Variable', 'Route')`;
  const params: any[] = [project];

  if (kind) { nodeQuery += ' AND kind = ?'; params.push(kind); }
  if (filePattern) { nodeQuery += ' AND file_path LIKE ?'; params.push('%' + filePattern + '%'); }
  nodeQuery += ' LIMIT 5000';

  const candidates = db.db.prepare(nodeQuery).all(...params) as CandidateRow[];
  const meaningfulQueryTokens = uniqueTokens.filter(t => t.length >= 3);

  const scored: SemanticResult[] = [];
  for (const c of candidates) {
    const result = scoreCandidate(db, project, c, expandedTokens, meaningfulQueryTokens);
    if (result) scored.push(result);
  }

  return { scored, meaningfulQueryTokens };
}

function scoreCandidate(
  db: LynxDatabase,
  project: string,
  c: CandidateRow,
  expandedTokens: string[],
  meaningfulQueryTokens: string[],
): SemanticResult | null {
  const nameLower = c.name.toLowerCase();
  const qnLower = c.qualified_name.toLowerCase();
  const props = JSON.parse(c.properties || '{}');
  const reasons: string[] = [];
  let score = 0;

  // Token matching (primary signal)
  let tokenMatches = 0;
  for (const token of expandedTokens) {
    if (nameLower.includes(token)) {
      tokenMatches += 2;
      if (token === nameLower) {
        tokenMatches += 3;
        reasons.push(`exact_name:${token}`);
      } else if (nameLower.startsWith(token) && token.length >= 4) {
        // Prefix match: only count for meaningful tokens (≥4 chars) to avoid
        // overweighting short prefixes like "find_" that match hundreds of symbols
        tokenMatches += 1;
        reasons.push(`prefix_match:${token}`);
      } else if (nameLower.startsWith(token) && token.length < 4) {
        // Short prefix: still count but at lower weight — avoids dominating
        // real semantic signals when the query has generic short words
        tokenMatches += 0.4;
        reasons.push(`short_prefix:${token}`);
      } else {
        reasons.push(`name_contains:${token}`);
      }
    } else if (qnLower.includes(token)) {
      tokenMatches += 1;
      reasons.push(`qn_contains:${token}`);
    } else if (token.length >= 3) {
      const trigramOverlap = trigramScore(nameLower, token);
      if (trigramOverlap >= 0.4) {
        tokenMatches += trigramOverlap * 1.5;
        reasons.push(`trigram:${token}@${trigramOverlap.toFixed(2)}`);
      }
    }
  }

  if (tokenMatches === 0) return null;

  score += tokenMatches;
  const directMatches = meaningfulQueryTokens.filter(t =>
    nameLower.includes(t) || qnLower.includes(t)
  );
  if (meaningfulQueryTokens.length > 0) {
    score += (directMatches.length / meaningfulQueryTokens.length) * 12;
    reasons.push(`direct_coverage:${directMatches.length}/${meaningfulQueryTokens.length}`);
  }

  // Kind boosting
  if (c.kind === 'Route') score += 5;
  else if (c.kind === 'Function' || c.kind === 'Method') score += 3;
  else if (c.kind === 'Class') score += 2;

  // Graph importance
  const fanIn = db.db
    .prepare('SELECT COUNT(*) as cnt FROM edges WHERE project = ? AND target_id = ?')
    .get(project, c.id) as { cnt: number };
  score += Math.min(fanIn.cnt, 20) * 0.5;

  // Complexity bonus
  const complexity = props.cyclomaticComplexity || 0;
  score += Math.min(complexity, 100) * 0.1;

  // Has findings in memory
  const hasFindings = db.db
    .prepare('SELECT COUNT(*) as cnt FROM findings WHERE project = ? AND target_qn = ?')
    .get(project, c.qualified_name) as { cnt: number };
  if (hasFindings.cnt > 0) {
    score += 2;
    reasons.push('has_findings');
  }

  // Export bonus
  const isExported = props.isExported || (c.qualified_name.includes('.') && !c.qualified_name.includes('..'));
  if (isExported) score += 1;

  // Test penalty
  if (c.file_path.includes('.test.') || c.file_path.includes('.spec.') || c.file_path.includes('__tests__')) {
    score -= 5;
  }

  // Short name penalty
  if (c.name.length <= 2 && c.kind === 'Variable') {
    score -= 3;
  }

  return {
    name: c.name,
    qualified_name: c.qualified_name,
    kind: c.kind,
    file: c.file_path,
    line: c.start_line,
    score: Math.round(score * 100) / 100,
    match_reasons: reasons,
    fan_in: fanIn.cnt,
    complexity,
    has_findings: hasFindings.cnt > 0,
    signature: typeof props.signature === 'string' ? props.signature : undefined,
    line_count: typeof props.lineCount === 'number' ? props.lineCount : undefined,
  };
}

// ── Response assembly ──────────────────────────────────

function buildSemanticResponse(
  db: LynxDatabase,
  project: string,
  scored: SemanticResult[],
  limit: number,
  query?: string,
  keywords?: string[],
  meaningfulQueryTokens: string[] = [],
  started: number = Date.now(),
): unknown {
  const limited = scored.slice(0, limit);
  const total = scored.length;

  // Enrich classes/interfaces with related methods
  const relatedMethodsStmt = db.db.prepare(`
    SELECT name, qualified_name, file_path AS file, start_line AS line,
           json_extract(properties, '$.signature') AS signature,
           json_extract(properties, '$.lineCount') AS line_count
    FROM nodes
    WHERE project = ? AND kind IN ('Method', 'Function') AND qualified_name LIKE ?
    ORDER BY start_line LIMIT 12
  `);
  const enrichedLimited = limited.map(result => {
    if (result.kind !== 'Class' && result.kind !== 'Interface') return result;
    const relatedMethods = relatedMethodsStmt.all(project, `${result.qualified_name}.%`);
    return { ...result, related_methods: relatedMethods };
  });

  const directlyCoveredTokens = meaningfulQueryTokens.filter(token =>
    scored.some(c => c.name.toLowerCase().includes(token) || c.qualified_name.toLowerCase().includes(token))
  );
  const directCoverageRatio = meaningfulQueryTokens.length > 0
    ? directlyCoveredTokens.length / meaningfulQueryTokens.length
    : 0;

  const fuzzyOnlyDomainMatch =
    meaningfulQueryTokens.length >= 3 && directlyCoveredTokens.length === 0;
  const returnedResults = fuzzyOnlyDomainMatch ? [] : enrichedLimited;
  const returnedTotal = fuzzyOnlyDomainMatch ? 0 : total;

  const searchTerm = query || keywords?.join(' ') || '';
  const narrative = fuzzyOnlyDomainMatch
    ? `No direct domain evidence for "${searchTerm}". Fuzzy suggestions were withheld from results to avoid inferring a feature that may not exist.`
    : total === 0
    ? `No results for "${searchTerm}". Try fewer words or use search_graph with name_pattern.`
    : total <= limit
      ? `${total} results for "${searchTerm}".`
      : `${total} results, showing top ${limit} for "${searchTerm}".`;

  const value = estimateTokensSaved(returnedResults.length, returnedTotal);
  recordUsageEvent({
    type: 'search_graph',
    project,
    query: searchTerm,
    result_count: returnedResults.length,
    unique_files: new Set(returnedResults.map(r => r.file)).size,
    files_avoided: value.filesAvoided,
    tokens_saved: value.tokensSaved,
    confidence: value.confidence,
    latency_ms: Date.now() - started,
    tool_hint: 'semantic_search',
  });

  return {
    project,
    query: { text: query, keywords },
    relevance: {
      domain_evidence: directlyCoveredTokens.length > 0 ? 'present' : 'not_established',
      direct_query_tokens: meaningfulQueryTokens,
      directly_covered_tokens: directlyCoveredTokens,
      direct_coverage_ratio: Math.round(directCoverageRatio * 100) / 100,
      warning: directlyCoveredTokens.length === 0 && limited.length > 0
        ? 'Results rely only on fuzzy or expanded-token matches. Do not infer that the requested domain exists in the project; confirm with an exact graph/text search and report insufficient evidence if that search is empty.'
        : null,
    },
    total_results: returnedTotal,
    results: returnedResults,
    fuzzy_suggestions: fuzzyOnlyDomainMatch ? enrichedLimited : [],
    narrative,
    value_metrics: {
      estimated_files_avoided: value.filesAvoided,
      estimated_tokens_saved: value.tokensSaved,
      confidence: value.confidence,
      latency_ms: Date.now() - started,
    },
  };
}

// ── Module-level helpers ───────────────────────────────

function trigramScore(nameLower: string, token: string): number {
  if (token.length < 3) return 0;
  const nameTrigrams = new Set<string>();
  for (let i = 0; i < nameLower.length - 2; i++) {
    nameTrigrams.add(nameLower.slice(i, i + 3));
  }
  let overlap = 0;
  for (let i = 0; i < token.length - 2; i++) {
    if (nameTrigrams.has(token.slice(i, i + 3))) overlap++;
  }
  const maxPossible = token.length - 2;
  return maxPossible > 0 ? overlap / maxPossible : 0;
}
