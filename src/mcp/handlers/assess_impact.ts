/*
 * assess_impact.ts — Cross-reference git changes with graph and tests.
 *
 * Contract version: 1 (2026-07-10)
 *
 * Five queries, one shared evidence model. Each finding distinguishes:
 *   - confirmed evidence (edge-backed)
 *   - heuristic evidence (convention-based)
 *   - unknown (cannot determine — index/Git/test edges unavailable)
 *   - absence of evidence (searched but found nothing)
 *
 * Queries:
 *   1. tests_covering_changes    — batch find_tests for modified symbols
 *   2. untested_changes          — files in diff lacking test coverage
 *   3. new_symbols_no_callers    — Function/Method with fan_in=0
 *   4. deleted_symbols_live_refs — deleted but still referenced symbols
 *   5. unindexed_modified_files  — git diff files not in graph
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDb } from '../server.js';
import { getModifiedFiles } from '../../git/diff.js';
import { discoverInvariants, checkInvariantsBroken, type InvariantViolation } from './check_invariants.js';
import { loadRules, detectArchitectureViolations, type RuleViolation } from '../../rules/engine.js';

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi', '.pyx',
  '.go',
  '.java', '.kt', '.kts', '.scala',
  '.rs',
  '.rb',
  '.cs',
  '.swift',
  '.cpp', '.c', '.cc', '.cxx', '.h', '.hpp',
  '.php',
  '.ex', '.exs',
  '.elm',
  '.dart',
]);

function isCodeFilePath(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

function isTestFilePath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/tests/') || normalized.includes('/test/') ||
    normalized.startsWith('tests/') || normalized.startsWith('test/') ||
    normalized.includes('__tests__/') || normalized.includes('.test.') || normalized.includes('.spec.');
}

const DEFAULT_MAX_FINDINGS = 30;

// ═══════════════════════════════════════════════════════════════
// Shared evidence model
// ═══════════════════════════════════════════════════════════════

export const ASSESS_IMPACT_CONTRACT_VERSION = 2;

export type AssessmentCategory =
  | 'tests_covering_changes'
  | 'untested_changes'
  | 'new_symbols_no_callers'
  | 'deleted_symbols_live_refs'
  | 'unindexed_modified_files'
  | 'downstream_dependents'
  | 'async_dependents';

export type EvidenceStrength = 'confirmed' | 'heuristic' | 'unknown' | 'searched_not_found';

export interface EvidenceItem {
  source: string;           // e.g. "TESTS edge", "CALLS edge", "name convention"
  detail: string;           // human-readable description
  strength: EvidenceStrength;
}

export interface ImpactFinding {
  category: AssessmentCategory;
  symbol?: string;
  qualified_name?: string;
  file: string;
  detail: string;
  evidence: EvidenceItem[];
  overall_confidence: 'high' | 'medium' | 'low';
  suggested_action?: string;
}

export interface AssessImpactResult {
  contract_version: number;
  project: string;
  scope: { files?: string[]; base_branch: string };
  summary: string;
  total_findings: number;
  returned_findings: number;
  truncated: number;
  limit: number;
  offset?: number;
  category_filter?: string;
  findings_by_category: Record<string, number>;
  findings: ImpactFinding[];
  direct_dependent_files: string[];
  async_dependent_files: string[];
  sibling_invariants_broken: InvariantViolation[];
  architecture_rules_broken: RuleViolation[];
  ignored_files?: { count: number; examples: string[]; reason: string };
  uncertainties: string[];
  recommended_inspection: string[];
  confidence_note: string;
}

// ═══════════════════════════════════════════════════════════════
// Reusable helpers
// ═══════════════════════════════════════════════════════════════

export function normalizeFileArg(raw: unknown): string[] | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const parts = raw.split(',').map(f => f.trim()).filter(Boolean);
    return parts.length > 0 ? parts : null;
  }
  if (Array.isArray(raw)) {
    const parts = raw.flatMap(item => {
      if (typeof item === 'string') return item.split(',').map(f => f.trim());
      if (item && typeof item === 'object' && typeof (item as { file?: unknown }).file === 'string') {
        return [(item as { file: string }).file.trim()];
      }
      return [];
    }).filter(Boolean);
    return parts.length > 0 ? parts : null;
  }
  if (typeof raw === 'object' && typeof (raw as { file?: unknown }).file === 'string') {
    return normalizeFileArg((raw as { file: string }).file);
  }
  return null;
}

/** Accept the file-shaped output of detect_changes and singular natural aliases. */
export function resolveRequestedFiles(args: Record<string, unknown>): string[] | null {
  return normalizeFileArg(args.files)
    || normalizeFileArg(args.file)
    || normalizeFileArg(args.target)
    || normalizeFileArg(args.changed_files);
}

