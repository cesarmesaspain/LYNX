/*
 * complexity.ts — Cross-file complexity aggregation and file tree building.
 *
 * Aggregates complexity metrics across files, computes cyclomatic complexity
 * from source code, and builds the hierarchical file tree for the architecture view.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LynxDatabase } from '../store/database.js';
import type { LynxFileTreeEntry } from '../types.js';

// ── Cyclomatic Complexity ──────────────────────────────────────
//
// Standard McCabe formula: M = E - N + 2P approximated as 1 + decision points.
// Decision points counted:
//   if / else if / for / while / do-while / switch case / catch
//   && / || / ?? / ternary (? :) — each short-circuit/branch operator

const BRANCH_KEYWORDS = /\b(if|else\s+if|for|while|do|catch|switch)\b/g;
const CASE_PATTERN = /\bcase\b/g;
const DEFAULT_PATTERN = /\bdefault\s*:/g;

/** Properly count cases: each `case` is a branch, `default` counts as one. */
function countCases(source: string): number {
  let count = 0;
  const caseMatch = source.match(CASE_PATTERN);
  if (caseMatch) count += caseMatch.length;
  // default: counts as a case
  const defaultMatch = source.match(DEFAULT_PATTERN);
  if (defaultMatch) count += defaultMatch.length;
  return count;
}

/** Count logical operators that create implicit branches. */
function countLogicalBranches(source: string): number {
  // Match && and || but NOT inside string literals or comments.
  // Simple approximation: count occurrences outside of strings.
  let count = 0;
  // Strip string literals to avoid false positives
  const stripped = source
    .replace(/'[^']*'/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/`[^`]*`/g, '');
  const andMatch = stripped.match(/&&/g);
  const orMatch = stripped.match(/\|\|/g);
  const nullishMatch = stripped.match(/\?\?/g);
  if (andMatch) count += andMatch.length;
  if (orMatch) count += orMatch.length;
  if (nullishMatch) count += nullishMatch.length;
  return count;
}

/** Compute cyclomatic complexity for source code of a single function. */
function computeCyclomatic(source: string): number {
  let complexity = 1; // base

  // Count keyword branches
  const branches = source.match(BRANCH_KEYWORDS);
  if (branches) complexity += branches.length;

  // Count switch cases (each case is a branch)
  complexity += countCases(source);

  // Count logical operator branches
  complexity += countLogicalBranches(source);

  return complexity;
}

/** Compute cognitive complexity — penalizes nesting depth. */
function computeCognitive(source: string): number {
  let cognitive = 0;
  const lines = source.split('\n');
  let currentDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    // Track nesting via braces
    const opens = (trimmed.match(/\{/g) || []).length;
    const closes = (trimmed.match(/\}/g) || []).length;

    // Branching keywords add to cognitive complexity with nesting penalty
    if (/\b(if|else\s+if|for|while|do|catch|switch)\b/.test(trimmed)) {
      cognitive += 1 + currentDepth;
    }
    // Logical operators also add cognitive load
    if (/&&|\|\||\?\?/.test(trimmed)) {
      cognitive += 0.5 + currentDepth * 0.25;
    }
    // Ternary
    if (/\?\s*[^:]+:/.test(trimmed)) {
      cognitive += 1 + currentDepth;
    }

    currentDepth += opens - closes;
    if (currentDepth < 0) currentDepth = 0;
  }

  return Math.round(cognitive * 10) / 10;
}

/** Count loops in function source. */
function countLoops(source: string): number {
  let count = 0;
  const loopPatterns = [/\bfor\b/g, /\bwhile\b/g, /\bdo\b/g];
  for (const p of loopPatterns) {
    const matches = source.match(p);
    if (matches) count += matches.length;
  }
  return count;
}

/** Compute max nesting depth of loops. */
function computeLoopDepth(source: string): number {
  let maxDepth = 0;
  let currentDepth = 0;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (/\b(for|while|do)\b/.test(trimmed)) {
      currentDepth++;
      maxDepth = Math.max(maxDepth, currentDepth);
    }
    // Decrement when we see closing brace after loop body
    const closes = (line.match(/\}/g) || []).length;
    currentDepth = Math.max(0, currentDepth - closes);
  }
  return maxDepth;
}

