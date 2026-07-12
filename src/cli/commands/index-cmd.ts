import * as path from 'node:path';
import { LynxDatabase } from '../../store/database.js';
import { runPipeline } from '../../pipeline/orchestrator.js';
import { resolveProjectPath } from '../../discovery/project-scanner.js';
import { cleanupNativeExtractor } from '../../paths.js';

export async function cmdIndex(args: string[]): Promise<void> {
  const resolved = resolveProjectPath(args[0]);
  if (!resolved) {
    console.error('No project detected in current directory. Run: lynx index /path/to/project');
    process.exit(1);
  }

  const repoPath = resolved.rootPath;
  let projectName = resolved.name;

  const nameIdx = args.indexOf('--name');
  if (nameIdx !== -1) projectName = args[nameIdx + 1];

  const modeIdx = args.indexOf('--mode');
  const mode = (modeIdx !== -1 ? args[modeIdx + 1] : 'moderate') as 'full' | 'moderate' | 'fast';
  const llmEnrichment = args.includes('--llm');

  console.log(`Indexing ${repoPath} as "${projectName}" (mode: ${mode})...`);

  const db = LynxDatabase.openProject(projectName);
  const { status, architecture } = await runPipeline(db, repoPath, projectName, { mode, llmEnrichment });

  console.log(`Done. ${status.totalNodes} nodes, ${status.totalEdges} edges.`);
  console.log(`Hotspots: ${architecture.hotspots.length}, Clusters: ${architecture.clusters.length}`);

  db.close();
  cleanupNativeExtractor();
}
