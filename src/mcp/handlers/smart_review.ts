/*
 * smart_review — Automated code review using graph intelligence.
 *
 * Given a file path or function qualified name, produces a review that covers:
 *  - Complexity and size warnings
 *  - Fan-in / fan-out risk assessment
 *  - Hotspot classification
 *  - Related findings from persistent memory
 *  - Suggested actions (refactor, split, add tests, document)
 */

import * as path from 'node:path';
import { getDb } from '../server.js';
import type { LynxDatabase } from '../../store/database.js';
import { getFindingsByFile, getFindingsByQn } from '../../store/memory.js';
import { estimateTokensSaved, recordUsageEvent } from '../../usage/metrics.js';
import { projectNotIndexed } from '../diagnostics.js';
import type { LynxFinding } from '../../types.js';

function dedupeFindings(findings: LynxFinding[]): LynxFinding[] {
  const seen = new Set<string>();
  return findings.filter(f => {
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

interface ReviewIssue {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  title: string;
  description: string;
  location: string;
  suggestion: string;
}

export async function handleSmartReview(
  args: Record<string, unknown>
): Promise<unknown> {
  const started = Date.now();
  const project = String(args.project || '');
  const filePath = args.file ? String(args.file) : undefined;
  const qualifiedName = args.qualified_name ? String(args.qualified_name) : undefined;
  const limit = args.limit !== undefined ? Number(args.limit) : 20;

  if (!project) return { error: 'project is required' };
  if (!filePath && !qualifiedName) return { error: 'file or qualified_name is required' };

  const db = getDb(project);
  const projectMeta = db.getProject(project);
  if (!projectMeta) return { ...projectNotIndexed(project) };

  const nodes = qualifiedName
    ? db.db.prepare('SELECT * FROM nodes WHERE project = ? AND qualified_name = ?')
        .all(project, qualifiedName)
    : db.db.prepare(
        `SELECT * FROM nodes WHERE project = ? AND file_path = ?
         AND kind IN ('Function', 'Method', 'Class', 'Interface') ORDER BY start_line`
      ).all(project, filePath);

  if (nodes.length === 0) {
    return {
      project,
      target: { file: filePath, qualified_name: qualifiedName },
      error: 'No functions or classes found at the specified target.',
    };
  }

  const issues = reviewNodes(db, project, nodes);

  // Memory findings for the target
  const memoryFindings = qualifiedName
    ? getFindingsByQn(db, project, qualifiedName)
    : filePath ? getFindingsByFile(db, project, filePath) : [];

  return buildReviewResponse(issues, limit, nodes, filePath, qualifiedName, memoryFindings, project, started);
}

// ── Per-node review ────────────────────────────────────

function reviewNodes(
  db: LynxDatabase,
  project: string,
  nodes: any[],
): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const seenWarnings = new Set<string>();

  for (const node of nodes) {
    const props = JSON.parse(node.properties || '{}');
    const cyclomatic = props.cyclomaticComplexity || 0;
    const loopDepth = props.loopDepth || 0;
    const lineCount = node.end_line - node.start_line + 1;

    const fanIn = db.db
      .prepare('SELECT COUNT(*) as cnt FROM edges WHERE project = ? AND target_id = ? AND type = \'CALLS\'')
      .get(project, node.id) as { cnt: number };

    // Length check
    if (lineCount > 200) {
      issues.push({
        severity: 'high', category: 'size',
        title: `${node.kind} too long (${lineCount} lines)`,
        description: `${node.kind} \`${node.name}\` spans ${lineCount} lines. Long functions are hard to test and understand.`,
        location: `${node.file_path}:${node.start_line}`,
        suggestion: 'Split into smaller functions of 50-80 lines each. Extract logical blocks into helper functions with descriptive names.',
      });
    } else if (lineCount > 80) {
      issues.push({
        severity: 'medium', category: 'size',
        title: `${node.kind} lengthy (${lineCount} lines)`,
        description: `${node.kind} \`${node.name}\` with ${lineCount} lines — check for mixed responsibilities.`,
        location: `${node.file_path}:${node.start_line}`,
        suggestion: 'Review whether this function does more than one thing. If it has sections like "// Step 1, Step 2", extract each step.',
      });
    }

    // Complexity check
    if (cyclomatic > 100) {
      issues.push({
        severity: 'critical', category: 'complexity',
        title: `Extreme cyclomatic complexity (${cyclomatic})`,
        description: `${node.kind} \`${node.name}\` has cyclomatic complexity of ${cyclomatic} — extremely hard to test and maintain.`,
        location: `${node.file_path}:${node.start_line}`,
        suggestion: 'Urgent refactor: use polymorphism, strategy pattern, or a decision table to eliminate nested conditionals.',
      });
    } else if (cyclomatic > 50) {
      issues.push({
        severity: 'high', category: 'complexity',
        title: `High cyclomatic complexity (${cyclomatic})`,
        description: `${node.kind} \`${node.name}\` with ${cyclomatic} execution paths — prone to bugs in untested branches.`,
        location: `${node.file_path}:${node.start_line}`,
        suggestion: 'Reduce conditional branches. Consider extracting validations into separate functions or using early returns to flatten logic.',
      });
    } else if (cyclomatic > 20) {
      issues.push({
        severity: 'medium', category: 'complexity',
        title: `Moderate cyclomatic complexity (${cyclomatic})`,
        description: `${node.kind} \`${node.name}\` with complexity ${cyclomatic} — acceptable but keep an eye on it.`,
        location: `${node.file_path}:${node.start_line}`,
        suggestion: 'Make sure tests cover the main paths. If it grows further, refactor.',
      });
    }

    // Loop depth check
    if (loopDepth >= 3) {
      issues.push({
        severity: 'high', category: 'performance',
        title: `Deep nested loops (level ${loopDepth})`,
        description: `${node.kind} \`${node.name}\` contains loops nested ${loopDepth} levels deep. This is a structural risk signal, but loop depth alone does not establish O(n^${loopDepth}) runtime complexity.`,
        location: `${node.file_path}:${node.start_line}`,
        suggestion: 'Inspect collection sizes and loop dependencies before claiming Big-O complexity. Extract inner operations where useful, and consider indexed lookups only when profiling or data-flow evidence supports it.',
      });
    }

    // Fan-in risk
    if (fanIn.cnt >= 20) {
      issues.push({
        severity: 'high', category: 'risk',
        title: `High coupling — ${fanIn.cnt} callers`,
        description: `${node.kind} \`${node.name}\` is called by ${fanIn.cnt} functions. Changes here have high impact.`,
        location: `${node.file_path}:${node.start_line}`,
        suggestion: 'Review each caller before modifying this function. Ensure regression tests. Document the function contract.',
      });
    }

    // No tests nearby
    const testFile = node.file_path.includes('.test.') || node.file_path.includes('.spec.') || node.file_path.includes('__tests__');
    if (node.is_test !== 1 && !testFile) {
      const hasTestInDir = db.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM nodes WHERE project = ?
           AND file_path LIKE ? AND kind = 'Function' AND is_test = 1 LIMIT 1`
        )
        .get(project, path.dirname(node.file_path) + '%') as { cnt: number };

      if (hasTestInDir.cnt === 0 && (cyclomatic > 10 || fanIn.cnt > 5)) {
        const key = `notest:${path.dirname(node.file_path)}`;
        if (!seenWarnings.has(key)) {
          seenWarnings.add(key);
          issues.push({
            severity: 'medium', category: 'test-coverage',
            title: 'No tests in this directory',
            description: `No test files found in ${path.dirname(node.file_path)} for a function with complexity ${cyclomatic} and ${fanIn.cnt} callers.`,
            location: path.dirname(node.file_path),
            suggestion: `Add unit tests for \`${node.name}\` covering base cases and edge cases.`,
          });
        }
      }
    }
  }

  return issues;
}

