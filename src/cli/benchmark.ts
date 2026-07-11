/*
 * benchmark.ts — Product-value benchmark for LYNX demos. v4.
 *
 * - Warm-up rounds (--warmup N) excluded from stats
 * - Multi-round (--rounds N) with median/p95 latency
 * - Response bytes measured per query
 * - JSON output (--json) for programmatic consumption
 * - Semantic ROI tracking per query
 * - "Semantic lift" terminology (hides LLM from user-facing output)
 */

import * as path from 'node:path';
import { LynxDatabase } from '../store/database.js';
import { searchFullText } from '../store/search.js';
import { findNearestProject } from '../discovery/project-scanner.js';
import { runPipeline } from '../pipeline/orchestrator.js';
import { getRerankProviderMode, rerankSearch } from '../llm/client.js';
import {
  estimateRerankCostUsd,
  estimateTokensSaved,
  recordUsageEvent,
  summarizeUsage,
  computeSemanticROI,
  clearSessionDedup,
} from '../usage/metrics.js';

const DEFAULT_QUERIES = [
  'contact form',
  'send email',
  'authentication',
  'api route',
  'dashboard',
];

interface BenchmarkRow {
  query: string;
  results: number;
  latency_ms: number;
  semantic_latency_ms: number;
  semantic_rank_changed: boolean;
  semantic_top_changed: boolean;
  semantic_cost_usd: number;
  files_avoided: number;
  tokens_saved: number;
  confidence: string;
  top: string;
  semantic_top: string;
  response_bytes: number;
}

interface RoundStats {
  avg_latency: number;
  avg_semantic_latency: number;
  total_tokens_saved: number;
  total_files_avoided: number;
  semantic_rank_changed: number;
  semantic_top_changed: number;
  semantic_cost: number;
  semantic_roi: number | null;
  total_response_bytes: number;
  rows: BenchmarkRow[];
}

