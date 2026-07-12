/*
 * project-catalog.ts — Shared discovery of persistent LYNX project indexes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { LynxDatabase } from '../store/database.js';
import { lynxHome } from '../config/runtime.js';

export interface IndexedProject {
  name: string;
  rootPath: string;
  indexedAt: string;
  status: string;
  statusError: string | null;
  nodeCount: number;
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

  return results.sort((a, b) => new Date(b.indexedAt).getTime() - new Date(a.indexedAt).getTime());
}
