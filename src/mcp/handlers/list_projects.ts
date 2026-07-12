import * as fs from 'fs';
import * as path from 'path';
import { LynxDatabase } from '../../store/database.js';
import { readLynxConfig, lynxHome } from '../../config/runtime.js';
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

function scanProjectDbs(): Array<{ name: string; rootPath: string; indexedAt: string; status: string; statusError: string | null; nodeCount: number }> {
  const dbsDir = path.join(lynxHome(), 'dbs');
  if (!fs.existsSync(dbsDir)) return [];

  const files = fs.readdirSync(dbsDir).filter(f => f.endsWith('.db'));
  const results: Array<{ name: string; rootPath: string; indexedAt: string; status: string; statusError: string | null; nodeCount: number }> = [];

  for (const file of files) {
    const projectName = file.replace(/\.db$/, '');
    let db: LynxDatabase | null = null;
    try {
      db = LynxDatabase.openProject(projectName);
      const row = db.db
        .prepare('SELECT name, root_path, indexed_at, status, status_error FROM projects WHERE name = ?')
        .get(projectName) as { name: string; root_path: string; indexed_at: string; status: string; status_error: string | null } | undefined;
      if (!row) continue;
      const cnt = db.db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?').get(projectName) as { cnt: number };
      results.push({
        name: row.name,
        rootPath: row.root_path,
        indexedAt: row.indexed_at,
        status: row.status,
        statusError: row.status_error || null,
        nodeCount: cnt.cnt,
      });
    } catch {
      // stale/corrupt DB — skip
    } finally {
      if (db) db.close();
    }
  }

  results.sort((a, b) => new Date(b.indexedAt).getTime() - new Date(a.indexedAt).getTime());
  return results;
}

export async function handleListProjects(
  _args: Record<string, unknown>
): Promise<unknown> {
  const allRows = scanProjectDbs();

  if (allRows.length > 0) {
    const orphanedLocks = listOrphanedLocks();
    const orphanedProjects = new Set(orphanedLocks.map(l => l.project));

    return {
      projects: allRows.map(p => ({
        name: p.name,
        root_path: p.rootPath,
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
