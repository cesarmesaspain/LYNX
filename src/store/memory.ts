/*
 * memory.ts — Persistent findings store.
 *
 * LYNX's key differentiator: stores analysis results across sessions.
 * When a hotspot is found, complexity measured, or cluster detected,
 * the finding is persisted so future analyses can reference it.
 */

import type { LynxDatabase } from './database.js';
import type { LynxFinding } from '../types.js';

interface FindingRow {
  id: number;
  project: string;
  target_qn: string;
  target_file: string;
  category: string;
  severity: string;
  title: string;
  description: string;
  metrics: string;
  created_at: string;
  updated_at: string;
}

// ── CRUD ────────────────────────────────────────────────────────

export function upsertFinding(db: LynxDatabase, finding: LynxFinding): number {
  const result = db.db
    .prepare(
      `INSERT INTO findings (project, target_qn, target_file, category, severity, title, description, metrics)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         severity = excluded.severity, title = excluded.title,
         description = excluded.description, metrics = excluded.metrics,
         updated_at = datetime('now')`
    )
    .run(
      finding.project,
      finding.targetQn,
      finding.targetFile,
      finding.category,
      finding.severity,
      finding.title,
      finding.description,
      JSON.stringify(finding.metrics)
    );

  if (finding.id !== undefined) {
    // Update existing
    db.db
      .prepare(
        `UPDATE findings SET severity = ?, title = ?, description = ?, metrics = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(finding.severity, finding.title, finding.description, JSON.stringify(finding.metrics), finding.id);
    return finding.id;
  }
  return Number(result.lastInsertRowid);
}

export function getFindingsByQn(
  db: LynxDatabase,
  project: string,
  qn: string
): LynxFinding[] {
  const rows = db.db
    .prepare('SELECT * FROM findings WHERE project = ? AND target_qn = ? ORDER BY updated_at DESC')
    .all(project, qn) as FindingRow[];
  return rows.map(rowToFinding);
}

export function getFindingsByFile(
  db: LynxDatabase,
  project: string,
  filePath: string
): LynxFinding[] {
  const rows = db.db
    .prepare('SELECT * FROM findings WHERE project = ? AND target_file = ? ORDER BY updated_at DESC')
    .all(project, filePath) as FindingRow[];
  return rows.map(rowToFinding);
}

export function getFindingsByCategory(
  db: LynxDatabase,
  project: string,
  category: string,
  limit = 50
): LynxFinding[] {
  const rows = db.db
    .prepare(
      'SELECT * FROM findings WHERE project = ? AND category = ? ORDER BY updated_at DESC LIMIT ?'
    )
    .all(project, category, limit) as FindingRow[];
  return rows.map(rowToFinding);
}

export function getRecentFindings(
  db: LynxDatabase,
  project: string,
  limit = 20
): LynxFinding[] {
  const rows = db.db
    .prepare('SELECT * FROM findings WHERE project = ? ORDER BY updated_at DESC LIMIT ?')
    .all(project, limit) as FindingRow[];
  return rows.map(rowToFinding);
}

export function deleteFinding(db: LynxDatabase, id: number): void {
  db.db.prepare('DELETE FROM findings WHERE id = ?').run(id);
}

// ── Snapshots (persist hotspot snapshots for trend analysis) ───

export function saveHotspotSnapshot(
  db: LynxDatabase,
  project: string,
  hotspots: Array<{ qn: string; file: string; fanIn: number; complexity: number }>
): void {
  const now = new Date().toISOString();
  for (const hs of hotspots) {
    upsertFinding(db, {
      project,
      targetQn: hs.qn,
      targetFile: hs.file,
      category: 'hotspot',
      severity: hs.complexity > 200 ? 'critical' : hs.complexity > 100 ? 'high' : hs.complexity > 50 ? 'medium' : 'low',
      title: `${hs.qn.split('.').pop()} — fan_in=${hs.fanIn}, complexity=${hs.complexity}`,
      description: '',
      metrics: { fanIn: hs.fanIn, complexity: hs.complexity, snapshotAt: now },
      createdAt: now,
      updatedAt: now,
    });
  }
}

// ── File hash cache (incremental indexing) ──────────────────────

export function getFileHash(
  db: LynxDatabase,
  project: string,
  relPath: string
): string | null {
  const row = db.db
    .prepare('SELECT sha256 FROM file_hashes WHERE project = ? AND rel_path = ?')
    .get(project, relPath) as { sha256: string } | undefined;
  return row?.sha256 ?? null;
}

export function getAllFileHashes(
  db: LynxDatabase,
  project: string
): Map<string, string> {
  const rows = db.db
    .prepare('SELECT rel_path, sha256 FROM file_hashes WHERE project = ?')
    .all(project) as Array<{ rel_path: string; sha256: string }>;
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.rel_path, r.sha256);
  return map;
}

/** Count canonical indexed files that produced at least one graph node. */
export function countFilesWithGraphNodes(
  db: LynxDatabase,
  project: string,
): number {
  const row = db.db
    .prepare(
      `SELECT COUNT(DISTINCT n.file_path) AS count
       FROM nodes n
       INNER JOIN file_hashes h
         ON h.project = n.project AND h.rel_path = n.file_path
       WHERE n.project = ? AND n.file_path != ''`,
    )
    .get(project) as { count: number };
  return row.count;
}

export function upsertFileHash(
  db: LynxDatabase,
  project: string,
  relPath: string,
  sha256: string,
  mtimeNs: number,
  size: number
): void {
  db.db
    .prepare(
      `INSERT INTO file_hashes (project, rel_path, sha256, mtime_ns, size)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project, rel_path) DO UPDATE SET
         sha256 = excluded.sha256, mtime_ns = excluded.mtime_ns, size = excluded.size`
    )
    .run(project, relPath, sha256, mtimeNs, size);
}

export function deleteFileHash(db: LynxDatabase, project: string, relPath: string): void {
  db.db.prepare('DELETE FROM file_hashes WHERE project = ? AND rel_path = ?').run(project, relPath);
}

// ── Persistent LLM summary cache ───────────────────────────────

export interface CachedLlmSummary {
  summary: string;
  sourceTokensEst: number;
  summaryTokensEst: number;
}

export function getCachedLlmSummary(
  db: LynxDatabase,
  project: string,
  sourceHash: string,
): CachedLlmSummary | null {
  const row = db.db.prepare(
    `SELECT summary, source_tokens_est, summary_tokens_est
     FROM llm_summary_cache WHERE project = ? AND source_hash = ?`,
  ).get(project, sourceHash) as {
    summary: string; source_tokens_est: number; summary_tokens_est: number;
  } | undefined;
  return row ? {
    summary: row.summary,
    sourceTokensEst: row.source_tokens_est,
    summaryTokensEst: row.summary_tokens_est,
  } : null;
}

export function upsertCachedLlmSummary(
  db: LynxDatabase,
  project: string,
  sourceHash: string,
  summary: string,
  sourceTokensEst: number,
  summaryTokensEst: number,
): void {
  db.db.prepare(
    `INSERT INTO llm_summary_cache (project, source_hash, summary, source_tokens_est, summary_tokens_est)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project, source_hash) DO UPDATE SET
       summary = excluded.summary,
       source_tokens_est = excluded.source_tokens_est,
       summary_tokens_est = excluded.summary_tokens_est,
       created_at = datetime('now')`,
  ).run(project, sourceHash, summary, sourceTokensEst, summaryTokensEst);
}

export function deleteFindingsByFile(db: LynxDatabase, project: string, relPath: string): void {
  db.db.prepare('DELETE FROM findings WHERE project = ? AND target_file = ?').run(project, relPath);
}

// ── Index runs (track indexing history for trend analysis) ──────

export interface RunSnapshot {
  id: number;
  project: string;
  runAt: string;
  totalNodes: number;
  totalEdges: number;
  hotspotCount: number;
  avgComplexity: number;
  filesProcessed: number;
  filesSkipped: number;
  mode: string;
  coverage: IndexRunCoverage | null;
}

export interface IndexRunCoverage {
  callsExtracted: number;
  callsResolved: number;
  callsUnresolved: number;
  unresolvedCallReasons: Record<string, number>;
  callResolutionRate: number;
  partialFiles: Array<{ file: string; reasons: string[] }>;
}

export function insertIndexRun(
  db: LynxDatabase,
  run: Omit<RunSnapshot, 'id' | 'runAt'>
): number {
  const result = db.db
    .prepare(
      `INSERT INTO index_runs (project, total_nodes, total_edges, hotspot_count,
         avg_complexity, files_processed, files_skipped, mode, coverage_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      run.project,
      run.totalNodes,
      run.totalEdges,
      run.hotspotCount,
      run.avgComplexity,
      run.filesProcessed,
      run.filesSkipped,
      run.mode,
      run.coverage ? JSON.stringify(run.coverage) : null,
    );
  return Number(result.lastInsertRowid);
}

