/*
 * explain_symbol — Detailed explanation of a code symbol.
 *
 * Given a qualified function/class/method name, returns:
 *  - What it does (source snippet, signature)
 *  - Callers (who depends on it)
 *  - Callees (what it depends on)
 *  - Complexity metrics (cyclomatic, cognitive, loop depth)
 *  - Risk assessment (based on fan-in + complexity)
 *  - Related findings and trends from persistent memory
 *  - Narrative explanation in English
 */

import { getDb } from '../server.js';
import { getFindingsByQn, getComplexityTrend, getRelatedFindings } from '../../store/memory.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { estimateTokensSaved, recordUsageEvent } from '../../usage/metrics.js';
import { projectNotIndexed } from '../diagnostics.js';

export async function handleExplainSymbol(
  args: Record<string, unknown>
): Promise<unknown> {
  const started = Date.now();
  const project = String(args.project || '');
  const qualifiedName = args.qualified_name ? String(args.qualified_name) : undefined;
  const name = args.name ? String(args.name) : undefined;

  if (!project) return { error: 'project is required' };
  if (!qualifiedName && !name) return { error: 'qualified_name or name is required' };

  const db = getDb(project);
  const projectMeta = db.getProject(project);
  if (!projectMeta) return { ...projectNotIndexed(project) };

  // Find the symbol
  let node: any;
  if (qualifiedName) {
    node = db.db
      .prepare('SELECT * FROM nodes WHERE project = ? AND qualified_name = ?')
      .get(project, qualifiedName);
  }
  if (!node && name) {
    // Fuzzy match by name
    node = db.db
      .prepare('SELECT * FROM nodes WHERE project = ? AND name = ? LIMIT 1')
      .get(project, name);
  }

  if (!node) {
    return {
      project,
      query: { qualified_name: qualifiedName, name },
      error: 'Symbol not found in the indexed graph.',
    };
  }

  // Basic info
  const props = JSON.parse(node.properties || '{}');
  const cyclomaticComplexity = props.cyclomaticComplexity || 0;
  const cognitiveComplexity = props.cognitiveComplexity || 0;
  const loopDepth = props.loopDepth || 0;
  const transitiveLoopDepth = props.transitiveLoopDepth || 0;
  const fanIn = db.db
    .prepare('SELECT COUNT(*) as cnt FROM edges WHERE project = ? AND target_id = ?')
    .get(project, node.id) as { cnt: number };
  const fanOut = db.db
    .prepare('SELECT COUNT(*) as cnt FROM edges WHERE project = ? AND source_id = ?')
    .get(project, node.id) as { cnt: number };

  // Source code
  let source: string | null = null;
  try {
    const projInfo = db.getProject(project);
    if (projInfo) {
      const content = fs.readFileSync(path.join(projInfo.rootPath, node.file_path), 'utf-8');
      const lines = content.split('\n');
      source = lines.slice(node.start_line - 1, node.end_line).join('\n').substring(0, 4000);
    }
  } catch { /* source unavailable */ }

  // Callers (inbound) — top 20
  const callerRows = db.db
    .prepare(
      `SELECT e.type, n.name, n.qualified_name, n.kind, n.file_path
       FROM edges e JOIN nodes n ON e.source_id = n.id
       WHERE e.project = ? AND e.target_id = ? AND e.type IN ('CALLS', 'USAGE')
       LIMIT 20`
    )
    .all(project, node.id) as Array<{ type: string; name: string; qualified_name: string; kind: string; file_path: string }>;
  const callers = callerRows.map(r => ({ type: r.type, name: r.name, qualified_name: r.qualified_name, kind: r.kind, file: r.file_path }));

  // Callees (outbound) — top 20
  const calleeRows = db.db
    .prepare(
      `SELECT e.type, n.name, n.qualified_name, n.kind, n.file_path
       FROM edges e JOIN nodes n ON e.target_id = n.id
       WHERE e.project = ? AND e.source_id = ? AND e.type IN ('CALLS', 'USAGE', 'IMPORTS')
       LIMIT 20`
    )
    .all(project, node.id) as Array<{ type: string; name: string; qualified_name: string; kind: string; file_path: string }>;
  const callees = calleeRows.map(r => ({ type: r.type, name: r.name, qualified_name: r.qualified_name, kind: r.kind, file: r.file_path }));

  // Inherits from / implements
  const parents = db.db
    .prepare(
      `SELECT n.name, n.qualified_name, e.type
       FROM edges e JOIN nodes n ON e.target_id = n.id
       WHERE e.project = ? AND e.source_id = ? AND e.type = 'INHERITS'`
    )
    .all(project, node.id) as Array<{ name: string; qualified_name: string; type: string }>;

  // Memory: findings + trends
  const findings = getFindingsByQn(db, project, node.qualified_name);
  const trend = getComplexityTrend(db, project, node.qualified_name);
  const related = getRelatedFindings(db, project, node.qualified_name);

  // Risk assessment
  let riskLevel: string;
  let riskNarrative: string;
  const totalInDegree = fanIn.cnt;
  if (totalInDegree >= 20 || cyclomaticComplexity > 100) {
    riskLevel = 'critical';
    riskNarrative = `This symbol is CRITICAL: ${totalInDegree} inbound dependencies and cyclomatic complexity of ${cyclomaticComplexity}. Any change here has a high risk of breaking other parts of the system.`;
  } else if (totalInDegree >= 10 || cyclomaticComplexity > 50) {
    riskLevel = 'high';
    riskNarrative = `HIGH risk: ${totalInDegree} inbound dependencies. Changes here should be reviewed carefully.`;
  } else if (totalInDegree >= 5 || cyclomaticComplexity > 20) {
    riskLevel = 'medium';
    riskNarrative = `MEDIUM risk: ${totalInDegree} dependencies. Moderately safe changes with proper tests.`;
  } else {
    riskLevel = 'low';
    riskNarrative = `LOW risk: few dependencies and manageable complexity.`;
  }

  // Build narrative
  const narrative = [
    `${node.kind} \`${node.name}\` in ${node.file_path}:${node.start_line}-${node.end_line}.`,
    `${fanIn.cnt} inbound callers, ${fanOut.cnt} outbound dependencies.`,
    cyclomaticComplexity > 0 ? `Cyclomatic complexity: ${cyclomaticComplexity}.` : '',
    cognitiveComplexity > 0 ? `Cognitive complexity: ${cognitiveComplexity}.` : '',
    riskNarrative,
    trend.direction !== 'no_data' ? trend.narrative : '',
  ].filter(Boolean).join(' ');

  const result = {
    project,
    symbol: {
      name: node.name,
      qualified_name: node.qualified_name,
      kind: node.kind,
      file: node.file_path,
      lines: `${node.start_line}-${node.end_line}`,
      is_exported: !!node.is_exported,
      is_test: !!node.is_test,
      is_entry_point: !!node.is_entry_point,
    },
    complexity: {
      cyclomatic: cyclomaticComplexity,
      cognitive: cognitiveComplexity,
      loop_depth: loopDepth,
      transitive_loop_depth: transitiveLoopDepth,
    },
    dependencies: {
      fan_in: fanIn.cnt,
      fan_out: fanOut.cnt,
      callers,
      callees,
      parents: parents.map(p => ({ name: p.name, qualified_name: p.qualified_name })),
    },
    risk: {
      level: riskLevel,
      narrative: riskNarrative,
    },
    memory: {
      findings: findings.map(f => ({ title: f.title, severity: f.severity, category: f.category, discovered: f.createdAt })),
      complexity_trend: trend.direction !== 'no_data' ? {
        direction: trend.direction,
        delta: trend.delta,
        samples: trend.sampleCount,
        narrative: trend.narrative,
      } : null,
      related_issues: related.length,
    },
    source,
    narrative,
    value_metrics: {
      estimated_files_avoided: 5,
      estimated_tokens_saved: 2250,
      confidence: 'high' as const,
      latency_ms: Date.now() - started,
    },
  };
  recordUsageEvent({
    type: 'search_graph',
    project,
    query: qualifiedName || name || '',
    result_count: 1,
    unique_files: 1,
    files_avoided: 5,
    tokens_saved: 2250,
    confidence: 'high',
    latency_ms: Date.now() - started,
    tool_hint: 'explain_symbol',
  });

  return result;
}