// getModifiedFiles is shared in src/git/diff.ts

export function isFileIndexed(db: ReturnType<typeof getDb>, project: string, relPath: string): boolean {
  const cnt = db.db.prepare(
    'SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND file_path = ?'
  ).get(project, relPath) as { cnt: number };
  return cnt.cnt > 0;
}

// ═══════════════════════════════════════════════════════════════
// Query 1: Tests covering modified symbols
// ═══════════════════════════════════════════════════════════════

export function queryTestsCoveringChanges(
  db: ReturnType<typeof getDb>,
  project: string,
  diffFiles: string[]
): ImpactFinding[] {
  const findings: ImpactFinding[] = [];

  for (const file of diffFiles) {
    // Test files are the evidence, not production code that needs its own coverage.
    if (isTestFilePath(file)) continue;
    if (!isFileIndexed(db, project, file)) continue; // Query 5 handles unindexed

    const symbols = db.db.prepare(
      `SELECT id, name, qualified_name FROM nodes
       WHERE project = ? AND file_path = ? AND kind IN ('Function', 'Method')`
    ).all(project, file) as Array<{ id: number; name: string; qualified_name: string }>;

    for (const sym of symbols) {
      const testEdges = db.db.prepare(
        `SELECT src.qualified_name as test_qn, src.file_path as test_file
         FROM edges e JOIN nodes src ON src.id = e.source_id
         WHERE e.target_id = ? AND e.type = 'TESTS'
         LIMIT 10`
      ).all(sym.id) as Array<{ test_qn: string; test_file: string }>;

      const testFileEdges = db.db.prepare(
        `SELECT src.file_path as test_file, src.qualified_name as test_qn
         FROM edges e JOIN nodes src ON src.id = e.source_id
         WHERE e.target_id = (SELECT id FROM nodes WHERE project = ? AND file_path = ? AND kind = 'File' LIMIT 1)
           AND e.type = 'TESTS_FILE'
         LIMIT 10`
      ).all(project, file) as Array<{ test_file: string; test_qn: string }>;

      const evidenceItems: EvidenceItem[] = [];
      const testFiles = new Set<string>();

      for (const e of testEdges) {
        evidenceItems.push({ source: 'TESTS edge', detail: `${e.test_qn} → ${sym.qualified_name}`, strength: 'confirmed' });
        testFiles.add(e.test_file);
      }
      for (const e of testFileEdges) {
        evidenceItems.push({ source: 'TESTS_FILE edge', detail: `${e.test_file} → ${file}`, strength: 'confirmed' });
        testFiles.add(e.test_file);
      }

      if (testEdges.length > 0 || testFileEdges.length > 0) {
        findings.push({
          category: 'tests_covering_changes',
          symbol: sym.name,
          qualified_name: sym.qualified_name,
          file,
          detail: `Covered by ${testFiles.size} test file(s)`,
          evidence: evidenceItems,
          overall_confidence: 'high',
          suggested_action: 'Verify these tests still pass after changes.',
        });
      } else {
        // Searched — no test relation found
        evidenceItems.push({ source: 'graph search', detail: 'No TESTS or TESTS_FILE edges found for this symbol', strength: 'searched_not_found' });
        findings.push({
          category: 'untested_changes',
          symbol: sym.name,
          qualified_name: sym.qualified_name,
          file,
          detail: `No test coverage found for ${sym.name}`,
          evidence: evidenceItems,
          overall_confidence: 'medium',
          suggested_action: `Write a test for ${sym.name} before further modification.`,
        });
      }
    }
  }

  return findings;
}

// ═══════════════════════════════════════════════════════════════
// Query 2: Untested changed files (file-level)
// ═══════════════════════════════════════════════════════════════