export function getLastRuns(
  db: LynxDatabase,
  project: string,
  count: number
): RunSnapshot[] {
  const rows = db.db
    .prepare(
      `SELECT * FROM index_runs WHERE project = ? ORDER BY run_at DESC LIMIT ?`
    )
    .all(project, count) as Array<{
      id: number; project: string; run_at: string;
      total_nodes: number; total_edges: number; hotspot_count: number;
      avg_complexity: number; files_processed: number; files_skipped: number; mode: string;
      coverage_json: string | null;
    }>;

  return rows.map((r) => ({
    id: r.id,
    project: r.project,
    runAt: r.run_at,
    totalNodes: r.total_nodes,
    totalEdges: r.total_edges,
    hotspotCount: r.hotspot_count,
    avgComplexity: r.avg_complexity,
    filesProcessed: r.files_processed,
    filesSkipped: r.files_skipped,
    mode: r.mode,
    coverage: parseIndexRunCoverage(r.coverage_json),
  }));
}

export function getLastIndexCoverage(
  db: LynxDatabase,
  project: string,
): IndexRunCoverage | null {
  const row = db.db
    .prepare('SELECT coverage_json FROM index_runs WHERE project = ? ORDER BY id DESC LIMIT 1')
    .get(project) as { coverage_json: string | null } | undefined;
  return parseIndexRunCoverage(row?.coverage_json ?? null);
}

