/*
 * check_invariants.ts — SACG-028 Sibling Call Invariant Checker.
 *
 * Discovers co-occurrence patterns in the CALLS graph: if callee A appears
 * alongside callee B in ≥80% of callers of A, the pair (A → B) is a
 * sibling-call invariant. Violations flag functions that call A but not B.
 *
 * Used by:
 *   - assess_impact (sibling_invariants_broken)
 *   - Standalone MCP tool: check_invariants
 */

import { getDb } from '../server.js';
import { isFileIndexed } from './assess_impact.js';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export const CHECK_INVARIANTS_CONTRACT_VERSION = 1;

export interface SiblingInvariant {
  from_name: string;
  from_qn: string;
  to_name: string;
  to_qn: string;
  total_callers_of_from: number;
  joint_callers: number;
  confidence: number; // 0.0–1.0
}

export interface InvariantViolation {
  invariant: SiblingInvariant;
  caller_name: string;
  caller_qn: string;
  caller_file: string;
  detail: string;
}

export interface CheckInvariantsResult {
  contract_version: number;
  project: string;
  summary: string;
  invariants_discovered: number;
  invariants_returned?: number;
  invariants_truncated?: number;
  invariants: SiblingInvariant[];
  violations: InvariantViolation[];
  scope?: { files: string[] };
}

// ═══════════════════════════════════════════════════════════════
// Query: Discover sibling-call invariants
// ═══════════════════════════════════════════════════════════════

const MIN_CALLERS = 3;
const MIN_CONFIDENCE = 0.8;
const MAX_INVARIANTS = 100;

export function discoverInvariants(
  db: ReturnType<typeof getDb>,
  project: string,
): SiblingInvariant[] {
  // Step 1: count distinct callers per callee (exclude tests)
  const soloRows = db.db.prepare(
    `SELECT e.target_id AS callee_id, COUNT(DISTINCT e.source_id) AS cnt
     FROM edges e
     JOIN nodes n ON n.id = e.target_id
     WHERE e.project = ? AND e.type = 'CALLS'
       AND n.is_test = 0 AND n.kind IN ('Function', 'Method')
     GROUP BY e.target_id
     HAVING cnt >= ?`
  ).all(project, MIN_CALLERS) as Array<{ callee_id: number; cnt: number }>;

  const soloMap = new Map<number, number>();
  for (const r of soloRows) soloMap.set(r.callee_id, r.cnt);

  if (soloMap.size === 0) return [];

  const soloIds = [...soloMap.keys()];

  // Step 2: compute every co-occurring pair in one relational aggregation.
  // The previous implementation issued one SQL statement per pair of
  // callees, causing thousands of synchronous SQLite round-trips on a medium
  // graph. SQLite can perform the same set operation directly and count each
  // shared caller once even when several call sites exist.
  const pairRows = db.db.prepare(
    `SELECT e1.target_id AS callee_a,
            e2.target_id AS callee_b,
            COUNT(DISTINCT e1.source_id) AS joint
     FROM edges e1
     JOIN edges e2
       ON e2.project = e1.project
      AND e2.source_id = e1.source_id
      AND e2.type = 'CALLS'
      AND e1.target_id < e2.target_id
     JOIN nodes n1 ON n1.id = e1.target_id
     JOIN nodes n2 ON n2.id = e2.target_id
     WHERE e1.project = ? AND e1.type = 'CALLS'
       AND n1.is_test = 0 AND n1.kind IN ('Function', 'Method')
       AND n2.is_test = 0 AND n2.kind IN ('Function', 'Method')
     GROUP BY e1.target_id, e2.target_id
     HAVING joint >= ?`
  ).all(project, MIN_CALLERS) as Array<{
    callee_a: number; callee_b: number; joint: number;
  }>;
  const pairs = pairRows.filter(pair => soloMap.has(pair.callee_a) && soloMap.has(pair.callee_b));

  if (pairs.length === 0) return [];

  // Step 3: resolve ids to names and compute confidence
  const idToNode = new Map<number, { name: string; qualified_name: string }>();
  for (const r of db.db.prepare(
    `SELECT id, name, qualified_name FROM nodes
     WHERE id IN (${soloIds.map(() => '?').join(',')})`
  ).all(...soloIds) as Array<{ id: number; name: string; qualified_name: string }>) {
    idToNode.set(r.id, r);
  }

  const invariants: SiblingInvariant[] = [];

  for (const p of pairs) {
    const fromCallers = soloMap.get(p.callee_a)!;
    const confidence = Math.round((p.joint / fromCallers) * 1000) / 1000;

    if (confidence < MIN_CONFIDENCE) continue;

    // Check the reverse direction too
    const revCallers = soloMap.get(p.callee_b)!;
    const revConf = Math.round((p.joint / revCallers) * 1000) / 1000;

    const na = idToNode.get(p.callee_a)!;
    const nb = idToNode.get(p.callee_b)!;

    if (confidence >= MIN_CONFIDENCE) {
      invariants.push({
        from_name: na.name,
        from_qn: na.qualified_name,
        to_name: nb.name,
        to_qn: nb.qualified_name,
        total_callers_of_from: fromCallers,
        joint_callers: p.joint,
        confidence,
      });
    }
    if (revConf >= MIN_CONFIDENCE) {
      invariants.push({
        from_name: nb.name,
        from_qn: nb.qualified_name,
        to_name: na.name,
        to_qn: na.qualified_name,
        total_callers_of_from: revCallers,
        joint_callers: p.joint,
        confidence: revConf,
      });
    }
  }

  invariants.sort((a, b) => b.confidence - a.confidence);
  return invariants.slice(0, MAX_INVARIANTS);
}

