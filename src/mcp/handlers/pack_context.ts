/*
 * pack_context — Task-aware context assembly. Product-grade v2.
 *
 * v2 improvements:
 * - Max 7 symbols (5 compact, 7 full)
 * - Flow grouping: api / service / ui / data / test
 * - Change risk estimation via fan-in
 * - Index staleness detection
 * - Why each symbol matters
 * - Exact next-call recommendations
 * - Session value metrics with dedup
 */

import { getDb } from '../server.js';
import type { LynxDatabase } from '../../store/database.js';
import type { LynxFinding } from '../../types.js';
import { searchFullText } from '../../store/search.js';
import { getRecentFindings, getFindingsByQn } from '../../store/memory.js';
import {
  estimateTokensSaved,
  estimateRerankCostUsd,
  recordUsageEvent,
  summarizeUsage,
} from '../../usage/metrics.js';
import { computeRealSavings } from '../../usage/session.js';
import * as path from 'node:path';
import { getModifiedFiles } from '../../git/diff.js';
import { storedTimestampMs } from '../../store/time.js';
import { rerankSearchWithMeta, type RerankMeta } from '../../llm/client.js';
import { readLynxConfig } from '../../config/runtime.js';
import { hasCapability } from '../../commercial/gate.js';
import { getNodeEdgeEvidence } from '../../store/edge-evidence.js';

interface GraphCandidate {
  name: string;
  qualified_name: string;
  file_path: string;
  kind?: string;
  flow_area: string;
  why: string;
  score: number;
  change_risk?: 'high' | 'medium' | 'low';
  fan_in?: number;
  edge_evidence?: Array<{ type: string; direction: string; symbol: string; evidence_count: number }>;
  memory_findings?: Array<{
    title: string;
    severity: string;
    category: string;
  }>;
}

interface PackContextResult {
  project: string;
  task: string;
  mode: string;
  critical_constraints: string[];
  graph_candidates: GraphCandidate[];
  recent_findings: Array<{
    title: string;
    severity: string;
    target_file: string;
  }>;
  recommended_next_calls: Array<{ tool: string; why: string; qualified_name?: string }>;
  index_health?: {
    total_nodes: number;
    total_edges: number;
    hours_since_index: number | null;
    is_fresh: boolean;
  };
  value_metrics?: {
    measurement?: string;
    estimated_files_avoided: number;
    estimated_tokens_saved: number;
    full_file_potential_tokens?: number;
    potential_basis?: string;
    confidence: string;
    session_tokens_saved: number;
    session_files_avoided: number;
    session_unique_files_avoided?: number;
  };
  memory_enriched?: number;
  llm_usage?: {
    enabled: boolean;
    used: boolean;
    provider: string | null;
    model: string | null;
    latency_ms: number;
    fallback_used: boolean;
    fallback_reason: string | null;
  };
  context_selection?: {
    original_candidates: number;
    selected_candidates: number;
    estimated_tokens_avoided: number;
    applied: boolean;
  };
  token_budget: {
    estimated_pack_tokens: number;
    confidence: string;
  };
  decision_summary?: string;
}

const MAX_CANDIDATES_COMPACT = 5;
const MAX_CANDIDATES_FULL = 7;
const MAX_TERMS = 4;
const SELECTED_CANDIDATES_COMPACT = 3;

export async function handlePackContext(
  args: Record<string, unknown>
): Promise<PackContextResult> {
  const task = String(args.task || '');
  const project = String(args.project || '');
  const mode = String(args.mode || 'compact');
  // Deterministic graph ranking is the default: it is immediate, private, and
  // avoids spending provider tokens for ordinary discovery. Callers can opt in
  // to reranking only when the task is genuinely ambiguous or high-risk.
  const enableLlm = args.enable_llm === true;
  const llmWasExplicitlySet = Object.prototype.hasOwnProperty.call(args, 'enable_llm');

  const constraints = buildConstraints(task);

  // Decision-ready mode
  if (mode === 'decision' && project) {
    const decisionSummary = buildDecisionSummary(project, task);
    const baseResult = await buildBaseResult(project, task, mode, constraints);
    baseResult.decision_summary = decisionSummary;
    return baseResult;
  }

  // Standard mode with indexed project
  if (project) {
    return await buildProjectPackContext(project, task, mode, constraints, enableLlm, llmWasExplicitlySet);
  }

  return {
    project, task, mode,
    critical_constraints: constraints,
    graph_candidates: [],
    recent_findings: [],
    recommended_next_calls: [
      { tool: 'list_projects', why: 'Choose an indexed project before requesting graph evidence.' },
    ],
    token_budget: { estimated_pack_tokens: 100, confidence: 'low_no_project' },
  };
}

