import * as path from 'node:path';
import { LynxDatabase } from '../../store/database.js';
import { runPipeline } from '../../pipeline/orchestrator.js';
import { findNearestProject } from '../../discovery/project-scanner.js';
import { cleanupNativeExtractor } from '../../paths.js';

export async function cmdIndex(args: string[]): Promise<void> {
  let repoPath: string;
  let projectName: string;

  if (!args[0] || args[0].startsWith('--')) {
    const detected = findNearestProject(process.cwd());
    if (!detected) {
      console.error('No project detected in current directory. Run: lynx index /path/to/project');
      process.exit(1);
    }
    repoPath = detected.rootPath;
    projectName = detected.name;
    console.log(`Auto-detected: ${detected.language} project "${projectName}" at ${repoPath}`);
    if (detected.frameworks.length > 0) console.log(`  Frameworks: ${detected.frameworks.join(', ')}`);
  } else {
    repoPath = args[0];
    const nameIdx = args.indexOf('--name');
    projectName = nameIdx !== -1 ? args[nameIdx + 1] : path.basename(path.resolve(repoPath));
  }

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