export function queryUntestedFiles(
  db: ReturnType<typeof getDb>,
  project: string,
  diffFiles: string[]
): ImpactFinding[] {
  const findings: ImpactFinding[] = [];

  for (const file of diffFiles) {
    if (isTestFilePath(file)) continue;
    // Unindexed code files belong in queryUnindexedModified, not here.
    if (!isFileIndexed(db, project, file)) continue;
    // Non-code files are pre-filtered by the orchestrator — skip defensively.
    if (!isCodeFilePath(file)) continue;

    const testRelations = db.db.prepare(
      `SELECT COUNT(*) as cnt FROM edges e
       JOIN nodes src ON src.id = e.source_id
       JOIN nodes tgt ON tgt.id = e.target_id
       WHERE tgt.project = ? AND tgt.file_path = ? AND tgt.kind = 'File'
         AND e.type = 'TESTS_FILE' AND src.is_test = 1
       UNION ALL
       SELECT COUNT(*) as cnt FROM edges e
       JOIN nodes src ON src.id = e.source_id
       JOIN nodes tgt ON tgt.id = e.target_id
       WHERE tgt.project = ? AND tgt.file_path = ? AND tgt.kind IN ('Function', 'Method')
         AND e.type = 'TESTS' AND src.is_test = 1`
    ).all(project, file, project, file) as Array<{ cnt: number }>;

    if (testRelations.every(relation => relation.cnt === 0)) {
      const relatedTests = db.db.prepare(
        `SELECT DISTINCT file_path FROM nodes
         WHERE project = ? AND is_test = 1
           AND file_path LIKE ?
         LIMIT 5`
      ).all(project, `%${path.basename(file, path.extname(file))}%`) as Array<{ file_path: string }>;

      const evidence: EvidenceItem[] = [{
        source: 'graph search',
        detail: 'No TESTS or TESTS_FILE edges with is_test=1 found',
        strength: 'searched_not_found',
      }];

      if (relatedTests.length > 0) {
        evidence.push({
          source: 'name convention',
          detail: `Possible related test files: ${relatedTests.map(t => t.file_path).join(', ')}`,
          strength: 'heuristic',
        });
      }

      findings.push({
        category: 'untested_changes',
        file,
        detail: 'File has no test coverage connected through TESTS or TESTS_FILE edges.',
        evidence,
        overall_confidence: relatedTests.length > 0 ? 'medium' : 'high',
        suggested_action: relatedTests.length > 0
          ? `Consider linking ${relatedTests[0].file_path} to ${file} or adding a new test.`
          : 'Add test coverage for this file.',
      });
    }
  }

  return findings;
}

// ═══════════════════════════════════════════════════════════════
// Query 3: New symbols without callers
// ═══════════════════════════════════════════════════════════════

export function queryNewSymbolsNoCallers(
  db: ReturnType<typeof getDb>,
  project: string,
  scopedFiles?: string[]
): ImpactFinding[] {
  const findings: ImpactFinding[] = [];
  if (scopedFiles && scopedFiles.length === 0) return findings;

  const fileFilter = scopedFiles
    ? ` AND n.file_path IN (${scopedFiles.map(() => '?').join(', ')})`
    : '';

  const rows = db.db.prepare(
    `SELECT n.id, n.name, n.qualified_name, n.file_path, n.is_exported, n.is_entry_point,
            json_extract(n.properties, '$.signature') AS signature
     FROM nodes n
     WHERE n.project = ? AND n.kind IN ('Function', 'Method')
       AND n.is_test = 0
       AND n.name <> 'main'
       ${fileFilter}
       AND NOT EXISTS (
         SELECT 1 FROM edges e WHERE e.target_id = n.id AND e.type = 'CALLS'
       )
     ORDER BY n.file_path, n.name
     LIMIT 30`
  ).all(project, ...(scopedFiles || [])) as Array<{
    id: number; name: string; qualified_name: string; file_path: string;
    is_exported: number; is_entry_point: number; signature: string | null;
  }>;

  for (const r of rows) {
    const usageCnt = db.db.prepare(
      'SELECT COUNT(*) as cnt FROM edges WHERE target_id = ? AND type = \'USAGE\''
    ).get(r.id) as { cnt: number };

    // Skip entry points and exported symbols — they're meant to be called externally
    if (r.is_entry_point || r.is_exported) continue;

    const evidence: EvidenceItem[] = [];
    if (usageCnt.cnt > 0) {
      evidence.push({ source: 'USAGE edges', detail: `${usageCnt.cnt} USAGE edge(s) found`, strength: 'heuristic' });
    }
    evidence.push({ source: 'CALLS edges', detail: 'Zero CALLS edges — no direct callers', strength: 'confirmed' });
    const hasCallableSignature = Boolean(r.signature);
    if (!hasCallableSignature) {
      evidence.push({ source: 'extraction metadata', detail: 'No callable signature; extraction may represent a local value', strength: 'heuristic' });
    }

    findings.push({
      category: 'new_symbols_no_callers',
      symbol: r.name,
      qualified_name: r.qualified_name,
      file: r.file_path,
      detail: `Zero CALLS edges${usageCnt.cnt > 0 ? `, ${usageCnt.cnt} USAGE edge(s)` : ' — potentially dead code'}.`,
      evidence,
      overall_confidence: usageCnt.cnt > 0 ? 'medium' : hasCallableSignature ? 'high' : 'low',
      suggested_action: usageCnt.cnt > 0
        ? 'Symbol is referenced indirectly. Verify it is still needed.'
        : hasCallableSignature
          ? 'Consider removing — no callers detected.'
          : 'Verify extraction before considering removal.',
    });
  }

  return findings;
}

