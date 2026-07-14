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
import type { LynxDatabase } from '../../store/database.js';
import { getFindingsByQn, getComplexityTrend, getRelatedFindings } from '../../store/memory.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { estimateTokensSaved, recordUsageEvent } from '../../usage/metrics.js';
import { projectNotIndexed } from '../diagnostics.js';
import type { LynxFinding } from '../../types.js';
import { readLynxConfig } from '../../config/runtime.js';

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
  const node = lookupSymbol(db, project, qualifiedName, name);
  if (!node) {
    return {
      project,
      query: { qualified_name: qualifiedName, name },
      error: 'Symbol not found in the indexed graph.',
    };
  }

  const savingsMode = Boolean(readLynxConfig().agent_response?.enabled
    && readLynxConfig().agent_response?.budget === 'max_savings');
  const metrics = assessSymbolMetrics(db, project, node, projectMeta.rootPath, savingsMode);
  const result = buildExplainResponse(node, metrics, project, qualifiedName || name || '', started, savingsMode);
  const value = estimateTokensSaved(1, 1);

  recordUsageEvent({
    type: 'search_graph', project,
    query: qualifiedName || name || '',
    result_count: 1, unique_files: 1,
    files_avoided: value.filesAvoided, tokens_saved: value.tokensSaved, confidence: value.confidence,
    latency_ms: Date.now() - started, tool_hint: 'explain_symbol',
  });

  return result;
}

// ── Symbol lookup ──────────────────────────────────────

function lookupSymbol(
  db: LynxDatabase,
  project: string,
  qualifiedName?: string,
  name?: string,
): any | null {
  let node: any;
  if (qualifiedName) {
    node = db.db
      .prepare('SELECT * FROM nodes WHERE project = ? AND qualified_name = ?')
      .get(project, qualifiedName);
  }
  if (!node && name) {
    node = db.db
      .prepare('SELECT * FROM nodes WHERE project = ? AND name = ? LIMIT 1')
      .get(project, name);
  }
  return node || null;
}

// ── Metrics assessment ─────────────────────────────────

interface SymbolMetrics {
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  loopDepth: number;
  transitiveLoopDepth: number;
  fanIn: number;
  fanOut: number;
  callers: Array<{ type: string; name: string; qualified_name: string; kind: string; file: string }>;
  callees: Array<{ type: string; name: string; qualified_name: string; kind: string; file: string }>;
  parents: Array<{ name: string; qualified_name: string }>;
  source: string | null;
  findings: any[];
  trend: any;
  related: any[];
  riskLevel: string;
  riskNarrative: string;
}

