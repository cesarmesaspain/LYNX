/*
 * delete_project.ts — Remove a project and all its data.
 */

import { getDb } from '../server.js';

export async function handleDeleteProject(
  args: Record<string, unknown>
): Promise<unknown> {
  const project = String(args.project || '');

  if (!project) return { error: 'project is required' };

  const db = getDb(project);

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
