/*
 * detect_changes.ts — Find code changes and analyze their impact.
 *
 * Contract version: 2 (2026-07-10)
 * Changes from v1: categorised git state, impact tiers, --files scoping,
 *   related dependencies section, confidence per evidence type.
 * Legacy fields preserved as derived compat: changed_files, changed_nodes,
 *   by_severity, impact_analysis.
 *
 * Pure exported functions (domain boundaries):
 *   parseGitStatus, normalizeRequestedFiles, canonicalizeAndDeduplicatePaths,
 *   classifyGitEntries, filterPrimaryScope, classifyImpactEvidence,
 *   deduplicateRelatedDependencies
 */

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDb } from '../server.js';
import { getNeighborNames, bfsTraverse } from '../../store/traverse.js';
import { explainHotspot } from '../../intelligence/narrative.js';
import { assessRiskWithMeta, type LlmUsage } from '../../llm/client.js';
import { projectNotIndexed } from '../diagnostics.js';

// ═══════════════════════════════════════════════════════════════
// Public contract types (exported for consumers and tests)
// ═══════════════════════════════════════════════════════════════

export const DETECT_CHANGES_CONTRACT_VERSION = 2;

/** Discriminated union for git status entries. */
export type GitStatusEntry =
  | { kind: 'staged'; file: string; status: string; oldPath?: string; isRename: boolean }
  | { kind: 'unstaged'; file: string; status: string }
  | { kind: 'untracked'; file: string; status: '?' }
  | { kind: 'deleted'; file: string; status: 'D' }
  | { kind: 'renamed'; file: string; oldPath: string; status: 'R' }
  | { kind: 'mixed'; file: string; staged: string; unstaged: string };

/** A deduplicated, canonicalised file change entry. */
export interface CanonicalChange {
  file: string;
  entries: GitStatusEntry[];
  /** Present only when one of the entries is a rename. */
  oldPath?: string;
  /** True if the file appears in both staged and unstaged state. */
  hasMixedState: boolean;
}

/** Categorised git changes. */
export interface CategorisedChanges {
  tracked_changes: CanonicalChange[];
  unstaged_changes: CanonicalChange[];
  untracked_files: CanonicalChange[];
  deleted_files: CanonicalChange[];
  renamed_files: CanonicalChange[];
}

/** Impact evidence tier. */
export type ImpactTier = 'confirmed' | 'probable' | 'nominal';

export interface ImpactEvidence {
  tier: ImpactTier;
  reasons: string[];
}

/** A dependency outside the --files scope that has a graph edge to a scoped file. */
export interface RelatedDependency {
  scopeFile: string;
  scopeSymbol: string | null;
  relatedFile: string;
  relatedSymbol: string | null;
  direction: 'inbound' | 'outbound';
  edgeType: string;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

/** Legacy compat file entry — concrete type matching DetectChangesResult contract. */
interface CompatFileEntry {
  file: string;
  status: string;
  diff?: string;
  old_path?: string;
}
export interface DetectChangesResult {
  contract_version: number;
  project: string;
  base_branch: string;
  since: string | null;
  scope: 'files' | 'symbols';
  depth: number;

  categories: Record<string, Array<{ file: string; status: string; old_path?: string | null }>>;
  category_counts: Record<string, number>;

  impact_assessment: {
    confirmed_count: number;
    probable_count: number;
    nominal_count: number;
    confirmed: Array<{ name: string; qualified_name: string; file_path: string; evidence: string[] }>;
    probable: Array<{ name: string; qualified_name: string; file_path: string; evidence: string[] }>;
    nominal: Array<{ name: string; qualified_name: string; file_path: string; evidence: string[] }>;
  };

  related_dependencies: Array<{
    scope_file: string;
    scope_symbol: string | null;
    related_file: string;
    related_symbol: string | null;
    direction: string;
    edge_type: string;
    reason: string;
    confidence: string;
  }>;
  related_dependencies_count: number;

  // Legacy compat fields (derived from structured result)
  changed_files: CompatFileEntry[];
  changed_nodes: Array<Record<string, unknown>>;
  total_changed_files: number;
  total_affected_nodes: number;
  by_severity: Record<string, number>;
  indirect_callers_affected: number;
  impact_analysis: { summary: string; risk_level: string; details: string[] };
  llm_usage: LlmUsage;

