import { getDb, getResponseOptimizationMetrics } from '../server.js';
import { readLynxConfig } from '../../config/runtime.js';
import { isProjectLocked, listOrphanedLocks } from '../../store/lock.js';
import { storedTimestampMs } from '../../store/time.js';
import { discoverFiles } from '../../pipeline/phases/discover.js';

type IndexFreshness = 'ready' | 'stale' | 'updating' | 'failed' | 'unknown';

export async function handleIndexStatus(
  args: Record<string, unknown>
): Promise<unknown> {
  const project = String(args.project || '');

  const db = getDb(project);

  const meta = db.getProject(project);
  const locked = isProjectLocked(project);

  const nodeCount = db.db
    .prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?')
    .get(project) as { cnt: number };

  const edgeCount = db.db
    .prepare('SELECT COUNT(*) as cnt FROM edges WHERE project = ?')
    .get(project) as { cnt: number };

  const fileCount = db.db
    .prepare('SELECT COUNT(DISTINCT file_path) as cnt FROM nodes WHERE project = ?')
    .get(project) as { cnt: number };

  const nodeLabels = db.db
    .prepare(
      'SELECT kind, COUNT(*) as cnt FROM nodes WHERE project = ? GROUP BY kind ORDER BY cnt DESC'
    )
    .all(project) as Array<{ kind: string; cnt: number }>;

  const edgeTypes = db.db
    .prepare(
      'SELECT type, COUNT(*) as cnt FROM edges WHERE project = ? GROUP BY type ORDER BY cnt DESC'
    )
    .all(project) as Array<{ type: string; cnt: number }>;

  const findings = db.db
    .prepare('SELECT COUNT(*) as cnt FROM findings WHERE project = ?')
    .get(project) as { cnt: number };

  const lastRun = db.db
    .prepare(
      'SELECT run_at, mode, files_processed, files_skipped FROM index_runs WHERE project = ? ORDER BY id DESC LIMIT 1'
    )
    .get(project) as { run_at: string; mode: string; files_processed: number; files_skipped: number } | undefined;

  // ── Freshness ──────────────────────────────────────────
  let freshness: IndexFreshness = 'unknown';
  const cfg = readLynxConfig();

  if (meta) {
    if (meta.status === 'failed') {
      freshness = 'failed';
    } else if (locked || meta.status === 'updating') {
      freshness = 'updating';
    } else if (nodeCount.cnt > 0) {
      const indexedMs = storedTimestampMs(meta.indexedAt);
      const ageHours = (Date.now() - indexedMs) / (1000 * 60 * 60);
      freshness = ageHours > cfg.stale_threshold_hours ? 'stale' : 'ready';
    }
  }

  // ── Stale lock info ────────────────────────────────────
  let lockInfo: { locked: boolean; pid?: number; stale?: boolean } | null = null;
  if (locked && meta && meta.status !== 'updating') {
    const orphaned = listOrphanedLocks();
    const match = orphaned.find(l => l.project === project);
    if (match) {
      lockInfo = { locked: true, pid: match.pid, stale: true };
    }
  }

  const indexedAt = meta?.indexedAt || null;
  const hoursSinceIndex = indexedAt
    ? Math.round((Date.now() - storedTimestampMs(indexedAt)) / (1000 * 60 * 60))
    : null;
  let coverage: Record<string, unknown> | null = null;
  if (meta?.rootPath) {
    try {
      const discovery = discoverFiles(meta.rootPath, 'fast');
      coverage = {
        mode: 'fast',
        discoverable_files: discovery.files.length,
        indexed_files_with_nodes: fileCount.cnt,
        indexed_file_ratio: discovery.files.length === 0 ? 1 : Number((fileCount.cnt / discovery.files.length).toFixed(3)),
        excluded_directories: discovery.excludedDirs.slice(0, 100),
        note: 'Freshness is temporal; coverage reports how much discoverable source has graph nodes.',
      };
    } catch {
      coverage = { unavailable: true, note: 'Coverage scan could not read the project root.' };
    }
  }

  return {
    project,
    indexed: nodeCount.cnt > 0,
    freshness,
    freshness_ttl_hours: cfg.stale_threshold_hours,
    hours_since_index: hoursSinceIndex,
    indexed_at: indexedAt,
    project_status: meta?.status || null,
    project_status_error: meta?.statusError || null,
    lock_info: lockInfo,
    nodes: nodeCount.cnt,
    edges: edgeCount.cnt,
    files: fileCount.cnt,
    coverage,
    findings: findings.cnt,
    node_labels: Object.fromEntries(nodeLabels.map((r) => [r.kind, r.cnt])),
    edge_types: Object.fromEntries(edgeTypes.map((r) => [r.type, r.cnt])),
    response_optimization: getResponseOptimizationMetrics(),
    last_run: lastRun ? {
      at: lastRun.run_at,
      mode: lastRun.mode,
      files_processed: lastRun.files_processed,
      files_skipped: lastRun.files_skipped,
    } : null,
  };
}