function parseIndexRunCoverage(value: string | null): IndexRunCoverage | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as IndexRunCoverage;
    if (!Number.isFinite(parsed.callsExtracted) || !Number.isFinite(parsed.callsUnresolved)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Trend analysis ───────────────────────────────────────────────

export interface ComplexityTrend {
  direction: 'improving' | 'worsening' | 'stable' | 'no_data';
  delta: number; // positive = complexity increased
  sampleCount: number;
  firstValue: number | null;
  lastValue: number | null;
  narrative: string;
}

/**
 * Analyze complexity trend from hotspot snapshots.
 * Compares the oldest and newest snapshot to determine direction.
 */
export function getComplexityTrend(
  db: LynxDatabase,
  project: string,
  qn: string,
  maxSamples = 10
): ComplexityTrend {
  const rows = db.db
    .prepare(
      `SELECT created_at, json_extract(metrics, '$.complexity') as complexity
       FROM findings WHERE project = ? AND target_qn = ? AND category = 'hotspot'
       ORDER BY created_at ASC`
    )
    .all(project, qn) as Array<{ created_at: string; complexity: number | null }>;

  const valid = rows.filter((r) => r.complexity !== null);

  if (valid.length < 2) {
    const fallback: ComplexityTrend = {
      direction: 'no_data',
      delta: 0,
      sampleCount: valid.length,
      firstValue: valid[0]?.complexity ?? null,
      lastValue: valid[0]?.complexity ?? null,
      narrative: valid.length === 0
        ? 'No complexity history recorded.'
        : 'Only one complexity snapshot exists — at least two are required to calculate a trend.',
    };
    return fallback;
  }

  const first = valid[0].complexity!;
  const last = valid[valid.length - 1].complexity!;
  const delta = last - first;

  let direction: ComplexityTrend['direction'];
  let narrative: string;

  if (delta < -5) {
    direction = 'improving';
    narrative = `Improving — complexity decreased from ${first} to ${last} (${Math.abs(delta)} points) across ${valid.length} snapshots.`;
  } else if (delta > 5) {
    direction = 'worsening';
    narrative = `Worsening — complexity increased from ${first} to ${last} (+${delta} points) across ${valid.length} snapshots.`;
  } else {
    direction = 'stable';
    narrative = `Stable — complexity remains near ${last} (±${Math.abs(delta)} points) across ${valid.length} snapshots.`;
  }

  return {
    direction,
    delta,
    sampleCount: valid.length,
    firstValue: first,
    lastValue: last,
    narrative,
  };
}

// ── Related findings ─────────────────────────────────────────────

/**
 * Get findings from the same file as the target QN.
 * Useful to surface co-located issues.
 */
export function getRelatedFindings(
  db: LynxDatabase,
  project: string,
  qn: string,
  limit = 10
): LynxFinding[] {
  // First find the file for this QN
  const node = db.db
    .prepare('SELECT file_path FROM nodes WHERE project = ? AND qualified_name = ?')
    .get(project, qn) as { file_path: string } | undefined;

  if (!node) return [];

  const rows = db.db
    .prepare(
      `SELECT * FROM findings WHERE project = ? AND target_file = ? AND target_qn != ?
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(project, node.file_path, qn, limit) as FindingRow[];

  return rows.map(rowToFinding);
}

// ── Run comparison ────────────────────────────────────────────────

export interface RunComparison {
  runs: RunSnapshot[];
  deltaNodes: number | null;
  deltaEdges: number | null;
  deltaHotspots: number | null;
  deltaAvgComplexity: number | null;
  narrative: string;
}

/**
 * Compare the last two index runs for a project.
 * Returns deltas and a narrative summary of what changed.
 */
export function compareRuns(
  db: LynxDatabase,
  project: string
): RunComparison {
  const runs = getLastRuns(db, project, 2);

  if (runs.length < 2) {
    return {
      runs,
      deltaNodes: null,
      deltaEdges: null,
      deltaHotspots: null,
      deltaAvgComplexity: null,
      narrative: runs.length === 0
        ? 'No index history to compare.'
        : 'Only one index run — at least a second is needed.',
    };
  }

  const latest = runs[0];
  const previous = runs[1];
  const deltaNodes = latest.totalNodes - previous.totalNodes;
  const deltaEdges = latest.totalEdges - previous.totalEdges;
  const deltaHotspots = latest.hotspotCount - previous.hotspotCount;
  const deltaAvg = Math.round((latest.avgComplexity - previous.avgComplexity) * 100) / 100;

  // Build narrative
  const parts: string[] = [];
  if (deltaNodes !== 0) {
    parts.push(`${deltaNodes > 0 ? '+' : ''}${deltaNodes} nodes`);
  }
  if (deltaEdges !== 0) {
    parts.push(`${deltaEdges > 0 ? '+' : ''}${deltaEdges} edges`);
  }
  if (deltaHotspots !== 0) {
    parts.push(`${deltaHotspots > 0 ? '+' : ''}${deltaHotspots} hotspots`);
  }

  const narrative = parts.length > 0
    ? `From run #${previous.id} to #${latest.id}: ${parts.join(', ')}. Avg complexity: ${deltaAvg >= 0 ? '+' : ''}${deltaAvg}.`
    : `From run #${previous.id} to #${latest.id}: no structural changes. Avg complexity: ${deltaAvg >= 0 ? '+' : ''}${deltaAvg}.`;

  return {
    runs,
    deltaNodes,
    deltaEdges,
    deltaHotspots,
    deltaAvgComplexity: deltaAvg,
    narrative,
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function rowToFinding(row: FindingRow): LynxFinding {
  return {
    id: row.id,
    project: row.project,
    targetQn: row.target_qn,
    targetFile: row.target_file,
    category: row.category as LynxFinding['category'],
    severity: row.severity as LynxFinding['severity'],
    title: row.title,
    description: row.description,
    metrics: JSON.parse(row.metrics),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