// ═══════════════════════════════════════════════════════════════
// Query 4: Deleted symbols with live references
// ═══════════════════════════════════════════════════════════════

export function queryDeletedSymbolsLiveRefs(
  db: ReturnType<typeof getDb>,
  project: string,
  rootPath: string,
  existsFn?: (absPath: string) => boolean
): ImpactFinding[] {
  const fileExists = existsFn || ((p: string) => fs.existsSync(p));
  const findings: ImpactFinding[] = [];

  // Find CALLS edges where target symbol's file is absent or symbol is gone
  const rows = db.db.prepare(
    `SELECT e.target_id, tgt.name, tgt.qualified_name, tgt.file_path,
            COUNT(*) as caller_count
     FROM edges e
     JOIN nodes tgt ON tgt.id = e.target_id
     WHERE e.project = ? AND e.type = 'CALLS'
       AND tgt.kind IN ('Function', 'Method')
     GROUP BY e.target_id
     ORDER BY caller_count DESC
     LIMIT 30`
  ).all(project) as Array<{
    target_id: number; name: string; qualified_name: string; file_path: string; caller_count: number;
  }>;

  for (const r of rows) {
    // Check if file exists on disk
    const absPath = path.resolve(rootPath, r.file_path);
    const fileOnDisk = fileExists(absPath);

    if (!fileOnDisk) {
      // File deleted from disk — stale indexed edges
      const callers = db.db.prepare(
        `SELECT src.qualified_name as caller_qn, src.file_path as caller_file
         FROM edges e JOIN nodes src ON src.id = e.source_id
         WHERE e.target_id = ? AND e.type = 'CALLS'
         LIMIT 10`
      ).all(r.target_id) as Array<{ caller_qn: string; caller_file: string }>;

      findings.push({
        category: 'deleted_symbols_live_refs',
        symbol: r.name,
        qualified_name: r.qualified_name,
        file: r.file_path,
        detail: `File deleted from disk, but ${r.caller_count} caller(s) still reference ${r.name}.`,
        evidence: [
          { source: 'filesystem check', detail: `${r.file_path} does not exist on disk`, strength: 'confirmed' },
          ...callers.map(c => ({
            source: 'CALLS edge',
            detail: `${c.caller_qn} → ${r.qualified_name}`,
            strength: 'confirmed' as EvidenceStrength,
          })),
        ],
        overall_confidence: 'high',
        suggested_action: 'Restore the file or update all callers to remove references.',
      });
    } else {
      // File exists but symbol might be missing from latest index
      const stillIndexed = db.db.prepare(
        'SELECT id FROM nodes WHERE project = ? AND qualified_name = ? LIMIT 1'
      ).get(project, r.qualified_name);

      if (!stillIndexed) {
        const callers = db.db.prepare(
          `SELECT src.qualified_name as caller_qn, src.file_path as caller_file
           FROM edges e JOIN nodes src ON src.id = e.source_id
           WHERE e.target_id = ? AND e.type = 'CALLS'
           LIMIT 10`
        ).all(r.target_id) as Array<{ caller_qn: string; caller_file: string }>;

        findings.push({
          category: 'deleted_symbols_live_refs',
          symbol: r.name,
          qualified_name: r.qualified_name,
          file: r.file_path,
          detail: `Symbol no longer in index, but ${r.caller_count} caller(s) have CALLS edges.`,
          evidence: callers.map(c => ({
            source: 'CALLS edge (stale)',
            detail: `${c.caller_qn} → ${r.qualified_name} (may be stale index)`,
            strength: 'heuristic' as EvidenceStrength,
          })),
          overall_confidence: 'medium',
          suggested_action: 'Re-index the project to refresh edges, then re-assess.',
        });
      }
    }
  }

  return findings;
}

