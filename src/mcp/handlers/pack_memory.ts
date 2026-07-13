/*
 * pack_memory — LYNX's KEY DIFFERENTIATOR.
 *
 * Surfaces persistent findings from past analyses across sessions.
 * When an AI queries pack_memory for a function/file/component, it gets:
 *  - Past review findings (bugs, issues, refactors)
 *  - Complexity snapshots with trends (getting better or worse?)
 *  - Hotspot history
 *  - Related findings from the same module
 *  - Index run history comparison
 *
 * This is what makes LYNX a "brain with memory" vs a "cold indexer."
 */

import { getDb } from '../server.js';
import {
  getFindingsByFile,
  getFindingsByQn,
  getFindingsByCategory,
  getRecentFindings,
  getComplexityTrend,
  getRelatedFindings,
  compareRuns,
} from '../../store/memory.js';
import type { LynxFinding } from '../../types.js';
import type { ComplexityTrend, RunComparison } from '../../store/memory.js';

function dedupeFindings(findings: LynxFinding[]): LynxFinding[] {
  const seen = new Set<string>();
  return findings.filter(f => {
    // Hotspot snapshots: dedup by target_qn (keep latest — ordered by updated_at DESC)
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

export async function handlePackMemory(
  args: Record<string, unknown>
): Promise<unknown> {
  const project = String(args.project || '');
  const qualifiedName = args.target_qn ? String(args.target_qn) : undefined;
  const targetFile = args.target_file ? String(args.target_file) : undefined;
  const category = args.category ? String(args.category) : undefined;
  const textQuery = args.query ?? args.search ?? args.text;
  const queryText = typeof textQuery === 'string' ? textQuery.trim() : undefined;
  const requestedLimit = args.limit !== undefined ? Number(args.limit) : 20;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(Math.floor(requestedLimit), 100)) : 20;

  const db = getDb(project);

  let findings: LynxFinding[];

  if (qualifiedName) {
    findings = getFindingsByQn(db, project, qualifiedName);
  } else if (targetFile) {
    findings = getFindingsByFile(db, project, targetFile);
  } else if (category) {
    findings = getFindingsByCategory(db, project, category, limit);
  } else {
    findings = getRecentFindings(db, project, limit);
  }

  // Dedup before slicing so limit controls unique findings
  findings = dedupeFindings(findings).slice(0, limit);
  if (queryText) findings = filterFindingsByText(findings, queryText);

  // Complexity trend for specific QN
  let complexityTrend: ComplexityTrend | null = null;
  if (qualifiedName) {
    complexityTrend = getComplexityTrend(db, project, qualifiedName);
  }

  // Related findings for specific QN
  let relatedFindings: LynxFinding[] = [];
  if (qualifiedName) {
    relatedFindings = getRelatedFindings(db, project, qualifiedName);
  }
  const dedupedRelated = dedupeFindings(relatedFindings);

  // Index run comparison
  let runComparison: RunComparison | null = null;
  if (!qualifiedName && !targetFile && !category && !queryText) {
    // Only for broad queries (project overview)
    runComparison = compareRuns(db, project);
  }

  // Build response
  const result: Record<string, unknown> = {
    project,
    query: { qualified_name: qualifiedName, file: targetFile, category, text: queryText },
    total_findings: findings.length,
    findings: findings.map((f) => ({
      title: f.title,
      description: f.description,
      severity: f.severity,
      category: f.category,
      file: f.targetFile,
      discovered_at: f.createdAt,
    })),
  };

  // Attach trend if available
  if (complexityTrend) {
    result.complexity_trend = {
      direction: complexityTrend.direction,
      delta: complexityTrend.delta,
      sample_count: complexityTrend.sampleCount,
      first_value: complexityTrend.firstValue,
      last_value: complexityTrend.lastValue,
      narrative: complexityTrend.narrative,
    };
  }

  // Attach related findings
  if (dedupedRelated.length > 0) {
    result.related_findings = dedupedRelated.map((f) => ({
      title: f.title,
      category: f.category,
      severity: f.severity,
      file: f.targetFile,
    }));
    result.related_count = dedupedRelated.length;
  }

  // Attach run comparison
  if (runComparison && runComparison.runs.length >= 2) {
    result.run_comparison = {
      latest_run: runComparison.runs[0],
      previous_run: runComparison.runs[1],
      deltas: {
        nodes: runComparison.deltaNodes,
        edges: runComparison.deltaEdges,
        hotspots: runComparison.deltaHotspots,
        avg_complexity: runComparison.deltaAvgComplexity,
      },
      narrative: runComparison.narrative,
    };
  } else if (runComparison) {
    result.run_history = runComparison.runs;
    result.run_history_narrative = runComparison.narrative;
  }

  // Top-level narrative
  const trendNote = complexityTrend
    ? ` Trend: ${complexityTrend.narrative}`
    : '';
  const relatedNote =
    dedupedRelated.length > 0
      ? ` ${dedupedRelated.length} related findings in the same file.`
      : '';

  result.narrative =
    findings.length === 0
      ? `No previous findings in memory for this query.${trendNote}${relatedNote}`
      : `${findings.length} findings in persistent memory.${trendNote}${relatedNote}`;

  result._summary =
    findings.length === 0
      ? 'No data — this project has not been indexed or has no prior findings.'
      : `${findings.length} findings.` +
        (complexityTrend ? ` Complexity: ${complexityTrend.direction}.` : '') +
        (dedupedRelated.length > 0 ? ` ${dedupedRelated.length} related.` : '') +
        (runComparison && runComparison.runs.length >= 2
          ? ` ${runComparison.runs.length} index runs compared.`
          : '');

  return result;
}

export function filterFindingsByText(findings: LynxFinding[], query: string): LynxFinding[] {
  const tokens = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(token => token.length >= 3);
  if (tokens.length === 0) return findings;
  return findings.filter(finding => {
    const haystack = [finding.title, finding.description, finding.targetFile, finding.category]
      .join(' ').toLowerCase();
    return tokens.some(token => haystack.includes(token));
  });
}
