import * as fs from 'node:fs';
import { readLynxConfig } from '../../config/runtime.js';
import { listOrphanedLocks } from '../../store/lock.js';
import { storedTimestampMs } from '../../store/time.js';
import { scanIndexedProjects } from '../project-catalog.js';

type IndexFreshness = 'ready' | 'stale' | 'updating' | 'failed' | 'unknown';

function computeFreshness(meta: { status: string; indexedAt: string }, nodeCount: number): IndexFreshness {
  const cfg = readLynxConfig();
  if (meta.status === 'failed') return 'failed';
  if (meta.status === 'updating') return 'updating';
  if (nodeCount > 0) {
    const ageHours = (Date.now() - storedTimestampMs(meta.indexedAt)) / (1000 * 60 * 60);
    return ageHours > cfg.stale_threshold_hours ? 'stale' : 'ready';
  }
  return 'unknown';
}

export async function handleListProjects(
  _args: Record<string, unknown>
): Promise<unknown> {
  const allRows = scanIndexedProjects();

  if (allRows.length > 0) {
    const orphanedLocks = listOrphanedLocks();
    const orphanedProjects = new Set(orphanedLocks.map(l => l.project));

    return {
      projects: allRows.map(p => ({
        name: p.name,
        root_path: p.rootPath,
        root_exists: fs.existsSync(p.rootPath),
        indexed_at: p.indexedAt,
        status: p.status,
        status_error: p.statusError,
        freshness: computeFreshness({ status: p.status, indexedAt: p.indexedAt }, p.nodeCount),
        nodes: p.nodeCount,
        has_orphaned_lock: orphanedProjects.has(p.name),
      })),
      count: allRows.length,
    };
  }

  return { projects: [], count: 0 };
}
