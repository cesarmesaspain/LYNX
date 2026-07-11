import { getDb } from '../server.js';
import { LynxDatabase } from '../../store/database.js';
import { readLynxConfig } from '../../config/runtime.js';
import { listOrphanedLocks } from '../../store/lock.js';

type IndexFreshness = 'ready' | 'stale' | 'updating' | 'failed' | 'unknown';

function computeFreshness(meta: { status: string; indexedAt: string }, nodeCount: number): IndexFreshness {
  const cfg = readLynxConfig();
  if (meta.status === 'failed') return 'failed';
  if (meta.status === 'updating') return 'updating';
  if (nodeCount > 0) {
    const ageHours = (Date.now() - new Date(meta.indexedAt).getTime()) / (1000 * 60 * 60);
    return ageHours > cfg.stale_threshold_hours ? 'stale' : 'ready';
  }
  return 'unknown';
}

export async function handleListProjects(
  _args: Record<string, unknown>
): Promise<unknown> {
  // Query all projects from the global projects table via the _memory DB
  const db = getDb();

  // First try the projects table (shared across all openProject DBs)
  const allRows = db.db
    .prepare('SELECT name, root_path, indexed_at, status, status_error FROM projects ORDER BY indexed_at DESC')
    .all() as Array<{ name: string; root_path: string; indexed_at: string; status: string; status_error: string | null }>;

  if (allRows.length > 0) {
    const orphanedLocks = listOrphanedLocks();
    const orphanedProjects = new Set(orphanedLocks.map(l => l.project));

    return {
      projects: allRows.map(p => {
        let db: LynxDatabase | null = null;
        let nodeCount = 0;
        try {
          db = LynxDatabase.openProject(p.name);
          const cnt = db.db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?').get(p.name) as { cnt: number };
          nodeCount = cnt.cnt;
        } catch { /* empty */ } finally {
          if (db) db.close();
        }

        return {
          name: p.name,
          root_path: p.root_path,
          indexed_at: p.indexed_at,
          status: p.status,
          status_error: p.status_error || null,
          freshness: computeFreshness({ status: p.status, indexedAt: p.indexed_at }, nodeCount),
          nodes: nodeCount,
          has_orphaned_lock: orphanedProjects.has(p.name),
        };
      }),
      count: allRows.length,
    };
  }

  return { projects: [], count: 0 };
}