// ── Response building ──────────────────────────────────

function buildReviewResponse(
  issues: ReviewIssue[],
  limit: number,
  nodes: any[],
  filePath?: string,
  qualifiedName?: string,
  memoryFindings: any[] = [],
  project: string = '',
  started: number = Date.now(),
): unknown {
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  issues.sort((a, b) => (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5));

  const limitedIssues = issues.slice(0, limit);
  const critical = limitedIssues.filter(i => i.severity === 'critical').length;
  const high = limitedIssues.filter(i => i.severity === 'high').length;
  const medium = limitedIssues.filter(i => i.severity === 'medium').length;

  const summary = critical > 0
    ? `CRITICAL: ${critical} critical, ${high} high, ${medium} medium issues. Immediate attention required.`
    : high > 0
      ? `Review needed: ${high} high, ${medium} medium issues.`
      : medium > 0
        ? `Acceptable: ${medium} medium issues detected.`
        : limitedIssues.length > 0
          ? `Healthy: only ${limitedIssues.length} low-priority warnings.`
          : issues.length > 0
            ? `Review returned ${Math.min(issues.length, limit)} of ${issues.length} issues — increase limit to see all.`
            : 'Clean: no issues detected in this review.';

  recordUsageEvent({
    type: 'search_graph',
    project,
    query: qualifiedName || filePath || '',
    result_count: nodes.length,
    unique_files: new Set(nodes.map(n => n.file_path)).size,
    files_avoided: nodes.length * 3,
    tokens_saved: nodes.length * 900,
    confidence: nodes.length >= 4 ? 'high' as const : nodes.length >= 2 ? 'medium' as const : 'low' as const,
    latency_ms: Date.now() - started,
    tool_hint: 'smart_review',
  });

  return {
    project,
    target: { file: filePath, qualified_name: qualifiedName },
    summary,
    stats: {
      functions_reviewed: nodes.length,
      total_issues: issues.length,
      critical, high, medium,
      low: limitedIssues.filter(i => i.severity === 'low').length,
      info: limitedIssues.filter(i => i.severity === 'info').length,
    },
    issues: limitedIssues.map(i => ({
      severity: i.severity, category: i.category, title: i.title,
      description: i.description, location: i.location, suggestion: i.suggestion,
    })),
    memory_findings: dedupeFindings(memoryFindings).map(f => ({
      title: f.title, severity: f.severity, category: f.category, discovered: f.createdAt,
    })),
    remaining_issues: Math.max(0, issues.length - limitedIssues.length),
    value_metrics: {
      estimated_files_avoided: nodes.length * 3,
      estimated_tokens_saved: nodes.length * 900,
      confidence: nodes.length >= 4 ? 'high' as const : nodes.length >= 2 ? 'medium' as const : 'low' as const,
      latency_ms: Date.now() - started,
    },
  };
}