// ═══════════════════════════════════════════════════════════════
// Query 5: Modified files not in the index
// ═══════════════════════════════════════════════════════════════

export function queryUnindexedModified(
  db: ReturnType<typeof getDb>,
  project: string,
  diffFiles: string[],
  rootPath: string,
  existsFn?: (absPath: string) => boolean
): ImpactFinding[] {
  const fileExists = existsFn || ((p: string) => fs.existsSync(p));
  const findings: ImpactFinding[] = [];

  for (const file of diffFiles) {
    if (isFileIndexed(db, project, file)) continue;

    // Distinguish generated/build artifacts — check BEFORE filesystem
    // because generated files may not exist on disk but are still expected.
    const isGenerated = file.startsWith('dist/') || file.startsWith('build/') || file.startsWith('generated/') ||
      file.includes('/dist/') || file.includes('/build/') || file.includes('/generated/') ||
      file.includes('/node_modules/') || file.includes('/.next/');

    if (isGenerated) {
      findings.push({
        category: 'unindexed_modified_files',
        file,
        detail: 'Generated/build artifact — excluded from indexing.',
        evidence: [{ source: 'path convention', detail: 'Path matches generated/build pattern', strength: 'heuristic' }],
        overall_confidence: 'medium',
        suggested_action: 'No action needed — this file type is excluded from indexing.',
      });
      continue;
    }

    if (!isCodeFilePath(file)) {
      findings.push({
        category: 'unindexed_modified_files',
        file,
        detail: `File extension not in supported code extensions.`,
        evidence: [{ source: 'extension check', detail: `Extension not in CODE_EXTENSIONS`, strength: 'confirmed' }],
        overall_confidence: 'high',
        suggested_action: 'No action needed — this file type is excluded from indexing.',
      });
      continue;
    }

    const absPath = path.resolve(rootPath, file);
    const onDisk = fileExists(absPath);

    if (!onDisk) {
      findings.push({
        category: 'unindexed_modified_files',
        file,
        detail: 'File no longer exists on disk (deleted or renamed).',
        evidence: [{ source: 'filesystem check', detail: `${absPath} not found`, strength: 'confirmed' }],
        overall_confidence: 'high',
        suggested_action: 'No action needed — file was deleted.',
      });
      continue;
    }

    findings.push({
      category: 'unindexed_modified_files',
      file,
      detail: 'File exists on disk and is a supported type, but was not indexed.',
      evidence: [{ source: 'graph lookup', detail: `No nodes found for ${file} in graph`, strength: 'searched_not_found' }],
      overall_confidence: 'high',
      suggested_action: 'Re-index the project to include this file for analysis.',
    });
  }

  return findings;
}

// ═══════════════════════════════════════════════════════════════
// Query 6: Downstream dependents (Blast Radius)
// ═══════════════════════════════════════════════════════════════

export function queryDownstreamDependents(
  db: ReturnType<typeof getDb>,
  project: string,
  diffFiles: string[]
): string[] {
  if (diffFiles.length === 0) return [];

  // All modified files that are indexed
  const indexedFiles = diffFiles.filter(f => isFileIndexed(db, project, f));
  if (indexedFiles.length === 0) return [];

  // Build placeholders for IN clause
  const placeholders = indexedFiles.map(() => '?').join(',');
  const rows = db.db.prepare(
    `SELECT DISTINCT tgt.file_path AS target_file
     FROM edges e
     JOIN nodes tgt ON tgt.id = e.target_id
     WHERE tgt.project = ?
       AND e.type IN ('CALLS', 'IMPORTS', 'USAGE')
       AND e.source_id IN (
         SELECT id FROM nodes
         WHERE project = ? AND file_path IN (${placeholders})
       )
       AND tgt.file_path NOT IN (${placeholders})
     ORDER BY target_file`
  ).all(project, project, ...indexedFiles, ...indexedFiles) as Array<{ target_file: string }>;

  return rows.map(r => r.target_file);
}