  // Diagnostic fields (populated on error paths)
  error?: string;
  hint?: string;
  recoverable?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// Pure exported functions — domain boundaries
// ═══════════════════════════════════════════════════════════════

/**
 * Parse a single git status line (porcelain or --name-status format).
 * Returns a discriminated GitStatusEntry or null for unparseable lines.
 */
export function parseGitStatus(line: string): GitStatusEntry | null {
  // Only strip trailing newline/carriage-return — preserve leading whitespace
  // which is SEMANTIC in porcelain v1: " M file" = unstaged, "M  file" = staged.
  const raw = line.replace(/[\r\n]+$/, '');
  if (!raw || raw.length < 2) return null;

  // --name-status format: "M\tfile.ts" or "R100\told.ts\tnew.ts" (tab-separated)
  if (raw.includes('\t')) {
    const parts = raw.split('\t');
    const code = parts[0];
    if (code.startsWith('R') && parts.length >= 3) {
      return { kind: 'renamed', file: parts.slice(2).join('\t'), oldPath: parts[1], status: 'R' };
    }
    const file = parts.slice(1).join('\t');
    if (code === 'D') return { kind: 'deleted', file, status: 'D' };
    if (code === 'A') return { kind: 'staged', file, status: 'A', isRename: false };
    return { kind: 'staged', file, status: code, isRename: false };
  }

  // Porcelain v1/v2 format: "XY file.ts" — XY is exactly 2 chars, file starts at offset 3.
  // Leading space in XY is SIGNIFICANT and must NOT be trimmed.
  if (raw.length < 3) return null;
  const xy = raw.slice(0, 2);
  const rest = raw.slice(3).trim();

  // Reject spaces-only input (xy = '  ' with no filename) or empty filename
  if (xy === '  ' || rest.length === 0) return null;

  // Handle quoted paths with spaces
  let file = rest;
  if ((file.startsWith('"') && file.endsWith('"')) || (file.startsWith("'") && file.endsWith("'"))) {
    file = file.slice(1, -1);
  }

  // Rename: "R  old -> new" or "R  old.ts" → new.ts
  const xyTrimmed = xy.trim();
  if (xyTrimmed === 'R' || xy[0] === 'R') {
    const arrow = file.indexOf(' -> ');
    if (arrow > 0) {
      return { kind: 'renamed', file: file.substring(arrow + 4), oldPath: file.substring(0, arrow), status: 'R' };
    }
  }

  // Untracked: "??"
  if (xy === '??') return { kind: 'untracked', file, status: '?' };

  // Deleted staged: "D " — space at index 1 → staged deletion
  if (xy === 'D ') return { kind: 'deleted', file, status: 'D' };

  // Mixed: both columns non-space, non-? → "MM", "AM", "MD", etc.
  if (xy[0] !== ' ' && xy[1] !== ' ' && xy[0] !== '?' && xy[1] !== '?') {
    return { kind: 'mixed', file, staged: xy[0], unstaged: xy[1] };
  }

  // Staged only: "M ", "A ", "R " (space at index 1)
  if (xy[1] === ' ') return { kind: 'staged', file, status: xy[0], isRename: xy[0] === 'R' };

  // Unstaged only: " M", " D" (space at index 0)
  if (xy[0] === ' ') return { kind: 'unstaged', file, status: xy[1] };

  return null;
}

/**
 * Normalize the --files argument into a string array or null.
 * Accepts string (comma-separated), string[], or undefined.
 */
export function normalizeRequestedFiles(raw: unknown): string[] | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const parts = raw.split(',').map(f => f.trim()).filter(Boolean);
    return parts.length > 0 ? parts : null;
  }
  if (Array.isArray(raw)) {
    const parts = (raw as string[]).map(f => f.trim()).filter(Boolean);
    return parts.length > 0 ? parts : null;
  }
  return null;
}

/**
 * Deduplicate raw GitStatusEntry list into canonical changes.
 * Files with mixed staged+unstaged state are merged into one CanonicalChange
 * with multiple entries instead of duplicate identities.
 */
export function canonicalizeAndDeduplicatePaths(entries: GitStatusEntry[]): CanonicalChange[] {
  const byFile = new Map<string, GitStatusEntry[]>();

  for (const e of entries) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file)!.push(e);
  }

  const result: CanonicalChange[] = [];
  for (const [file, fileEntries] of byFile) {
    const mixed = fileEntries.some(e => e.kind === 'mixed');
    const rename = fileEntries.find(e => e.kind === 'renamed');
    const hasMixedState = mixed || (
      fileEntries.some(e => e.kind === 'staged') && fileEntries.some(e => e.kind === 'unstaged')
    );

    // For mixed, merge into one mixed entry
    const merged: GitStatusEntry[] = [];
    if (hasMixedState) {
      const stagedCodes = fileEntries
        .filter(e => e.kind === 'staged' || e.kind === 'mixed')
        .map(e => e.kind === 'mixed' ? (e as typeof e & { staged: string }).staged : (e as typeof e & { status: string }).status);
      const unstagedCodes = fileEntries
        .filter(e => e.kind === 'unstaged' || e.kind === 'mixed')
        .map(e => e.kind === 'mixed' ? (e as typeof e & { unstaged: string }).unstaged : (e as typeof e & { status: string }).status);
      merged.push({
        kind: 'mixed',
        file,
        staged: stagedCodes.join('') || 'M',
        unstaged: unstagedCodes.join('') || 'M',
      });
    } else {
      merged.push(...fileEntries);
    }

    result.push({
      file,
      entries: merged,
      oldPath: rename?.oldPath,
      hasMixedState,
    });
  }

  return result;
}

/**
 * Classify canonical changes into git categories.
 * A rename appears in renamed_files only — not duplicated as deleted.
 */
