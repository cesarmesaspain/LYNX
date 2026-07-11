import { LynxDatabase } from '../../store/database.js';

export function cmdStatus(args: string[]): void {
  const project = args[0];
  if (!project) {
    console.error('Usage: lynx status <project_name>');
    process.exit(1);
  }

  const db = LynxDatabase.openProject(project);
  const nodeCount = db.db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?').get(project) as { cnt: number };
  const edgeCount = db.db.prepare('SELECT COUNT(*) as cnt FROM edges WHERE project = ?').get(project) as { cnt: number };

  console.log(`Project: ${project}`);
  console.log(`Nodes: ${nodeCount.cnt}, Edges: ${edgeCount.cnt}`);
  db.close();
}