// ═══════════════════════════════════════════════════════════════
// Query 7: Async dependents — Event-Bridge Blast Radius
// ═══════════════════════════════════════════════════════════════

export function queryAsyncDependents(
  db: ReturnType<typeof getDb>,
  project: string,
  diffFiles: string[]
): string[] {
  if (diffFiles.length === 0) return [];

  const indexedFiles = diffFiles.filter(f => isFileIndexed(db, project, f));
  if (indexedFiles.length === 0) return [];

  const placeholders = indexedFiles.map(() => '?').join(',');

  // Files whose functions emit to channels that functions in other files listen on.
  const rows = db.db.prepare(
    `SELECT DISTINCT listener.file_path AS dependent_file
     FROM edges emit_e
     JOIN nodes ch ON ch.id = emit_e.target_id AND ch.kind = 'Channel'
     JOIN edges listen_e ON listen_e.target_id = ch.id AND listen_e.type = 'LISTENS_ON'
     JOIN nodes listener ON listener.id = listen_e.source_id
     WHERE emit_e.project = ?
       AND emit_e.type = 'EMITS'
       AND emit_e.source_id IN (
         SELECT id FROM nodes
         WHERE project = ? AND file_path IN (${placeholders})
       )
       AND listener.file_path NOT IN (${placeholders})
     ORDER BY dependent_file`
  ).all(project, project, ...indexedFiles, ...indexedFiles) as Array<{ dependent_file: string }>;

  // Also: files whose functions listen on channels that other modified files emit to
  const reverseRows = db.db.prepare(
    `SELECT DISTINCT emitter.file_path AS dependent_file
     FROM edges listen_e
     JOIN nodes ch ON ch.id = listen_e.target_id AND ch.kind = 'Channel'
     JOIN edges emit_e ON emit_e.target_id = ch.id AND emit_e.type = 'EMITS'
     JOIN nodes emitter ON emitter.id = emit_e.source_id
     WHERE listen_e.project = ?
       AND listen_e.type = 'LISTENS_ON'
       AND listen_e.source_id IN (
         SELECT id FROM nodes
         WHERE project = ? AND file_path IN (${placeholders})
       )
       AND emitter.file_path NOT IN (${placeholders})
     ORDER BY dependent_file`
  ).all(project, project, ...indexedFiles, ...indexedFiles) as Array<{ dependent_file: string }>;

  const allFiles = new Set(rows.map(r => r.dependent_file));
  for (const r of reverseRows) allFiles.add(r.dependent_file);
  return Array.from(allFiles).sort();
}
// ═══════════════════════════════════════════════════════════════

const CONFIDENCE_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

export function stableSort(findings: ImpactFinding[]): ImpactFinding[] {
  return [...findings].sort((a, b) => {
    const c = CONFIDENCE_ORDER[a.overall_confidence] - CONFIDENCE_ORDER[b.overall_confidence];
    if (c !== 0) return c;
    const dc = a.category.localeCompare(b.category);
    if (dc !== 0) return dc;
    const df = a.file.localeCompare(b.file);
    if (df !== 0) return df;
    return (a.symbol || '').localeCompare(b.symbol || '');
  });
}

/**
 * Fair per-category truncation: each non-empty category gets at least
 * 5 entries (or its full size if smaller), then remaining budget is
 * distributed round-robin. Deterministic sort guarantees stable pages.
 */