export function classifyGitEntries(changes: CanonicalChange[]): CategorisedChanges {
  const categories: CategorisedChanges = {
    tracked_changes: [],
    unstaged_changes: [],
    untracked_files: [],
    deleted_files: [],
    renamed_files: [],
  };

  for (const c of changes) {
    const primaryEntry = c.entries[0];

    if (primaryEntry.kind === 'renamed') {
      categories.renamed_files.push(c);
    } else if (primaryEntry.kind === 'deleted') {
      categories.deleted_files.push(c);
    } else if (primaryEntry.kind === 'untracked') {
      categories.untracked_files.push(c);
    } else if (primaryEntry.kind === 'unstaged') {
      categories.unstaged_changes.push(c);
    } else if (primaryEntry.kind === 'mixed') {
      // Mixed → primary bucket is tracked (staged wins), with unstaged note
      categories.tracked_changes.push(c);
      // Also add as unstaged for completeness
      categories.unstaged_changes.push(c);
    } else {
      // staged (M, A)
      categories.tracked_changes.push(c);
    }
  }

  return categories;
}

/**
 * Filter canonical changes to only those matching the requested file list.
 * Returns included and excluded lists.
 */
export function filterPrimaryScope(
  changes: CanonicalChange[],
  requestedFiles: string[] | null
): { included: CanonicalChange[]; excluded: CanonicalChange[] } {
  if (!requestedFiles || requestedFiles.length === 0) {
    return { included: changes, excluded: [] };
  }
  const allowed = new Set(requestedFiles);
  const included: CanonicalChange[] = [];
  const excluded: CanonicalChange[] = [];
  for (const c of changes) {
    if (allowed.has(c.file)) {
      included.push(c);
    } else {
      excluded.push(c);
    }
  }
  return { included, excluded };
}

/**
 * Classify impact evidence tier from edge counts and caller info.
 */
export function classifyImpactEvidence(params: {
  directCallsCount: number;
  importEdgesCount: number;
  sameModuleCallerCount: number;
}): ImpactEvidence {
  const reasons: string[] = [];

  if (params.directCallsCount > 0) {
    reasons.push(`${params.directCallsCount} direct CALLS edge(s) from other symbols`);
    return { tier: 'confirmed', reasons };
  }

  if (params.importEdgesCount > 0) {
    reasons.push(`${params.importEdgesCount} IMPORTS edge(s) to this file`);
    return { tier: 'confirmed', reasons };
  }

  if (params.sameModuleCallerCount > 0) {
    reasons.push(`${params.sameModuleCallerCount} caller(s) in same module or directory`);
    reasons.push('Evidence: same-file or same-package scope (probable, not confirmed by edge)');
    return { tier: 'probable', reasons };
  }

  reasons.push('No CALLS or IMPORTS edges found — name-only coincidence');
  return { tier: 'nominal', reasons };
}

/**
 * Deduplicate related dependencies by canonical path + symbol + direction.
 */
