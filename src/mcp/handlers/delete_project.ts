/*
 * delete_project.ts — Remove a project and all its data.
 */

import { getDb } from '../server.js';
import { projectNotIndexed } from '../diagnostics.js';

export async function handleDeleteProject(
  args: Record<string, unknown>
): Promise<unknown> {
  const project = String(args.project || '');
  const confirm = args.confirm === true;

  if (!project) return { error: 'project is required' };
  if (!confirm) return { error: 'confirm: true is required to delete a project. This action is irreversible.' };

  const db = getDb(project);
  const projectMeta = db.getProject(project);
  if (!projectMeta) return { ...projectNotIndexed(project) };

  // Count before deletion
  const nodeCount = (db.db
    .prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?')
    .get(project) as { cnt: number }).cnt;

  const edgeCount = (db.db
    .prepare('SELECT COUNT(*) as cnt FROM edges WHERE project = ?')
    .get(project) as { cnt: number }).cnt;

  db.deleteProject(project);

  return {
    deleted: project,
    nodes_removed: nodeCount,
    edges_removed: edgeCount,
    message: `Project "${project}" deleted (${nodeCount} nodes, ${edgeCount} edges).`,
  };
}