export function fairTruncate(
  allFindings: ImpactFinding[],
  limit: number,
  offset: number
): { selected: ImpactFinding[] } {
  const sorted = stableSort(allFindings);

  // Group by category (preserves sort order within each group)
  const byCategory = new Map<string, ImpactFinding[]>();
  for (const f of sorted) {
    const arr = byCategory.get(f.category);
    if (arr) arr.push(f);
    else byCategory.set(f.category, [f]);
  }

  const categories = [...byCategory.keys()];
  const numCategories = categories.length;

  if (numCategories === 0) return { selected: [] };

  // Each category gets max(5, floor(limit / numCategories)), capped at its size
  const basePer = Math.max(5, Math.floor(limit / numCategories));
  const allocated = new Map<string, ImpactFinding[]>();
  const cursors = new Map<string, number>();
  let used = 0;

  for (const cat of categories) {
    const items = byCategory.get(cat)!;
    const take = Math.min(basePer, items.length);
    allocated.set(cat, items.slice(0, take));
    cursors.set(cat, take);
    used += take;
  }

  // Round-robin remainder
  let round = 0;
  while (used < limit) {
    const catIdx = round % numCategories;
    const cat = categories[catIdx];
    const items = byCategory.get(cat)!;
    const cursor = cursors.get(cat)!;
    if (cursor < items.length) {
      allocated.get(cat)!.push(items[cursor]);
      cursors.set(cat, cursor + 1);
      used++;
    }
    round++;
    if (round > numCategories * limit) break; // all exhausted
  }

  // Flatten: maintain category order, then inner order
  const flat: ImpactFinding[] = [];
  for (const cat of categories) {
    for (const f of allocated.get(cat)!) {
      flat.push(f);
    }
  }

  // Re-sort the selected subset (may have mixed category order from round-robin)
  const reSorted = stableSort(flat);

  // Apply offset
  return { selected: reSorted.slice(offset, offset + limit) };
}

// ═══════════════════════════════════════════════════════════════
// Orchestrator
// ═══════════════════════════════════════════════════════════════