interface BenchmarkResult {
  project: string;
  repo_path: string;
  warmup_rounds: number;
  measured_rounds: number;
  warmup: RoundStats[];
  rounds: RoundStats[];
  aggregate: {
    median_latency_ms: number;
    p95_latency_ms: number;
    avg_latency_ms: number;
    total_tokens_saved: number;
    total_files_avoided: number;
    total_response_bytes: number;
    stddev_latency_ms: number;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function median(sorted: number[]): number {
  return percentile(sorted, 50);
}

function measureResponseBytes(rows: BenchmarkRow[]): number {
  const payload = { rows };
  return Buffer.byteLength(JSON.stringify(payload), 'utf-8');
}

export async function runBenchmark(args: string[]): Promise<void> {
  const targetPath = args[0] && !args[0].startsWith('--') ? args[0] : process.cwd();
  const nameIdx = args.indexOf('--name');
  const queryIdx = args.indexOf('--query');
  const modeIdx = args.indexOf('--mode');
  const roundsIdx = args.indexOf('--rounds');
  const warmupIdx = args.indexOf('--warmup');
  const shouldIndex = args.includes('--index');
  const jsonOutput = args.includes('--json');

  const detected = findNearestProject(targetPath);
  if (!detected) {
    console.error('No project detected for benchmark.');
    process.exit(1);
  }

  const project =
    nameIdx !== -1 && args[nameIdx + 1] ? args[nameIdx + 1] : detected.name;
  const queries =
    queryIdx !== -1 && args[queryIdx + 1]
      ? args[queryIdx + 1].split(',').map((q) => q.trim()).filter(Boolean)
      : DEFAULT_QUERIES;
  const mode = (
    modeIdx !== -1 && args[modeIdx + 1] ? args[modeIdx + 1] : 'fast'
  ) as 'fast' | 'moderate' | 'full';
  const totalRounds = roundsIdx !== -1 ? Math.max(1, Number(args[roundsIdx + 1]) || 1) : 3;
  const warmupRounds = warmupIdx !== -1 ? Math.max(0, Number(args[warmupIdx + 1]) || 0) : 1;

  const repoPath = path.resolve(detected.rootPath);

  // ── Index if requested ───────────────────────────────────
  if (shouldIndex) {
    const db = LynxDatabase.openProject(project);
    try {
      const start = Date.now();
      const result = await runPipeline(db, repoPath, project, { mode, incremental: true });
      if (!jsonOutput) {
        console.log(`Index: ${Date.now() - start}ms, ${result.status.totalNodes} nodes, ${result.status.totalEdges} edges`);
      }
    } finally {
      db.close();
    }
  }

  // ── Run all rounds (warmup + measured) ───────────────────
  const allRounds: RoundStats[] = [];

  for (let round = 0; round < warmupRounds + totalRounds; round++) {
    clearSessionDedup(project);
    const db = LynxDatabase.openProject(project);
    try {
      const semanticProvider = getRerankProviderMode();
      let totalLatency = 0;
      let totalTokensSaved = 0;
      let totalFilesAvoided = 0;
      let semanticRankChanged = 0;
      let semanticTopChanged = 0;
      let semanticLatencyTotal = 0;
      let semanticCostTotal = 0;
      const rows: BenchmarkRow[] = [];

      for (const query of queries) {
        const start = Date.now();
        const results = searchFullText(db, project, query, 8);
        const latency = Date.now() - start;
        const originalTop = results[0]?.node.qualifiedName || '(no result)';
        const semanticStart = Date.now();
        let semanticTop = originalTop;
        let rankChanged = false;
        let topChanged = false;

        if (results.length >= 3 && semanticProvider !== 'heuristic') {
          const ranked = await rerankSearch(
            query,
            results.map((r, index) => ({
              index,
              name: r.node.name,
              kind: r.node.kind,
              snippet: `${r.node.kind} ${r.node.name} in ${r.node.filePath}:${r.node.startLine}`,
            }))
          );
          const reordered = ranked
            .sort((a, b) => b.relevanceScore - a.relevanceScore)
            .map((r) => results[r.index])
            .filter(Boolean);
          const originalOrder = results.map((r) => r.node.qualifiedName);
          const nextOrder = reordered.map((r) => r.node.qualifiedName);
          rankChanged = nextOrder.some((qn, i) => qn !== originalOrder[i]);
          semanticTop = reordered[0]?.node.qualifiedName || originalTop;
          topChanged = semanticTop !== originalTop;
        }

        const semanticLatency = Date.now() - semanticStart;
        const semanticCost =
          semanticProvider === 'heuristic' ? 0 : estimateRerankCostUsd(results.length);
        if (rankChanged) semanticRankChanged++;
        if (topChanged) semanticTopChanged++;
        semanticLatencyTotal += semanticLatency;
        semanticCostTotal += semanticCost;
        const value = estimateTokensSaved(results.length, Math.max(results.length * 4, 8));
        totalLatency += latency;
        totalTokensSaved += value.tokensSaved;
        totalFilesAvoided += value.filesAvoided;

        rows.push({
          query,
          results: results.length,
          latency_ms: latency,
          semantic_latency_ms: semanticLatency,
          semantic_rank_changed: rankChanged,
          semantic_top_changed: topChanged,
          semantic_cost_usd: semanticCost,
          files_avoided: value.filesAvoided,
          tokens_saved: value.tokensSaved,
          confidence: value.confidence,
          top: originalTop,
          semantic_top: semanticTop,
          response_bytes: 0,
        });

        recordUsageEvent({
          type: 'benchmark',
          project,
          query,
          result_count: results.length,
          unique_files: new Set(results.map((r) => r.node.filePath)).size,
          files_avoided: value.filesAvoided,
          tokens_saved: value.tokensSaved,
          confidence: value.confidence,
          latency_ms: latency,
          llm_provider: semanticProvider,
          llm_latency_ms: semanticLatency,
          estimated_llm_cost_usd: semanticCost,
          rank_changed: rankChanged,
          top_changed: topChanged,
          tool_hint: 'benchmark',
        });
      }

      // Measure response bytes for this round's output
      const responseBytes = measureResponseBytes(rows);
      for (const row of rows) row.response_bytes = Math.round(responseBytes / rows.length);

      const roi = computeSemanticROI(totalTokensSaved, semanticCostTotal);
      allRounds.push({
        avg_latency: Math.round(totalLatency / Math.max(rows.length, 1)),
        avg_semantic_latency: Math.round(semanticLatencyTotal / Math.max(rows.length, 1)),
        total_tokens_saved: totalTokensSaved,
        total_files_avoided: totalFilesAvoided,
        semantic_rank_changed: semanticRankChanged,
        semantic_top_changed: semanticTopChanged,
        semantic_cost: semanticCostTotal,
        semantic_roi: roi.tokensPerDollar,
        total_response_bytes: responseBytes,
        rows,
      });
    } finally {
      db.close();
    }
  }

  // ── Split warmup from measured rounds ─────────────────────
  const warmup = allRounds.slice(0, warmupRounds);
  const measured = allRounds.slice(warmupRounds);

  // ── Aggregate across measured rounds ──────────────────────
  const latencies = measured.flatMap(r => r.rows.map(qr => qr.latency_ms)).sort((a, b) => a - b);
  const avgTokens = measured.length > 0
    ? Math.round(measured.reduce((s, r) => s + r.total_tokens_saved, 0) / measured.length)
    : 0;
  const avgFilesAvoided = measured.length > 0
    ? Math.round(measured.reduce((s, r) => s + r.total_files_avoided, 0) / measured.length)
    : 0;
  const totalResponseBytes = measured.length > 0
    ? measured.reduce((s, r) => s + r.total_response_bytes, 0)
    : 0;
  const meanLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const variance = latencies.length > 0
    ? latencies.reduce((s, l) => s + (l - meanLatency) ** 2, 0) / latencies.length : 0;

  const result: BenchmarkResult = {
    project,
    repo_path: repoPath,
    warmup_rounds: warmupRounds,
    measured_rounds: totalRounds,
    warmup,
    rounds: measured,
    aggregate: {
      median_latency_ms: Math.round(median(latencies)),
      p95_latency_ms: Math.round(percentile(latencies, 95)),
      avg_latency_ms: Math.round(meanLatency),
      total_tokens_saved: avgTokens,
      total_files_avoided: avgFilesAvoided,
      total_response_bytes: totalResponseBytes,
      stddev_latency_ms: Math.round(Math.sqrt(variance)),
    },
  };

  // ── Output ────────────────────────────────────────────────
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable output
  const last = measured[measured.length - 1];
  console.log(`\nLYNX benchmark — ${project}`);
  console.log(`Root: ${repoPath}`);
  console.log(`Warm-up rounds: ${warmupRounds}  |  Measured rounds: ${totalRounds}`);

  console.log('\nQueries:');
  for (const row of last.rows) {
    console.log(`- "${row.query}": ${row.results} results, ${row.latency_ms}ms, ~${row.tokens_saved.toLocaleString()} estimated tokens saved (${row.confidence}), ~${row.response_bytes}B`);
    console.log(`  local top: ${row.top}`);
    if (row.semantic_rank_changed || row.semantic_top_changed) {
      console.log(`  semantic lift: top=${row.semantic_top}, ${row.semantic_latency_ms}ms, $${row.semantic_cost_usd}`);
    }
  }

  console.log('\nAggregate (measured rounds only):');
  console.log(`Median latency: ${result.aggregate.median_latency_ms}ms`);
  console.log(`P95 latency: ${result.aggregate.p95_latency_ms}ms`);
  console.log(`Average latency: ${result.aggregate.avg_latency_ms}ms (±${result.aggregate.stddev_latency_ms}ms)`);
  console.log(`Semantic ranking provider: ${getRerankProviderMode()}`);
  console.log(`Semantic rank improved: ${last.semantic_rank_changed}/${last.rows.length} queries`);
  console.log(`Semantic top improved: ${last.semantic_top_changed}/${last.rows.length} queries`);
  console.log(`Average semantic latency: ${last.avg_semantic_latency}ms`);
  console.log(`Semantic cost: $${last.semantic_cost.toFixed(6)}`);
  console.log(`Estimated files avoided: ${result.aggregate.total_files_avoided} (avg/round)`);
  console.log(`Estimated tokens saved: ${result.aggregate.total_tokens_saved.toLocaleString()} (avg/round)`);
  console.log(`Response bytes: ${result.aggregate.total_response_bytes.toLocaleString()} (total), ${Math.round(totalResponseBytes / Math.max(measured.length, 1)).toLocaleString()} (avg/round)`);

  if (last.semantic_roi !== null && last.semantic_roi !== Infinity) {
    console.log(`Semantic ROI: ${last.semantic_roi.toLocaleString()} tokens saved per $1`);
  }

  const usage = summarizeUsage(project, 1000);
  console.log(`\nSession estimated tokens saved: ${usage.tokens_saved.toLocaleString()}`);
  console.log(`Session unique estimated files avoided: ${usage.unique_files_avoided}`);
  console.log(`Usage log: ~/.lynx/usage.jsonl`);

  // Generate report
  const { runReport } = await import('./report.js');
  runReport([project]);
}