function assessSymbolMetrics(
  db: LynxDatabase,
  project: string,
  node: any,
  rootPath: string,
  savingsMode: boolean,
): SymbolMetrics {
  const props = JSON.parse(node.properties || '{}');
  const cyclomaticComplexity = props.cyclomaticComplexity || 0;
  const cognitiveComplexity = props.cognitiveComplexity || 0;
  const loopDepth = props.loopDepth || 0;
  const transitiveLoopDepth = props.transitiveLoopDepth || 0;

  const fanIn = db.db
    .prepare("SELECT COUNT(*) as cnt FROM edges WHERE project = ? AND target_id = ? AND type IN ('CALLS', 'USAGE', 'TESTS')")
    .get(project, node.id) as { cnt: number };
  const fanOut = db.db
    .prepare("SELECT COUNT(*) as cnt FROM edges WHERE project = ? AND source_id = ? AND type IN ('CALLS', 'USAGE', 'IMPORTS')")
    .get(project, node.id) as { cnt: number };

  // Source code
  let source: string | null = null;
  try {
    const content = fs.readFileSync(path.join(rootPath, node.file_path), 'utf-8');
    const lines = content.split('\n');
    source = lines.slice(node.start_line - 1, node.end_line).join('\n').substring(0, savingsMode ? 1600 : 4000);
  } catch { /* source unavailable */ }

  // Callers (inbound)
  const callerRows = db.db
    .prepare(
      `SELECT e.type, n.name, n.qualified_name, n.kind, n.file_path
       FROM edges e JOIN nodes n ON e.source_id = n.id
       WHERE e.project = ? AND e.target_id = ? AND e.type IN ('CALLS', 'USAGE', 'TESTS')
       LIMIT ${savingsMode ? 8 : 20}`
    )
    .all(project, node.id) as Array<{ type: string; name: string; qualified_name: string; kind: string; file_path: string }>;
  const callers = callerRows.map(r => ({ type: r.type, name: r.name, qualified_name: r.qualified_name, kind: r.kind, file: r.file_path }));

  // Callees (outbound)
  const calleeRows = db.db
    .prepare(
      `SELECT e.type, n.name, n.qualified_name, n.kind, n.file_path
       FROM edges e JOIN nodes n ON e.target_id = n.id
       WHERE e.project = ? AND e.source_id = ? AND e.type IN ('CALLS', 'USAGE', 'IMPORTS')
       LIMIT ${savingsMode ? 8 : 20}`
    )
    .all(project, node.id) as Array<{ type: string; name: string; qualified_name: string; kind: string; file_path: string }>;
  const callees = calleeRows.map(r => ({ type: r.type, name: r.name, qualified_name: r.qualified_name, kind: r.kind, file: r.file_path }));

  // Inherits from / implements
  const parentRows = db.db
    .prepare(
      `SELECT n.name, n.qualified_name, e.type
       FROM edges e JOIN nodes n ON e.target_id = n.id
       WHERE e.project = ? AND e.source_id = ? AND e.type = 'INHERITS'`
    )
    .all(project, node.id) as Array<{ name: string; qualified_name: string; type: string }>;
  const parents = parentRows.map(p => ({ name: p.name, qualified_name: p.qualified_name }));

  // Memory findings
  const findings = getFindingsByQn(db, project, node.qualified_name);
  const trend = getComplexityTrend(db, project, node.qualified_name);
  const related = getRelatedFindings(db, project, node.qualified_name);

  // Risk assessment
  const totalInDegree = fanIn.cnt;
  let riskLevel: string;
  let riskNarrative: string;
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
    riskNarrative = 'LOW risk: few dependencies and manageable complexity.';
  }

  return {
    cyclomaticComplexity, cognitiveComplexity, loopDepth, transitiveLoopDepth,
    fanIn: fanIn.cnt, fanOut: fanOut.cnt,
    callers, callees, parents, source, findings, trend, related,
    riskLevel, riskNarrative,
  };
}

// ── Response building ──────────────────────────────────

function buildExplainResponse(
  node: any,
  m: SymbolMetrics,
  project: string,
  query: string,
  started: number,
  savingsMode: boolean,
): unknown {
  const value = estimateTokensSaved(1, 1);
  const narrative = [
    `${node.kind} \`${node.name}\` in ${node.file_path}:${node.start_line}-${node.end_line}.`,
    `${m.fanIn} inbound callers, ${m.fanOut} outbound dependencies.`,
    m.cyclomaticComplexity > 0 ? `Cyclomatic complexity: ${m.cyclomaticComplexity}.` : '',
    m.cognitiveComplexity > 0 ? `Cognitive complexity: ${m.cognitiveComplexity}.` : '',
    m.riskNarrative,
    m.trend.direction !== 'no_data' ? m.trend.narrative : '',
  ].filter(Boolean).join(' ');

  return {
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
      cyclomatic: m.cyclomaticComplexity,
      cognitive: m.cognitiveComplexity,
      loop_depth: m.loopDepth,
      transitive_loop_depth: m.transitiveLoopDepth,
    },
    dependencies: {
      fan_in: m.fanIn,
      fan_out: m.fanOut,
      callers: m.callers,
      callees: m.callees,
      parents: m.parents,
    },
    risk: { level: m.riskLevel, narrative: m.riskNarrative },
    memory: {
      findings: dedupeFindings(m.findings).map(f => ({ title: f.title, severity: f.severity, category: f.category, discovered: f.createdAt })),
      complexity_trend: m.trend.direction !== 'no_data' ? {
        direction: m.trend.direction,
        delta: m.trend.delta,
        samples: m.trend.sampleCount,
        narrative: m.trend.narrative,
      } : null,
      related_issues: m.related.length,
    },
    source: m.source,
    ...(!savingsMode ? { narrative } : {}),
    value_metrics: {
      estimated_files_avoided: value.filesAvoided,
      estimated_tokens_saved: value.tokensSaved,
      confidence: value.confidence,
      latency_ms: Date.now() - started,
    },
  };
}