/** Count linear-scan-in-loop patterns: .find(), .filter(), .indexOf(), .includes() inside a loop. */
function countLinearScanInLoop(source: string): number {
  let count = 0;
  const lines = source.split('\n');
  let inLoop = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const opens = (trimmed.match(/\b(for|while|do)\b/g) || []).length;
    const closes = (trimmed.match(/\}/g) || []).length;
    inLoop += opens;
    if (inLoop > 0 && /\b\.(find|filter|indexOf|includes|some|every|reduce|map)\s*\(/.test(trimmed)) {
      count++;
    }
    inLoop = Math.max(0, inLoop - closes);
  }
  return count;
}

/** Count allocations/array constructions inside loops. */
function countAllocInLoop(source: string): number {
  let count = 0;
  const lines = source.split('\n');
  let inLoop = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const opens = (trimmed.match(/\b(for|while|do)\b/g) || []).length;
    const closes = (trimmed.match(/\}/g) || []).length;
    inLoop += opens;
    if (inLoop > 0 && (/\bnew\s+\w+/.test(trimmed) || /\.push\(/.test(trimmed) || /\[\s*\]/.test(trimmed))) {
      count++;
    }
    inLoop = Math.max(0, inLoop - closes);
  }
  return count;
}

/** Detect recursion — function calls itself within its body. */
function isRecursive(name: string, source: string): boolean {
  const body = source.replace(/^\s*function\s+\w+\s*\([^)]*\)\s*\{/, '').replace(/\}\s*$/, '');
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`).test(body);
}

/**
 * Compute cyclomatic complexity, cognitive complexity, and loop metrics
 * for all Function/Method nodes in the project, reading source from disk.
 */
export function computeCyclomaticComplexities(
  db: LynxDatabase,
  project: string,
  rootPath: string
): void {
  const funcs = db.db
    .prepare(
      `SELECT id, name, qualified_name, file_path, start_line, end_line, kind
       FROM nodes WHERE project = ? AND kind IN ('Function', 'Method')`
    )
    .all(project) as {
    id: number; name: string; qualified_name: string;
    file_path: string; start_line: number; end_line: number; kind: string;
  }[];

  const updateStmt = db.db.prepare(
    `UPDATE nodes SET properties =
       json_set(json_set(json_set(json_set(json_set(json_set(json_set(json_set(
         properties,
         '$.cyclomaticComplexity', ?),
         '$.cognitiveComplexity', ?),
         '$.loopCount', ?),
         '$.loopDepth', ?),
         '$.linearScanInLoop', ?),
         '$.allocInLoop', ?),
         '$.recursive', ?),
         '$.lineCount', ?)
     WHERE id = ?`
  );

  let computed = 0;
  db.db.transaction(() => {
    for (const func of funcs) {
      const fullPath = path.join(rootPath, func.file_path);
      let source = '';
      try {
        const fileContent = fs.readFileSync(fullPath, 'utf8');
        const lines = fileContent.split('\n');
        const start = Math.max(0, func.start_line - 1);
        const end = func.end_line > func.start_line
          ? func.end_line
          : Math.min(start + 500, lines.length);
        source = lines.slice(start, end).join('\n');
      } catch {
        continue; // file not readable — skip
      }

      const lineCount = func.end_line > func.start_line
        ? func.end_line - func.start_line + 1
        : 1;
      const cyclomatic = computeCyclomatic(source);
      const cognitive = computeCognitive(source);
      const loopCount = countLoops(source);
      const loopDepth = computeLoopDepth(source);
      const linearScanInLoop = countLinearScanInLoop(source);
      const allocInLoop = countAllocInLoop(source);
      const recursive = isRecursive(func.name, source);

      updateStmt.run(
        cyclomatic, cognitive, loopCount, loopDepth,
        linearScanInLoop, allocInLoop, recursive ? 1 : 0,
        lineCount,
        func.id
      );
      computed++;
    }
  })();

  console.error(`[complexity] Computed metrics for ${computed}/${funcs.length} functions`);
}

/**
 * Build a hierarchical file tree from all files in the project.
 */
export function buildFileTree(
  db: LynxDatabase,
  project: string
): LynxFileTreeEntry[] {
  const files = db.db
    .prepare(
      "SELECT file_path FROM nodes WHERE project = ? AND kind = 'File' ORDER BY file_path"
    )
    .all(project) as { file_path: string }[];

  const tree = new Map<
    string,
    { type: 'dir' | 'file'; children: number }
  >();

  for (const { file_path: fp } of files) {
    const parts = fp.split('/');

    // Add all directories along the path
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join('/');
      if (!tree.has(dirPath)) {
        tree.set(dirPath, { type: 'dir', children: 0 });
      }
    }

    // Add the file
    tree.set(fp, { type: 'file', children: 0 });

    // Increment child count for parent directory
    if (parts.length > 1) {
      const parentDir = parts.slice(0, -1).join('/');
      const parent = tree.get(parentDir);
      if (parent) {
        parent.children++;
      }
    }
  }

  // Convert to array, sorted with dirs first
  const entries: LynxFileTreeEntry[] = [];
  const sortedPaths = Array.from(tree.keys()).sort((a, b) => {
    const aIsDir = tree.get(a)!.type === 'dir';
    const bIsDir = tree.get(b)!.type === 'dir';
    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;
    return a.localeCompare(b);
  });

  for (const path of sortedPaths) {
    const entry = tree.get(path)!;
    entries.push({ path, type: entry.type, children: entry.children });
  }

  return entries;
}

/**
 * Compute transitive loop depth for all functions.
 * A function's transitive loop depth is the max of:
 * - its own max loop depth
 * - 1 + the transitive loop depth of any function it calls
 */
export function computeTransitiveLoopDepths(
  db: LynxDatabase,
  project: string
): void {
  // Get all function IDs and their direct loop depths
  const funcs = db.db
    .prepare(
      `SELECT id, qualified_name, CAST(json_extract(properties, '$.loopDepth') AS INTEGER) as loop_depth
       FROM nodes WHERE project = ? AND kind IN ('Function', 'Method')`
    )
    .all(project) as { id: number; qualified_name: string; loop_depth: number }[];

  const funcMap = new Map<number, { qn: string; depth: number; originalDepth: number }>();
  for (const f of funcs) {
    const depth = f.loop_depth || 0;
    funcMap.set(f.id, { qn: f.qualified_name, depth, originalDepth: depth });
  }

  // Build call graph (ID → list of callee IDs)
  const edges = db.db
    .prepare(
      `SELECT source_id, target_id FROM edges WHERE project = ? AND type = 'CALLS'`
    )
    .all(project) as { source_id: number; target_id: number }[];

  const callGraph = new Map<number, number[]>();
  for (const e of edges) {
    if (!funcMap.has(e.source_id) || !funcMap.has(e.target_id)) continue;
    if (!callGraph.has(e.source_id)) callGraph.set(e.source_id, []);
    callGraph.get(e.source_id)!.push(e.target_id);
  }

  // Iterative propagation (fixed-point, bounded)
  for (let iter = 0; iter < 10; iter++) {
    let changed = false;
    for (const [sourceId, info] of funcMap) {
      const callees = callGraph.get(sourceId) || [];
      for (const calleeId of callees) {
        const calleeInfo = funcMap.get(calleeId);
        if (calleeInfo) {
          const propagated = calleeInfo.depth + 1;
          if (propagated > info.depth) {
            info.depth = propagated;
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }

  // Write back
  const updateStmt = db.db.prepare(
    `UPDATE nodes SET properties = json_set(properties, '$.transitiveLoopDepth', ?)
     WHERE id = ?`
  );
  db.db.transaction(() => {
    for (const [id, info] of funcMap) {
      if (info.depth === info.originalDepth) continue;
      updateStmt.run(info.depth, id);
    }
  })();
}