export async function handleAssessImpact(
  args: Record<string, unknown>
): Promise<AssessImpactResult> {
  const project = String(args.project || '');
  const requestedFiles = resolveRequestedFiles(args);
  const baseBranch = (args.base_branch as string) || 'main';
  const maxFindings = typeof args.max_findings === 'number' ? args.max_findings : DEFAULT_MAX_FINDINGS;
  const offset = typeof args.offset === 'number' ? Math.max(0, args.offset) : 0;
  const categoryFilter = (args.category as string) || undefined;

  const db = getDb(project);
  const projectMeta = db.getProject(project);
  if (!projectMeta) {
    return {
      contract_version: ASSESS_IMPACT_CONTRACT_VERSION,
      project,
      scope: { files: requestedFiles || undefined, base_branch: baseBranch },
      summary: 'Project not indexed.',
      total_findings: 0,
      returned_findings: 0,
      truncated: 0,
      limit: maxFindings,
      findings_by_category: {},
      findings: [],
      direct_dependent_files: [],
      async_dependent_files: [],
      sibling_invariants_broken: [],
      architecture_rules_broken: [],
      uncertainties: ['Project not found in index.'],
      recommended_inspection: ['Run index_repository first.'],
      confidence_note: 'Cannot assess impact without indexed project.',
    };
  }
  const rootPath = projectMeta.rootPath;

  let diffFiles = getModifiedFiles(rootPath, baseBranch);
  const uncertainties: string[] = [];
  let ignoredFiles: { count: number; examples: string[]; reason: string } | undefined;

  // Non-code files → compact ignored_files metadata, not findings
  const nonCodeFiles = diffFiles.filter(f => !isCodeFilePath(f));
  if (nonCodeFiles.length > 0) {
    ignoredFiles = {
      count: nonCodeFiles.length,
      examples: nonCodeFiles.slice(0, 5),
      reason: 'Non-code files (.md, .json, .yml, etc.) excluded from impact assessment.',
    };
  }
  diffFiles = diffFiles.filter(f => isCodeFilePath(f));

  if (diffFiles.length === 0 && nonCodeFiles.length === 0) {
    uncertainties.push('No files detected in git diff — assessment may be incomplete.');
  }

  let scopedFiles = diffFiles;
  if (requestedFiles && requestedFiles.length > 0) {
    const allowed = new Set(requestedFiles);
    scopedFiles = diffFiles.filter(f => allowed.has(f));
    if (scopedFiles.length === 0 && diffFiles.length > 0) {
      uncertainties.push(`None of the requested files (${requestedFiles.join(', ')}) appear in git diff.`);
    }
  }

  // Run all 5 queries
  const allFindings: ImpactFinding[] = [];
  allFindings.push(...queryTestsCoveringChanges(db, project, scopedFiles));
  allFindings.push(...queryUntestedFiles(db, project, scopedFiles));
  allFindings.push(...queryNewSymbolsNoCallers(db, project, scopedFiles));
  allFindings.push(...queryDeletedSymbolsLiveRefs(db, project, rootPath));
  allFindings.push(...queryUnindexedModified(db, project, scopedFiles, rootPath));

  // Query 6: Blast Radius — what depends on modified symbols?
  const dependents = queryDownstreamDependents(db, project, scopedFiles);

  // Query 7: Async Blast Radius — what depends via event channels?
  const asyncDeps = queryAsyncDependents(db, project, scopedFiles);

  // Query 8: Sibling-call invariants broken in modified code
  const allInvariants = discoverInvariants(db, project);
  const invariantsBroken = checkInvariantsBroken(db, project, allInvariants, scopedFiles);

  // Query 9: Architecture rules broken in modified code
  let architectureViolations: RuleViolation[] = [];
  const rules = loadRules(rootPath);
  if (rules) {
    architectureViolations = detectArchitectureViolations(db, project, rules, scopedFiles);
  }

  // Apply optional category filter (before count, before truncation)
  const filteredFindings = categoryFilter
    ? allFindings.filter(f => f.category === categoryFilter)
    : allFindings;

  // findings_by_category computed from ALL pre-truncation filtered findings
  const fullCategoryTotals: Record<string, number> = {};
  for (const f of filteredFindings) {
    fullCategoryTotals[f.category] = (fullCategoryTotals[f.category] || 0) + 1;
  }

  const totalFindings = filteredFindings.length;

  // Fair truncation (or simple category-filtered pagination)
  let selected: ImpactFinding[];
  if (categoryFilter) {
    const sorted = stableSort(filteredFindings);
    selected = sorted.slice(offset, offset + maxFindings);
  } else {
    const result = fairTruncate(filteredFindings, maxFindings, offset);
    selected = result.selected;
  }

  const truncatedCount = totalFindings - (offset + selected.length);
  if (truncatedCount > 0) {
    uncertainties.push(`${truncatedCount} additional finding(s) beyond page. Use offset=${offset + maxFindings} for next page.`);
  }

  // Recommended inspection from high-confidence pre-truncation findings
  const recommendedFiles = new Set<string>();
  for (const f of filteredFindings) {
    if (f.overall_confidence === 'high') recommendedFiles.add(f.file);
  }
  const recommended = Array.from(recommendedFiles).slice(0, 10);

  const highCount = selected.filter(f => f.overall_confidence === 'high').length;
  const medCount = selected.filter(f => f.overall_confidence === 'medium').length;

  const summary = selected.length === 0
    ? 'No impact findings — all modified symbols have test coverage and no orphaned references.'
    : `${totalFindings} total findings (showing ${selected.length})` +
      (offset > 0 ? ` from offset ${offset}` : '') +
      `: ${highCount} high-confidence, ${medCount} medium-confidence. ` +
      Object.entries(fullCategoryTotals).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ') + '.';

  return {
    contract_version: ASSESS_IMPACT_CONTRACT_VERSION,
    project,
    scope: { files: requestedFiles || undefined, base_branch: baseBranch },
    summary,
    total_findings: totalFindings,
    returned_findings: selected.length,
    truncated: Math.max(0, totalFindings - (offset + selected.length)),
    limit: maxFindings,
    ...(offset > 0 ? { offset } : {}),
    ...(categoryFilter ? { category_filter: categoryFilter } : {}),
    findings_by_category: fullCategoryTotals,
    findings: selected,
    direct_dependent_files: dependents,
    async_dependent_files: asyncDeps,
    sibling_invariants_broken: invariantsBroken,
    architecture_rules_broken: architectureViolations,
    ...(ignoredFiles ? { ignored_files: ignoredFiles } : {}),
    uncertainties: uncertainties.length > 0 ? uncertainties : ['Assessment completed with no blockers.'],
    recommended_inspection: recommended,
    confidence_note: 'Evidence strength: confirmed = direct edge (CALLS/IMPORTS/TESTS_FILE), heuristic = convention/name-based, unknown = cannot determine, searched_not_found = looked but found nothing.',
  };
}
