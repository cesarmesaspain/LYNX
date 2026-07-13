/*
 * delete_project.ts — Remove a project and all its data.
 */

import * as fs from 'node:fs';
import { getDb, unsetDb } from '../server.js';
import { projectNotIndexed } from '../diagnostics.js';

function purgePersistentDatabase(project: string, db: ReturnType<typeof getDb>): boolean {
  if (db.dbPath === ':memory:') return false;
  const dbPath = db.dbPath;
  db.close();
  unsetDb(project, { close: false });
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  return true;
}

export async function handleDeleteProject(
  args: Record<string, unknown>
): Promise<unknown> {
  const project = String(args.project || '');
  const confirm = args.confirm === true;

  if (!project) return { error: 'project is required' };
  if (!confirm) return { error: 'confirm: true is required to delete a project. This action is irreversible.' };

  const db = getDb(project);
  const projectMeta = db.getProject(project);
  if (!projectMeta) {
    // Empty persistent databases can be left by interrupted/older workflows.
    // With explicit confirmation, purge the artifact instead of keeping it in doctor output.
    if (purgePersistentDatabase(project, db)) {
      return {
        deleted: project,
        nodes_removed: 0,
        edges_removed: 0,
        database_purged: true,
        message: `Project database "${project}" was empty and has been removed.`,
      };
    }
    return { ...projectNotIndexed(project) };
  }

  // Count before deletion
  const nodeCount = (db.db
    .prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?')
    .get(project) as { cnt: number }).cnt;

  const edgeCount = (db.db
    .prepare('SELECT COUNT(*) as cnt FROM edges WHERE project = ?')
    .get(project) as { cnt: number }).cnt;

  db.deleteProject(project);
  const databasePurged = purgePersistentDatabase(project, db);

  return {
    deleted: project,
    nodes_removed: nodeCount,
    edges_removed: edgeCount,
    database_purged: databasePurged,
    message: `Project "${project}" deleted (${nodeCount} nodes, ${edgeCount} edges).`,
  };
}
