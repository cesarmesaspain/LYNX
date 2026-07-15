/*
 * project-catalog.ts — Shared discovery of persistent LYNX project indexes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { LynxDatabase } from '../store/database.js';
import { lynxHome } from '../config/runtime.js';
import { storedTimestampMs } from '../store/time.js';
export interface IndexedProject {
  name: string;
  rootPath: string;
  indexedAt: string;
  status: string;
  statusError: string | null;
  nodeCount: number;
}

export interface DuplicateProjectRoot {
  rootPath: string;
  projects: string[];
}

function canonicalRoot(rootPath: string): string {
  try {
    return fs.realpathSync.native(path.resolve(rootPath));
  } catch {
    return path.resolve(rootPath);
  }
}

/**
 * Legacy installs can contain two database names for one checkout (for
 * example LYNX.db and lynx.db). Surface that condition instead of silently
 * routing depending on filesystem ordering. New indexing refuses to create it.
 */
export function findDuplicateProjectRoots(projects: IndexedProject[] = scanIndexedProjects()): DuplicateProjectRoot[] {
  const byRoot = new Map<string, string[]>();
  for (const project of projects) {
    const root = canonicalRoot(project.rootPath);
    const names = byRoot.get(root) || [];
    names.push(project.name);
    byRoot.set(root, names);
  }
  return [...byRoot.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([rootPath, names]) => ({ rootPath, projects: names.sort((a, b) => a.localeCompare(b)) }));
}

export function scanIndexedProjects(): IndexedProject[] {
  const dbsDir = path.join(lynxHome(), 'dbs');
  if (!fs.existsSync(dbsDir)) return [];

  const results: IndexedProject[] = [];
  for (const file of fs.readdirSync(dbsDir).filter(f => f.endsWith('.db'))) {
    const projectName = file.replace(/\.db$/, '');
    let db: LynxDatabase | null = null;
    try {
      db = LynxDatabase.openProject(projectName);
      const row = db.db
        .prepare('SELECT name, root_path, indexed_at, status, status_error FROM projects WHERE name = ?')
        .get(projectName) as { name: string; root_path: string; indexed_at: string; status: string; status_error: string | null } | undefined;
      if (!row) continue;
      const count = db.db.prepare('SELECT COUNT(*) as count FROM nodes WHERE project = ?').get(projectName) as { count: number };
      results.push({
        name: row.name,
        rootPath: row.root_path,
        indexedAt: row.indexed_at,
        status: row.status,
        statusError: row.status_error || null,
        nodeCount: count.count,
      });
    } catch {
      // A corrupt or stale DB must not prevent discovery of healthy projects.
    } finally {
      db?.close();
    }
  }

  return results.sort((a, b) => storedTimestampMs(b.indexedAt) - storedTimestampMs(a.indexedAt));
}