// ═══════════════════════════════════════════════════════════════
// Query: Check violations in specific files
// ═══════════════════════════════════════════════════════════════

export function checkInvariantsBroken(
  db: ReturnType<typeof getDb>,
  project: string,
  invariants: SiblingInvariant[],
  scopedFiles: string[],
): InvariantViolation[] {
  if (invariants.length === 0 || scopedFiles.length === 0) return [];

  const violations: InvariantViolation[] = [];

  const indexedFiles = scopedFiles.filter(f => isFileIndexed(db, project, f));
  if (indexedFiles.length === 0) return [];

  const filePlaceholders = indexedFiles.map(() => '?').join(',');

  for (const inv of invariants) {
    const rows = db.db.prepare(
      `SELECT caller.id, caller.name, caller.qualified_name, caller.file_path
       FROM nodes caller
       JOIN edges e_a ON e_a.source_id = caller.id
         AND e_a.type = 'CALLS'
       JOIN nodes na ON na.id = e_a.target_id
         AND na.qualified_name = ?
       WHERE caller.project = ?
         AND caller.file_path IN (${filePlaceholders})
         AND caller.kind IN ('Function', 'Method')
         AND caller.is_test = 0
         AND NOT EXISTS (
           SELECT 1 FROM edges e_b
           JOIN nodes nb ON nb.id = e_b.target_id
             AND nb.qualified_name = ?
           WHERE e_b.source_id = caller.id
             AND e_b.type = 'CALLS'
         )
       LIMIT 10`
    ).all(
      inv.from_qn, project, ...indexedFiles, inv.to_qn,
    ) as Array<{
      id: number; name: string; qualified_name: string; file_path: string;
    }>;

    for (const r of rows) {
      violations.push({
        invariant: inv,
        caller_name: r.name,
        caller_qn: r.qualified_name,
        caller_file: r.file_path,
        detail: `${r.name}() calls ${inv.from_name}() but not ${inv.to_name}() ` +
          `(${inv.joint_callers}/${inv.total_callers_of_from} callers of ${inv.from_name}() also call ${inv.to_name}(), confidence ${inv.confidence})`,
      });
    }
  }

  return violations;
}

// ═══════════════════════════════════════════════════════════════
// MCP handler
// ═══════════════════════════════════════════════════════════════

export async function handleCheckInvariants(
  args: Record<string, unknown>,
): Promise<CheckInvariantsResult> {
  const project = String(args.project || '');
  const requestedFiles = args.files as string[] | undefined;
  const minConfidence = typeof args.min_confidence === 'number'
    ? Math.max(0, Math.min(1, args.min_confidence))
    : MIN_CONFIDENCE;
  const requestedLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 30;
  const limit = Math.max(1, Math.min(100, Math.floor(requestedLimit)));

  const db = getDb(project);
  const projectMeta = db.getProject(project);

  if (!projectMeta) {
    return {
      contract_version: CHECK_INVARIANTS_CONTRACT_VERSION,
      project,
      summary: 'Project not indexed.',
      invariants_discovered: 0,
      invariants: [],
      violations: [],
    };
  }

  const invariants = discoverInvariants(db, project).filter(
    inv => inv.confidence >= minConfidence,
  );

  let violations: InvariantViolation[] = [];
  let scope: { files: string[] } | undefined;

  if (requestedFiles && requestedFiles.length > 0) {
    scope = { files: requestedFiles };
    violations = checkInvariantsBroken(db, project, invariants, requestedFiles);
  }

  const summary = invariants.length === 0
    ? 'No sibling-call invariants discovered with sufficient confidence. The codebase may not have enough co-occurrence patterns.'
    : `${invariants.length} invariants discovered` +
      (violations.length > 0
        ? `, ${violations.length} violation(s) in scope.`
        : '.') +
      (scope ? ` Scoped to ${scope.files.length} file(s).` : ' No file scope — re-run with files to detect violations.');
  const returnedInvariants = invariants.slice(0, limit);

  return {
    contract_version: CHECK_INVARIANTS_CONTRACT_VERSION,
    project,
    summary,
    invariants_discovered: invariants.length,
    invariants_returned: returnedInvariants.length,
    invariants_truncated: Math.max(0, invariants.length - returnedInvariants.length),
    invariants: returnedInvariants,
    violations,
    ...(scope ? { scope } : {}),
  };
}