export function deduplicateRelatedDependencies(deps: RelatedDependency[]): RelatedDependency[] {
  const seen = new Set<string>();
  const result: RelatedDependency[] = [];
  for (const d of deps) {
    const key = `${d.scopeFile}|${d.scopeSymbol || ''}|${d.relatedFile}|${d.relatedSymbol || ''}|${d.direction}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(d);
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// Internal types (not exported — handler internals)
// ═══════════════════════════════════════════════════════════════

interface LlmRiskAssessment {
  risk: string;
  reason: string;
  fan_in: number;
  source: string;
  latency_ms: number;
}

interface InternalChangedNode {
  name: string;
  qualified_name: string;
  file_path: string;
  kind: string;
  callers: string[];
  caller_count: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  is_hotspot: boolean;
  impacted_symbols?: string[];
  impact_tier: ImpactTier;
  impact_evidence: string[];
  llm_risk?: LlmRiskAssessment;
}

// ═══════════════════════════════════════════════════════════════
// Handler
// ═══════════════════════════════════════════════════════════════

export function isGitWorkTree(rootPath: string): boolean {
  try {
    child_process.execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: rootPath,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/** Collect raw GitStatusEntry list from git porcelain + diff commands. */
function collectGitEntries(rootPath: string, baseBranch: string, since?: string): {
  rawEntries: GitStatusEntry[];
  committedRef: string | null;
} {
  const rawEntries: GitStatusEntry[] = [];
  let committedRef: string | null = null;

  committedRef = since || `${baseBranch}...HEAD`;
  try {
    const out = child_process.execSync(
      `git diff --name-status ${committedRef}`,
      { cwd: rootPath, encoding: 'utf-8', timeout: 15000 }
    );
    for (const line of out.trim().split('\n')) {
      const parsed = parseGitStatus(line);
      if (parsed) rawEntries.push(parsed);
    }
  } catch {
    try {
      const out = child_process.execSync(
        'git diff --name-status HEAD~1',
        { cwd: rootPath, encoding: 'utf-8', timeout: 10000 }
      );
      for (const line of out.trim().split('\n')) {
        const parsed = parseGitStatus(line);
        if (parsed) rawEntries.push(parsed);
      }
      committedRef = 'HEAD~1';
    } catch { /* no commits */ }
  }

  try {
    const out = child_process.execSync(
      'git diff --name-only',
      { cwd: rootPath, encoding: 'utf-8', timeout: 5000 }
    );
    for (const rawLine of out.trim().split('\n')) {
      const file = rawLine.trim();
      if (file) rawEntries.push({ kind: 'unstaged', file, status: 'M' });
    }
  } catch { /* ignore */ }

  try {
    const out = child_process.execSync(
      'git --no-optional-locks status --porcelain --untracked-files=normal',
      { cwd: rootPath, encoding: 'utf-8', timeout: 5000 }
    );
    for (const line of out.trim().split('\n')) {
      const parsed = parseGitStatus(line);
      if (parsed) rawEntries.push(parsed);
    }
  } catch { /* ignore */ }

  return { rawEntries, committedRef };
}

/** Collect per-file diffs for the given changes (up to 50 files). */
function collectFileDiffs(
  rootPath: string,
  allChanges: CanonicalChange[],
  committedRef: string | null,
): Map<string, string> {
  const fileDiffMap = new Map<string, string>();
  if (!committedRef || allChanges.length > 50) return fileDiffMap;

  for (const c of allChanges) {
    if (c.entries[0]?.kind === 'deleted' || c.entries[0]?.kind === 'renamed') continue;
    try {
      const diffOut = child_process.execSync(
        `git diff ${committedRef} -- "${c.file}"`,
        { cwd: rootPath, encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024 }
      );
      if (diffOut.trim()) fileDiffMap.set(c.file, diffOut.trim());
    } catch { /* ignore */ }
    if (!fileDiffMap.has(c.file)) {
      try {
        const diffOut = child_process.execSync(
          `git diff -- "${c.file}"`,
          { cwd: rootPath, encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024 }
        );
        if (diffOut.trim()) fileDiffMap.set(c.file, diffOut.trim());
      } catch { /* ignore */ }
    }
  }
  return fileDiffMap;
}

/** Symbol-level analysis: for each changed file, query graph nodes and classify impact. */
function analyzeChangedSymbols(
  db: ReturnType<typeof getDb>,
  project: string,
  allChanges: CanonicalChange[],
  hotspotQns: Set<string>,
  depth: number,
): { changedNodes: InternalChangedNode[]; allCallers: Set<string>; scopedNodeIds: Set<number> } {
  const changedNodes: InternalChangedNode[] = [];
  const allCallers = new Set<string>();
  const scopedNodeIds = new Set<number>();

  for (const c of allChanges) {
    const nodes = db.db.prepare(
      `SELECT id, name, qualified_name, file_path, kind, start_line, end_line FROM nodes
       WHERE project = ? AND file_path = ?`
    ).all(project, c.file) as Array<{ id: number; name: string; qualified_name: string; file_path: string; kind: string; start_line: number; end_line: number }>;

    for (const node of nodes) {
      scopedNodeIds.add(node.id);
      const { callers } = getNeighborNames(db, node.id, 30);
      for (const cn of callers) allCallers.add(cn);

      const callerCount = callers.length;
      const isHotspot = hotspotQns.has(node.qualified_name);
      const severity = classifySeverity(callerCount, isHotspot);

      const directCalls = db.db.prepare(
        `SELECT COUNT(*) as cnt FROM edges WHERE target_id = ? AND type = 'CALLS'`
      ).get(node.id) as { cnt: number };
      const importEdges = db.db.prepare(
        `SELECT COUNT(*) as cnt FROM edges WHERE target_id = ? AND type = 'IMPORTS'`
      ).get(node.id) as { cnt: number };
      const sameModuleCallers = callers.filter(cn => {
        const callerNode = db.db.prepare(
          'SELECT file_path FROM nodes WHERE project = ? AND qualified_name = ?'
        ).get(project, cn) as { file_path: string } | undefined;
        return callerNode && (callerNode.file_path === node.file_path || path.dirname(callerNode.file_path) === path.dirname(node.file_path));
      });

      const { tier, reasons } = classifyImpactEvidence({
        directCallsCount: directCalls.cnt,
        importEdgesCount: importEdges.cnt,
        sameModuleCallerCount: sameModuleCallers.length,
      });

      let impactedSymbols: string[] = [];
      if (depth > 0 && callerCount > 0) {
        try {
          const trace = bfsTraverse(db, node.id, 'inbound', ['CALLS'], depth, 50);
          if (trace) impactedSymbols = trace.visited.slice(0, 20).map(v => v.node.qualifiedName);
        } catch { /* ignore */ }
      }

      changedNodes.push({
        name: node.name,
        qualified_name: node.qualified_name,
        file_path: node.file_path,
        kind: node.kind,
        callers: callers.slice(0, 10),
        caller_count: callerCount,
        severity,
        is_hotspot: isHotspot,
        impacted_symbols: impactedSymbols.length > 0 ? impactedSymbols : undefined,
        impact_tier: tier,
        impact_evidence: reasons,
      });
    }
  }

  return { changedNodes, allCallers, scopedNodeIds };
}

/** Find graph edges from scoped nodes to files outside the scope. */
function buildRelatedDependencies(
  db: ReturnType<typeof getDb>,
  project: string,
  scopedNodeIds: Set<number>,
  scopedFileSet: Set<string>,
): RelatedDependency[] {
  const relatedDeps: RelatedDependency[] = [];

  for (const nodeId of scopedNodeIds) {
    const deps = db.db.prepare(
      `SELECT e.type, e.source_id, e.target_id,
              src.qualified_name as src_qn, src.file_path as src_file,
              tgt.qualified_name as tgt_qn, tgt.file_path as tgt_file
       FROM edges e
       JOIN nodes src ON src.id = e.source_id
       JOIN nodes tgt ON tgt.id = e.target_id
       WHERE (e.source_id = ? OR e.target_id = ?)
         AND e.type IN ('CALLS', 'IMPORTS', 'USAGE')`
    ).all(nodeId, nodeId) as Array<{ type: string; source_id: number; target_id: number; src_qn: string; src_file: string; tgt_qn: string; tgt_file: string }>;

    for (const dep of deps) {
      const isSrcInScope = scopedFileSet.has(dep.src_file);
      const isTgtInScope = scopedFileSet.has(dep.tgt_file);
      if (isSrcInScope === isTgtInScope) continue;

      const relatedFile = isSrcInScope ? dep.tgt_file : dep.src_file;
      const relatedSymbol = isSrcInScope ? dep.tgt_qn : dep.src_qn;
      const scopeFile = isSrcInScope ? dep.src_file : dep.tgt_file;
      const scopeSymbol = isSrcInScope ? dep.src_qn : dep.tgt_qn;
      const direction = isSrcInScope ? 'outbound' : 'inbound';

      relatedDeps.push({
        scopeFile,
        scopeSymbol,
        relatedFile,
        relatedSymbol,
        direction,
        edgeType: dep.type,
        reason: `${dep.type} edge between ${dep.src_qn} and ${dep.tgt_qn}`,
        confidence: dep.type === 'IMPORTS' ? 'high' : dep.type === 'CALLS' ? 'high' : 'medium',
      });
    }
  }

  return deduplicateRelatedDependencies(relatedDeps);
}

/** Run LLM-based risk assessment on critical/high-severity changed nodes. */
async function runLlmRiskAssessment(
  db: ReturnType<typeof getDb>,
  project: string,
  rootPath: string,
  changedNodes: InternalChangedNode[],
  fileDiffMap: Map<string, string>,
  enableLlm: boolean,
): Promise<{ llmUsage: LlmUsage }> {
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

  if (!enableLlm) {
    llmUsage.fallback_reason = 'enable_llm=false, skipped risk assessment';
    return { llmUsage };
  }

  const llmCandidates = changedNodes.filter(n => n.severity === 'critical' || n.severity === 'high').slice(0, 5);
  let llmTotalLatency = 0;
  let attemptedProvider = '';

  for (const node of llmCandidates) {
    const fullPath = path.join(rootPath, node.file_path);
    let funcSource = '';
    try {
      const fileContent = fs.readFileSync(fullPath, 'utf8');
      const lines = fileContent.split('\n');
      const dbNode = db.db.prepare(
        'SELECT start_line, end_line FROM nodes WHERE project = ? AND qualified_name = ?'
      ).get(project, node.qualified_name) as { start_line: number; end_line: number } | undefined;
      if (dbNode) {
        const start = Math.max(0, dbNode.start_line - 1);
        const end = dbNode.end_line > dbNode.start_line ? dbNode.end_line : Math.min(start + 200, lines.length);
        funcSource = lines.slice(start, end).join('\n');
      } else {
        funcSource = fileContent.slice(0, 3000);
      }
    } catch { funcSource = '[source not readable]'; }

    const diff = fileDiffMap.get(node.file_path) || '[diff not available]';
    try {
      const callStart = Date.now();
      const llmResult = await assessRiskWithMeta(node.name, funcSource, node.callers, node.caller_count,
        `Status: modified, File: ${node.file_path}, Impact: ${node.impact_tier}\n${diff.slice(0, 1500)}`);
      const callLatency = Date.now() - callStart;
      llmTotalLatency += callLatency;
      llmUsage.calls++;
      llmUsage.provider = llmResult.provider;
      llmUsage.model = llmResult.model || null;
      llmUsage.fallback_used = llmUsage.fallback_used || llmResult.fallback;
      if (llmResult.provider !== 'heuristic') attemptedProvider = llmResult.provider;
      node.llm_risk = {
        risk: llmResult.risk,
        reason: llmResult.reason,
        fan_in: node.caller_count,
        source: llmResult.provider,
        latency_ms: callLatency,
      };
    } catch {
      llmUsage.fallback_used = true;
    }
  }

  llmUsage.latency_ms = llmTotalLatency;
  llmUsage.used = llmUsage.calls > 0;
  if (llmUsage.used && llmUsage.fallback_used) {
    if (attemptedProvider && attemptedProvider !== 'heuristic') {
      llmUsage.fallback_reason = `${attemptedProvider} risk assessment failed for >=1 of ${llmUsage.calls} call(s), used heuristic`;
    } else {
      llmUsage.fallback_reason = `heuristic-only risk assessment used for ${llmUsage.calls} call(s)`;
    }
  }

  return { llmUsage };
}

export async function handleDetectChanges(
  args: Record<string, unknown>
): Promise<DetectChangesResult> {
  const project = String(args.project || '');
  const baseBranch = (args.base_branch as string) || 'main';
  const since = args.since ? String(args.since) : undefined;
  const scope = (args.scope as string) === 'files' ? 'files' : 'symbols';
  const depth = args.depth !== undefined ? Number(args.depth) : 2;
  const enableLlm = args.enable_llm !== false;
  const includeDiff = args.include_diff !== false;
  const requestedFiles = normalizeRequestedFiles(args.files);
  const pathFilterRegex = args.path_filter ? new RegExp(String(args.path_filter)) : null;

  const db = getDb(project);
  const projectMeta = db.getProject(project);
  if (!projectMeta) {
    const diag = projectNotIndexed(project);
    return {
      contract_version: DETECT_CHANGES_CONTRACT_VERSION,
      project, base_branch: baseBranch, since: since || null, scope, depth,
      error: diag.error, hint: diag.hint, recoverable: diag.recoverable,
      categories: {},
      category_counts: { tracked_changes: 0, unstaged_changes: 0, untracked_files: 0, deleted_files: 0, renamed_files: 0, total: 0 },
      impact_assessment: { confirmed_count: 0, probable_count: 0, nominal_count: 0, confirmed: [], probable: [], nominal: [] },
      related_dependencies: [], related_dependencies_count: 0,
      changed_files: [], changed_nodes: [], total_changed_files: 0, total_affected_nodes: 0,
      by_severity: { critical: 0, high: 0, medium: 0, low: 0 }, indirect_callers_affected: 0,
      impact_analysis: { summary: diag.error, risk_level: 'low', details: [] },
      llm_usage: { enabled: enableLlm, used: false, provider: null, model: null, calls: 0, latency_ms: 0, fallback_used: false, fallback_reason: diag.error },
    };
  }
  const rootPath = projectMeta.rootPath;
  if (!isGitWorkTree(rootPath)) {
    return {
      ...buildEmptyResult(project, baseBranch, since, scope, depth, enableLlm),
      error: 'Project root is not a Git work tree.',
      hint: 'Initialize Git or run detect_changes on a repository root.',
      recoverable: true,
    };
  }

  // ── Git collection ────────────────────────────────────────────
  let rawEntries: GitStatusEntry[];
  let committedRef: string | null;
  try {
    const collected = collectGitEntries(rootPath, baseBranch, since);
    rawEntries = collected.rawEntries;
    committedRef = collected.committedRef;
  } catch {
    return {
      ...buildEmptyResult(project, baseBranch, since, scope, depth, enableLlm),
      impact_analysis: { summary: 'Cannot get git diff.', risk_level: 'low', details: [] },
      llm_usage: { enabled: enableLlm, used: false, provider: null, model: null, calls: 0, latency_ms: 0, fallback_used: false, fallback_reason: 'git diff failed' },
    };
  }

  // ── Pipeline ─────────────────────────────────────────────────
  let changes = canonicalizeAndDeduplicatePaths(rawEntries);
  if (pathFilterRegex) changes = changes.filter(c => pathFilterRegex.test(c.file));

  const { included, excluded } = filterPrimaryScope(changes, requestedFiles);

  if (requestedFiles && requestedFiles.length > 0) {
    for (const f of requestedFiles) {
      if (!included.some(c => c.file === f) && !excluded.some(c => c.file === f)) {
        const graphNodes = db.db.prepare(
          'SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND file_path = ?'
        ).get(project, f) as { cnt: number } | undefined;
        if (graphNodes && graphNodes.cnt > 0) {
          included.push({ file: f, entries: [{ kind: 'untracked', file: f, status: '?' }], hasMixedState: false });
        }
      }
    }
  }

  const categories = classifyGitEntries(requestedFiles ? included : changes);
  const allChanges = requestedFiles ? included : changes;

  if (allChanges.length === 0) return buildEmptyResult(project, baseBranch, since, scope, depth, enableLlm);
  if (scope === 'files') return buildFilesOnlyResult(project, baseBranch, since, categories, allChanges.length, enableLlm);

  const fileDiffMap = collectFileDiffs(rootPath, allChanges, committedRef);

  // ── Symbol-level analysis ────────────────────────────────────
  const hotspotRows = db.db.prepare(
    `SELECT n.id, n.qualified_name, n.name, n.file_path,
            (SELECT COUNT(*) FROM edges e WHERE e.target_id = n.id AND e.type = 'CALLS') as fan_in,
            json_extract(n.properties, '$.cyclomaticComplexity') as complexity
     FROM nodes n WHERE n.project = ? AND n.kind IN ('Function', 'Method')
     ORDER BY fan_in DESC LIMIT 50`
  ).all(project) as Array<{ id: number; qualified_name: string; name: string; file_path: string; fan_in: number; complexity: number }>;

  const hotspotQns = new Set(hotspotRows.map(h => h.qualified_name));
  const { changedNodes, allCallers, scopedNodeIds } = analyzeChangedSymbols(db, project, allChanges, hotspotQns, depth);

  // ── Related dependencies ─────────────────────────────────────
  const scopedFileSet = requestedFiles ? new Set(requestedFiles) : null;
  const dedupedDeps = scopedFileSet && scopedFileSet.size > 0
    ? buildRelatedDependencies(db, project, scopedNodeIds, scopedFileSet)
    : [];

  // ── LLM Risk Assessment ──────────────────────────────────────
  const { llmUsage } = await runLlmRiskAssessment(db, project, rootPath, changedNodes, fileDiffMap, enableLlm);

  // ── Sort & trim ──────────────────────────────────────────────
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  changedNodes.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const MAX_FILES = 50, MAX_NODES = 30, MAX_CALLERS = 5, MAX_IMPACTED = 5, MAX_DIFF = 3000;
  for (const node of changedNodes) {
    node.callers = node.callers.slice(0, MAX_CALLERS);
    if (node.impacted_symbols) node.impacted_symbols = node.impacted_symbols.slice(0, MAX_IMPACTED);
  }

  // ── Build result ─────────────────────────────────────────────
  const confirmedNodes = changedNodes.filter(n => n.impact_tier === 'confirmed');
  const probableNodes = changedNodes.filter(n => n.impact_tier === 'probable');
  const nominalNodes = changedNodes.filter(n => n.impact_tier === 'nominal');

  const impactEntry = (n: InternalChangedNode) => ({
    name: n.name, qualified_name: n.qualified_name, file_path: n.file_path, evidence: n.impact_evidence,
  });

  const fileToCompat = (c: CanonicalChange): CompatFileEntry => {
    const primary = c.entries[0];
    const st = primary.kind === 'mixed' ? 'MM' : primary.kind === 'staged' ? (primary as typeof primary & { status: string }).status
      : primary.kind === 'unstaged' ? (primary as typeof primary & { status: string }).status
      : primary.kind === 'untracked' ? '?' : primary.kind === 'deleted' ? 'D' : 'R';
    const entry: CompatFileEntry = { file: c.file, status: st };
    if (c.oldPath) entry.old_path = c.oldPath;
    if (includeDiff && fileDiffMap.has(c.file)) {
      const diff = fileDiffMap.get(c.file)!;
      entry.diff = diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) : diff;
    }
    return entry;
  };

  const narrative = buildNarrative(changedNodes, allChanges.length, allCallers.size);

  return {
    contract_version: DETECT_CHANGES_CONTRACT_VERSION,
    project, base_branch: baseBranch, since: since || null, scope, depth,
    categories: {
      tracked_changes: categories.tracked_changes.slice(0, MAX_FILES).map(c => ({ file: c.file, status: c.entries[0]?.kind === 'mixed' ? 'MM' : 'M', old_path: c.oldPath || null })),
      unstaged_changes: categories.unstaged_changes.slice(0, MAX_FILES).map(c => ({ file: c.file, status: 'M (unstaged)', old_path: c.oldPath || null })),
      untracked_files: categories.untracked_files.slice(0, MAX_FILES).map(c => ({ file: c.file, status: '?', old_path: null })),
      deleted_files: categories.deleted_files.slice(0, MAX_FILES).map(c => ({ file: c.file, status: 'D', old_path: null })),
      renamed_files: categories.renamed_files.slice(0, MAX_FILES).map(c => ({ file: c.file, status: 'R', old_path: c.oldPath || null })),
    },
    category_counts: {
      tracked_changes: categories.tracked_changes.length, unstaged_changes: categories.unstaged_changes.length,
      untracked_files: categories.untracked_files.length, deleted_files: categories.deleted_files.length,
      renamed_files: categories.renamed_files.length, total: allChanges.length,
    },
    impact_assessment: {
      confirmed_count: confirmedNodes.length, probable_count: probableNodes.length, nominal_count: nominalNodes.length,
      confirmed: confirmedNodes.slice(0, MAX_NODES).map(impactEntry),
      probable: probableNodes.slice(0, MAX_NODES).map(impactEntry),
      nominal: nominalNodes.slice(0, MAX_NODES).map(impactEntry),
    },
    related_dependencies: dedupedDeps.slice(0, 30).map(d => ({
      scope_file: d.scopeFile, scope_symbol: d.scopeSymbol,
      related_file: d.relatedFile, related_symbol: d.relatedSymbol,
      direction: d.direction, edge_type: d.edgeType, reason: d.reason, confidence: d.confidence,
    })),
    related_dependencies_count: dedupedDeps.length,
    changed_files: allChanges.slice(0, MAX_FILES).map(fileToCompat),
    changed_nodes: changedNodes.slice(0, MAX_NODES).map(n => ({
      name: n.name, qualified_name: n.qualified_name, file_path: n.file_path, kind: n.kind,
      callers: n.callers, caller_count: n.caller_count, severity: n.severity,
      is_hotspot: n.is_hotspot, impacted_symbols: n.impacted_symbols,
      impact_tier: n.impact_tier, impact_evidence: n.impact_evidence,
      llm_risk: n.llm_risk || null,
    })),
    total_changed_files: allChanges.length, total_affected_nodes: changedNodes.length,
    by_severity: {
      critical: changedNodes.filter(n => n.severity === 'critical').length,
      high: changedNodes.filter(n => n.severity === 'high').length,
      medium: changedNodes.filter(n => n.severity === 'medium').length,
      low: changedNodes.filter(n => n.severity === 'low').length,
    },
    indirect_callers_affected: allCallers.size,
    impact_analysis: narrative,
    llm_usage: llmUsage,
  };
}

// ═══════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════

function classifySeverity(callers: number, isHotspot: boolean): 'critical' | 'high' | 'medium' | 'low' {
  if (isHotspot && callers >= 10) return 'critical';
  if (isHotspot || callers >= 20) return 'critical';
  if (callers >= 10) return 'high';
  if (callers >= 3) return 'medium';
  return 'low';
}

function buildEmptyResult(project: string, baseBranch: string, since: string | undefined, scope: 'files' | 'symbols', depth: number, enableLlm = true): DetectChangesResult {
  return {
    contract_version: DETECT_CHANGES_CONTRACT_VERSION,
    project,
    base_branch: baseBranch,
    since: since || null,
    scope,
    depth,
    categories: { tracked_changes: [], unstaged_changes: [], untracked_files: [], deleted_files: [], renamed_files: [] },
    category_counts: { tracked_changes: 0, unstaged_changes: 0, untracked_files: 0, deleted_files: 0, renamed_files: 0, total: 0 },
    impact_assessment: { confirmed_count: 0, probable_count: 0, nominal_count: 0, confirmed: [], probable: [], nominal: [] },
    related_dependencies: [],
    related_dependencies_count: 0,
    changed_files: [],
    changed_nodes: [],
    total_changed_files: 0,
    total_affected_nodes: 0,
    by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
    indirect_callers_affected: 0,
    impact_analysis: { summary: 'No changes detected.', risk_level: 'low', details: ['No files changed.'] },
    llm_usage: { enabled: enableLlm, used: false, provider: null, model: null, calls: 0, latency_ms: 0, fallback_used: false, fallback_reason: 'no changes detected' },
  };
}

function buildFilesOnlyResult(project: string, baseBranch: string, since: string | undefined, categories: CategorisedChanges, total: number, enableLlm = true): DetectChangesResult {
  return {
    contract_version: DETECT_CHANGES_CONTRACT_VERSION,
    project,
    base_branch: baseBranch,
    since: since || null,
    scope: 'files',
    depth: 0,
    categories: {
      tracked_changes: categories.tracked_changes.map(c => ({ file: c.file, status: 'M', old_path: c.oldPath || null })),
      unstaged_changes: categories.unstaged_changes.map(c => ({ file: c.file, status: 'M (unstaged)', old_path: c.oldPath || null })),
      untracked_files: categories.untracked_files.map(c => ({ file: c.file, status: '?', old_path: null })),
      deleted_files: categories.deleted_files.map(c => ({ file: c.file, status: 'D', old_path: null })),
      renamed_files: categories.renamed_files.map(c => ({ file: c.file, status: 'R', old_path: c.oldPath || null })),
    },
    category_counts: {
      tracked_changes: categories.tracked_changes.length,
      unstaged_changes: categories.unstaged_changes.length,
      untracked_files: categories.untracked_files.length,
      deleted_files: categories.deleted_files.length,
      renamed_files: categories.renamed_files.length,
      total,
    },
    impact_assessment: { confirmed_count: 0, probable_count: 0, nominal_count: 0, confirmed: [], probable: [], nominal: [] },
    related_dependencies: [],
    related_dependencies_count: 0,
    changed_files: [],
    changed_nodes: [],
    total_changed_files: total,
    total_affected_nodes: 0,
    by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
    indirect_callers_affected: 0,
    impact_analysis: { summary: `${total} files changed (scope=files).`, risk_level: 'low', details: [] },
    llm_usage: { enabled: enableLlm, used: false, provider: null, model: null, calls: 0, latency_ms: 0, fallback_used: false, fallback_reason: 'scope=files, skipped risk assessment' },
  };
}

function buildNarrative(
  nodes: InternalChangedNode[],
  totalFiles: number,
  indirectCallers: number
): { summary: string; risk_level: string; details: string[] } {
  const details: string[] = [];
  let riskLevel = 'low';

  const criticals = nodes.filter(n => n.severity === 'critical');
  const highs = nodes.filter(n => n.severity === 'high');
  const hotspots = nodes.filter(n => n.is_hotspot);
  const confirmed = nodes.filter(n => n.impact_tier === 'confirmed');

  details.push(`${totalFiles} files changed, ${nodes.length} graph nodes affected.`);
  details.push(`Impact: ${confirmed.length} confirmed, ${nodes.filter(n => n.impact_tier === 'probable').length} probable, ${nodes.filter(n => n.impact_tier === 'nominal').length} nominal.`);

  if (criticals.length > 0) { riskLevel = 'critical'; details.push(`CRITICAL: ${criticals.length} nodes with critical severity.`); }
  if (hotspots.length > 0 && riskLevel === 'low') riskLevel = 'high';
  if (highs.length > 0 && riskLevel === 'low') riskLevel = 'high';

  const summary = riskLevel === 'critical'
    ? `High-risk: ${criticals.length} critical, ${hotspots.length} hotspots. Review required.`
    : riskLevel === 'high'
      ? `Significant risk: ${highs.length} high-severity, ${hotspots.length} hotspots.`
      : `Moderate risk. ${nodes.length} nodes, limited impact.`;

  return { summary, risk_level: riskLevel, details };
}