// ── Constraint extraction ──────────────────────────────

function buildConstraints(task: string): string[] {
  const taskLower = task.toLowerCase();
  const isFrontend = /\b(?:frontend|ui|react|components?|pages?|views?|styles?|css|tailwind|jsx)\b/i.test(taskLower);
  const isBackend = /\b(?:backend|api|server|database|db|prisma|sql|queries|query|routes?|endpoints?)\b/i.test(taskLower);
  const isReadonly = /\b(?:analizar|analyze|review|audit|check|explore|exploring|investigar|read-only|readonly)\b/i.test(taskLower);

  const constraints: string[] = [];
  constraints.push('READ_TARGET_FILES_BEFORE_EDITING');
  constraints.push('VALIDATE_BEFORE_FINAL');
  if (isFrontend && !isBackend) constraints.push('UI_ONLY');
  if (isBackend && !isFrontend) constraints.push('NO_FRONTEND_CHANGES');
  if (isReadonly) constraints.push('READONLY_ONLY');
  return constraints;
}

// ── Main project context builder ───────────────────────

async function buildProjectPackContext(
  project: string,
  task: string,
  mode: string,
  constraints: string[],
  enableLlm: boolean,
  llmWasExplicitlySet: boolean,
): Promise<PackContextResult> {
  const db = getDb(project);
  const isSpanish = /[áéíóúñ]/.test(task);
  const maxCandidates = mode === 'full' ? MAX_CANDIDATES_FULL : MAX_CANDIDATES_COMPACT;
  const taskLower = task.toLowerCase();
  const terms = extractTerms(task, isSpanish).slice(0, MAX_TERMS);

  const candidates: GraphCandidate[] = [];
  for (const term of terms) {
    const results = searchFullText(db, project, term, 3);
    for (const r of results) {
      const area = classifyFlowArea(r.node.filePath);
      const fanIn = r.inDegree;
      candidates.push({
        name: r.node.name,
        qualified_name: r.node.qualifiedName,
        file_path: r.node.filePath,
        kind: r.node.kind,
        flow_area: area,
        why: explainCandidate(r.node.kind, r.node.filePath, taskLower, term, fanIn),
        score: r.score + r.tokenScore + subsystemAffinity(taskLower, r.node.filePath),
        change_risk: assessChangeRisk(fanIn, r.node.filePath),
        fan_in: fanIn,
      });
    }
  }

  const candidatePool = dedupeCandidates(candidates);
  const dedupedCandidates = candidatePool.slice(0, maxCandidates);
  let confidence = 'medium';
  if (dedupedCandidates.length === 0) confidence = 'low_no_index';

  // ── LLM rerank ──────────────────────────────────────────
  let llmReranked = false;
  const llmUsage = {
    enabled: enableLlm,
    used: false,
    provider: null as string | null,
    model: null as string | null,
    latency_ms: 0,
    fallback_used: false,
    fallback_reason: null as string | null,
  };

  const policy = readLynxConfig().decision_llm;
  const autoSelect = !llmWasExplicitlySet && policy?.mode === 'adaptive' &&
    candidatePool.length > maxCandidates && hasAmbiguousCandidatePool(candidatePool) &&
    hasCapability('semantic_rerank');
  const shouldSelectWithLlm = enableLlm || autoSelect;
  const selectionLimit = mode === 'full' ? MAX_CANDIDATES_COMPACT : SELECTED_CANDIDATES_COMPACT;
  llmUsage.enabled = shouldSelectWithLlm;

  if (shouldSelectWithLlm && candidatePool.length >= 3) {
    try {
      const rerankStart = Date.now();
      const rerankInput = candidatePool.slice(0, maxCandidates + 3).map((c, i) => ({
        index: i,
        name: c.name,
        kind: c.kind || 'Function',
        snippet: c.why,
      }));
      const rerank = await rerankSearchWithMeta(task, rerankInput);
      llmUsage.used = rerank.provider !== 'heuristic' || !rerank.fallback;
      llmUsage.provider = rerank.provider;
      llmUsage.model = rerank.model || null;
      llmUsage.latency_ms = Date.now() - rerankStart;
      llmUsage.fallback_used = rerank.fallback;
      llmUsage.fallback_reason = rerank.fallback
        ? 'rerank fell back to heuristic — kept BM25 order'
        : null;

      if (rerank.items.length === rerankInput.length && rerank.provider !== 'heuristic') {
        const reordered = rerank.items
          .sort((a, b) => b.relevanceScore - a.relevanceScore)
          .map(r => candidatePool[r.index])
          .filter(Boolean);
        if (reordered.length === rerankInput.length) {
          // Replace in-place
          dedupedCandidates.length = 0;
          dedupedCandidates.push(...reordered.slice(0, selectionLimit));
          llmReranked = true;
          recordUsageEvent({
            type: 'llm_rerank', project, query: task.slice(0, 240),
            result_count: rerankInput.length, unique_files: new Set(reordered.map(c => c.file_path)).size,
            files_avoided: 0, tokens_saved: 0, confidence: 'low',
            llm_provider: rerank.provider, llm_model: rerank.model || undefined,
            llm_latency_ms: llmUsage.latency_ms,
            estimated_llm_cost_usd: estimateRerankCostUsd(rerankInput.length),
            rank_changed: true, top_changed: reordered[0]?.qualified_name !== candidatePool[0]?.qualified_name,
            tool_hint: 'pack_context selection', files: reordered.slice(0, selectionLimit).map(c => c.file_path),
          });
        }
      }
    } catch {
      llmUsage.fallback_used = true;
      llmUsage.fallback_reason = 'rerank exception, kept BM25 order';
    }
  } else if (!shouldSelectWithLlm) {
    llmUsage.fallback_reason = 'enable_llm=false, skipped rerank';
  }

  // Enrich with graph edge evidence
  for (const c of dedupedCandidates) {
    try {
      const node = db.db.prepare('SELECT id FROM nodes WHERE project = ? AND qualified_name = ? LIMIT 1').get(project, c.qualified_name) as { id?: number } | undefined;
      if (node?.id) {
c.edge_evidence = getNodeEdgeEvidence(db, project, node.id, 5).map((row) => ({
type: row.type,
direction: row.direction,
symbol: row.symbol,
evidence_count: row.evidence_count,
}));
      }
    } catch { }
  }

  // Enrich with memory findings
  let memoryEnriched = 0;
  for (const c of dedupedCandidates) {
    try {
      const memFindings = getFindingsByQn(db, project, c.qualified_name);
      if (memFindings.length > 0) {
        c.memory_findings = dedupeFindings(memFindings).slice(0, 3).map(f => ({
          title: f.title, severity: f.severity, category: f.category,
        }));
        memoryEnriched++;
      }
    } catch { /* skip */ }
  }

  const recentFindings = getRecentFindings(db, project, 5);
  const indexHealth = getIndexHealth(db, project);

  const uniqueFiles = new Set(dedupedCandidates.map(c => c.file_path)).size;
  const fileList = dedupedCandidates.map(c => c.file_path);
  // The pack returns a small, ranked set of pointers; it does not read the
  // candidate files for the caller. Keep observed value to that delivered
  // orientation and expose the wider exploration as potential only.
  const observedTokens = dedupedCandidates.length === 0
    ? 0
    : Math.min(1_200, dedupedCandidates.length * 140 + uniqueFiles * 90);
  const meta = db.getProject(project);
  const rootPath = meta?.rootPath || process.cwd();
  const potential = estimateTokensSaved({ resultCount: dedupedCandidates.length, candidateFiles: Math.max(uniqueFiles * 4, 3), files: fileList, rootPath, project });
  recordUsageEvent({
    type: 'pack_context', project,
    query: task.slice(0, 240),
    result_count: dedupedCandidates.length,
    unique_files: uniqueFiles,
    files_avoided: 0,
    tokens_saved: observedTokens,
    confidence: 'low',
    files: fileList,
    tool_hint: 'pack_context',
  });

  const usage = summarizeUsage(project, 500);
  const isBackend = /backend|api|server|database|db|prisma|sql|query|route|endpoint/i.test(taskLower);

  // Build next-calls
  const nextCalls: Array<{ tool: string; why: string; qualified_name?: string }> = [
    { tool: 'search_graph', why: 'Find exact symbols and verify they still exist' },
  ];
  if (dedupedCandidates[0]) {
    nextCalls.push({
      tool: 'get_code_snippet',
      why: `Read ${dedupedCandidates[0].name} first — ${dedupedCandidates[0].flow_area} entry point`,
      qualified_name: dedupedCandidates[0].qualified_name,
    });
  }
  if (isBackend || dedupedCandidates.some(c => c.change_risk === 'high')) {
    nextCalls.push({ tool: 'trace_path', why: 'Check callers before modifying shared functions (high fan-in detected)' });
  }
  if (memoryEnriched > 0) {
    nextCalls.push({ tool: 'pack_memory', why: `${memoryEnriched} candidate(s) have prior review findings — check memory before editing` });
  }
  if (!indexHealth.is_fresh && indexHealth.hours_since_index !== null) {
    nextCalls.push({ tool: 'index_repository', why: `Index is ${indexHealth.hours_since_index}h old — re-index before relying on stale graph` });
  }

  return {
    project, task, mode,
    critical_constraints: constraints,
    graph_candidates: dedupedCandidates,
    recent_findings: dedupeFindings(recentFindings).map(f => ({
      title: f.title, severity: f.severity, target_file: f.targetFile,
    })),
    recommended_next_calls: nextCalls,
    index_health: indexHealth,
    memory_enriched: memoryEnriched,
    llm_usage: llmUsage,
    context_selection: {
      original_candidates: Math.min(candidatePool.length, maxCandidates),
      selected_candidates: dedupedCandidates.length,
      estimated_tokens_avoided: llmReranked
        ? estimateCandidateTokens(candidatePool.slice(0, maxCandidates)) - estimateCandidateTokens(dedupedCandidates)
        : 0,
      applied: llmReranked,
    },
    value_metrics: {
      measurement: 'ranked_context_pointers',
      estimated_files_avoided: 0,
      estimated_tokens_saved: observedTokens,
      full_file_potential_tokens: potential.tokensSaved,
      potential_basis: 'broader task exploration from ranked candidates; not observed savings',
      confidence: 'low',
      session_tokens_saved: usage.tokens_saved,
      session_files_avoided: usage.files_avoided,
      session_unique_files_avoided: usage.unique_files_avoided,
      ...getRealSavingsBlock(db, project),
    },
    token_budget: {
      estimated_pack_tokens: mode === 'full' ? 320 : 200,
      confidence,
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────

function dedupeCandidates(candidates: GraphCandidate[]): GraphCandidate[] {
  const seen = new Set<string>();
  const ranked = [...candidates].sort((a, b) => {
    const relevanceDiff = b.score - a.score;
    if (Math.abs(relevanceDiff) > 0.001) return relevanceDiff;
    const areaScore = areaPriority(a.flow_area) - areaPriority(b.flow_area);
    if (areaScore !== 0) return areaScore;
    const fanDiff = (b.fan_in || 0) - (a.fan_in || 0);
    return fanDiff;
  });
  return ranked.filter(candidate => {
    if (seen.has(candidate.qualified_name)) return false;
    seen.add(candidate.qualified_name);
    return true;
  });
}

function subsystemAffinity(taskLower: string, filePath: string): number {
  const scopes: Array<[RegExp, RegExp]> = [
    [/\b(?:mcp|tools?|handlers?)\b/, /(?:^|\/)src\/mcp\//],
    [/\b(?:dashboard|metrics?|cards?|tooltip|frontend|ui)\b/, /(?:^|\/)src\/server\/dashboard\//],
    [/\b(?:index|indexing|indexer|watcher|incremental)\b/, /(?:^|\/)src\/(?:pipeline|watcher)\//],
    [/\b(?:graph|edges?|nodes?|relationships?)\b/, /(?:^|\/)src\/(?:store|pipeline\/phases\/resolve)\//],
    [/\b(?:tests?|coverage|vitest)\b/, /(?:^|\/)(?:tests?\/|[^/]+\.(?:test|spec)\.)/],
  ];
  return scopes.reduce((boost, [intent, pathPattern]) =>
    boost + (intent.test(taskLower) && pathPattern.test(filePath) ? 30 : 0), 0);
}

export function hasAmbiguousCandidatePool(candidates: readonly Pick<GraphCandidate, 'score'>[]): boolean {
  if (candidates.length < 2) return false;
  const scores = candidates.map(candidate => candidate.score).sort((a, b) => b - a);
  const [top, runnerUp] = scores;
  return top - runnerUp <= 1 || (top > 0 && (top - runnerUp) / top <= 0.15);
}

function estimateCandidateTokens(candidates: readonly GraphCandidate[]): number {
  return Math.ceil(JSON.stringify(candidates).length / 4);
}

function dedupeFindings(findings: LynxFinding[]): LynxFinding[] {
  const seen = new Set<string>();
  return findings.filter(f => {
    // Hotspot snapshots: dedup by target_qn (keep latest — ordered by updated_at DESC).
    // Title changes per run (different fan_in), so file+title key doesn't collapse them.
    if (f.category === 'hotspot') {
      const key = `${f.targetQn}:hotspot`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }
    const key = `${f.targetFile}:${f.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function areaPriority(area: string): number {
  switch (area) {
    case 'api': return 0;
    case 'service': return 1;
    case 'ui': return 2;
    case 'data': return 3;
    case 'test': return 9;
    default: return 4;
  }
}

function classifyFlowArea(filePath: string): string {
  if (/(__tests__|\.test\.|\.spec\.)/.test(filePath)) return 'test';
  if (/\/api\/|route\.(ts|tsx|js|jsx)$/.test(filePath)) return 'api';
  if (/\/lib\/|\/service|provider|mailing|auth|server/.test(filePath)) return 'service';
  if (/\/app\/|\/components\/|\.tsx$/.test(filePath)) return 'ui';
  if (/prisma|schema|db|store|repository/i.test(filePath)) return 'data';
  return 'code';
}

function assessChangeRisk(fanIn: number, filePath: string): 'high' | 'medium' | 'low' {
  if (fanIn >= 10) return 'high';
  if (fanIn >= 5) return 'medium';
  if (/\/lib\/|\/shared\/|\/common\/|utils/i.test(filePath)) return 'medium';
  return 'low';
}

function explainCandidate(
  kind: string, filePath: string, taskLower: string, matchedTerm: string, fanIn: number,
): string {
  const area = classifyFlowArea(filePath);
  const riskNote = fanIn >= 5 ? ` (${fanIn} callers — high impact)` : '';
  if (area === 'api') return `Request boundary — entry point for this flow${riskNote}.`;
  if (area === 'service') return `Core logic — matched "${matchedTerm}"${riskNote}.`;
  if (area === 'ui') return `User-facing entry — matched "${matchedTerm}"${riskNote}.`;
  if (area === 'data') return `Data layer — matched "${matchedTerm}"${riskNote}.`;
  if (taskLower.includes('email') || taskLower.includes('correo')) return `Email-related — matched "${matchedTerm}"${riskNote}.`;
  return `${kind} matched "${matchedTerm}"${riskNote}.`;
}

function extractTerms(text: string, _isSpanish: boolean): string[] {
  const stopWords = new Set([
    'the', 'and', 'for', 'from', 'with', 'this', 'that', 'what', 'when',
    'where', 'which', 'how', 'all', 'are', 'was', 'has', 'been', 'can',
    'de', 'la', 'el', 'en', 'los', 'las', 'del', 'por', 'que', 'una',
    'un', 'para', 'con', 'como', 'más', 'pero', 'sus', 'le', 'ya',
    'este', 'esta', 'entre', 'al', 'del', 'todo', 'muy', 'hay', 'ese',
    'analiza', 'analizar', 'proyecto', 'código', 'archivo', 'carpeta',
    // Generic dev verbs — too common to be useful search terms
    'add', 'new', 'make', 'use', 'get', 'set', 'put', 'the', 'not',
    'its', 'also', 'just', 'will', 'need', 'want', 'into', 'our',
    // Audit/process language describes the activity, not a code target.
    'audit', 'auditing', 'review', 'second', 'root', 'cause', 'real',
    'execution', 'executions', 'systemic', 'correctness', 'consistency',
    'quality', 'efficiency', 'defect', 'defects', 'improvement', 'improvements',
  ]);

  const tokens = text
    .toLowerCase()
    .split(/[\s,;:.'"()\[\]{}_\/-]+/)
    .filter(t => t.length >= 3 && !stopWords.has(t));

  return [...new Set(tokens)];
}

function getIndexHealth(
  db: LynxDatabase, project: string,
): { total_nodes: number; total_edges: number; hours_since_index: number | null; is_fresh: boolean } {
  try {
    const nodeCount = (db.db
      .prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?')
      .get(project) as { cnt: number })?.cnt ?? 0;
    const edgeCount = (db.db
      .prepare('SELECT COUNT(*) as cnt FROM edges WHERE project = ?')
      .get(project) as { cnt: number })?.cnt ?? 0;
    const projectMeta = (db.db
      .prepare('SELECT indexed_at FROM projects WHERE name = ?')
      .get(project) as { indexed_at?: string } | undefined);
    const indexedAt = projectMeta?.indexed_at
      ? storedTimestampMs(projectMeta.indexed_at)
      : null;
    const now = Date.now();
    const hoursSinceIndex = indexedAt ? Math.round((now - indexedAt) / (1000 * 60 * 60)) : null;
    const isFresh = nodeCount > 0 && hoursSinceIndex !== null && hoursSinceIndex < 24;

    return { total_nodes: nodeCount, total_edges: edgeCount, hours_since_index: hoursSinceIndex, is_fresh: isFresh };
  } catch {
    return { total_nodes: 0, total_edges: 0, hours_since_index: null, is_fresh: false };
  }
}

function getRealSavingsBlock(
  db: LynxDatabase, project: string,
): { real_files_avoided?: number; real_tokens_saved?: number; real_confidence?: string } {
  try {
    const meta = db.getProject(project);
    if (!meta) return {};
    const real = computeRealSavings(project, meta.rootPath, meta.rootPath);
    if (real.tokensSaved <= 0) return {};
    return {
      real_files_avoided: real.filesAvoided,
      real_tokens_saved: real.tokensSaved,
      real_confidence: real.suggestionsResolved >= 2 ? 'high' : real.suggestionsResolved >= 1 ? 'medium' : 'low',
    };
  } catch {
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════
// Decision-ready mode helpers
// ═══════════════════════════════════════════════════════════════

function shortestUniqueSuffix(target: string, all: string[]): string {
  const parts = target.split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    const suffix = parts.slice(i).join('/');
    const matches = all.filter(f => f.endsWith(suffix));
    if (matches.length === 1 && matches[0] === target) return suffix;
  }
  return target;
}

// getModifiedFiles is shared in src/git/diff.ts

function buildDecisionSummary(project: string, task: string): string {
  const db = getDb(project);
  const meta = db.getProject(project);
  if (!meta) return 'Project not indexed. Run index_repository first for decision support.';

  const rootPath = meta.rootPath;
  const diffFiles = getModifiedFiles(rootPath);

  if (diffFiles.length === 0) {
    return 'No uncommitted changes detected. The working tree is clean. If a material question remains, re-run with a specific task description so LYNX can target only the relevant code areas.';
  }

  const lines: string[] = [];
  const wordLimit = 300;

  // 1. What changed
  const changedSymbols: Array<{ name: string; file: string; kind: string; callers: number }> = [];
  for (const file of diffFiles.slice(0, 15)) {
    const syms = db.db.prepare(
      `SELECT name, kind, qualified_name FROM nodes
       WHERE project = ? AND file_path = ? AND kind IN ('Function', 'Method', 'Class')
       LIMIT 10`
    ).all(project, file) as Array<{ name: string; kind: string; qualified_name: string }>;

    for (const s of syms) {
      const callerCount = (db.db.prepare(
        `SELECT COUNT(*) as cnt FROM edges WHERE target_id =
         (SELECT id FROM nodes WHERE project = ? AND qualified_name = ? LIMIT 1) AND type = 'CALLS'`
      ).get(project, s.qualified_name) as { cnt: number })?.cnt ?? 0;
      changedSymbols.push({ name: s.name, kind: s.kind, file, callers: callerCount });
    }
  }

  const indexedFiles = diffFiles.filter(f => {
    const cnt = (db.db.prepare(
      'SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND file_path = ?'
    ).get(project, f) as { cnt: number })?.cnt ?? 0;
    return cnt > 0;
  });

  if (changedSymbols.length > 0) {
    const top = changedSymbols.slice(0, 5).map(s => `\`${s.name}\` in ${s.file} (${s.kind}, ${s.callers} callers)`).join(', ');
    lines.push(`**Changed symbols:** ${top}.`);
  }
  lines.push(`**Files:** ${diffFiles.length} modified (${indexedFiles.length} indexed, ${diffFiles.length - indexedFiles.length} unindexed).`);

  // 2. What could break
  const risky = changedSymbols.filter(s => s.callers >= 3).sort((a, b) => b.callers - a.callers);
  if (risky.length > 0) {
    const top = risky.slice(0, 5).map(s => `\`${s.name}\` (${s.file}: ${s.callers} callers)`).join(', ');
    lines.push(`**Break risk:** ${top}.`);
  } else if (changedSymbols.length > 0) {
    lines.push('**Break risk:** Low — no modified symbol has ≥3 callers.');
  }

  // 3. Tests covering the changes
  let testedCount = 0;
  for (const file of indexedFiles.slice(0, 10)) {
    const testEdges = db.db.prepare(
      `SELECT COUNT(*) as cnt FROM edges e
       JOIN nodes tgt ON tgt.id = e.target_id
       WHERE tgt.project = ? AND tgt.file_path = ? AND tgt.kind = 'File'
         AND e.type = 'TESTS_FILE'`
    ).get(project, file) as { cnt: number };
    if (testEdges.cnt > 0) testedCount++;
  }
  if (testedCount > 0) {
    lines.push(`**Test coverage:** ${testedCount}/${Math.min(indexedFiles.length, 10)} changed files have TESTS_FILE edges.`);
  } else if (indexedFiles.length > 0) {
    lines.push('**Test coverage:** None of the changed files have test files linked. Consider adding tests.');
  }

  // 4. Files worth reading
  const topFiles = changedSymbols.sort((a, b) => b.callers - a.callers).slice(0, 5).map(s => s.file);
  const uniqueTopFiles = [...new Set(topFiles)];
  if (uniqueTopFiles.length > 0) {
    const basenameCounts = new Map<string, number>();
    for (const f of uniqueTopFiles) basenameCounts.set(path.basename(f), (basenameCounts.get(path.basename(f)) || 0) + 1);
    const displayNames = uniqueTopFiles.map(f => {
      const bn = path.basename(f);
      return basenameCounts.get(bn)! > 1 ? shortestUniqueSuffix(f, uniqueTopFiles) : bn;
    });
    lines.push(`**Read first:** ${displayNames.map(n => `\`${n}\``).join(', ')}.`);
  }

  // 5. Recommended next step
  if (!indexedFiles.length && diffFiles.length > 0) {
    lines.push('**Next:** Re-index (`index_repository`) — none of the changed files are in the graph.');
  } else if (risky.length > 0) {
    lines.push(`**Next:** Run \`trace_path\` on \`${risky[0].name}\` before modifying — ${risky[0].callers} callers depend on it.`);
  } else if (testedCount === 0) {
    lines.push('**Next:** Run \`find_tests\` on changed symbols to verify coverage gap.');
  } else {
    lines.push('**Next:** Read the top files with \`get_code_snippet\`, make changes, then re-run \`assess_impact\` to verify.');
  }

  let summary = lines.join(' ');
  if (summary.length > wordLimit * 5) {
    const words = summary.split(/\s+/);
    summary = words.slice(0, wordLimit).join(' ') + '...';
  }

  return summary;
}

async function buildBaseResult(
  project: string, task: string, mode: string, constraints: string[],
): Promise<PackContextResult> {
  const db = getDb(project);
  const indexHealth = getIndexHealth(db, project);
  const recentFindings = getRecentFindings(db, project, 5);

  return {
    project, task, mode,
    critical_constraints: constraints,
    graph_candidates: [],
    recent_findings: dedupeFindings(recentFindings).map(f => ({
      title: f.title, severity: f.severity, target_file: f.targetFile,
    })),
    recommended_next_calls: [
      { tool: 'search_graph', why: 'Find exact symbols affected by the changes' },
      { tool: 'get_code_snippet', why: 'Read the top affected file first' },
      { tool: 'trace_path', why: 'Check callers before modifying shared symbols' },
      { tool: 'assess_impact', why: 'Full test + impact cross-reference' },
    ],
    index_health: indexHealth,
    token_budget: { estimated_pack_tokens: 320, confidence: 'medium' },
  };
}
