import * as path from 'node:path';
import { LynxDatabase } from '../../store/database.js';
import { runPipeline } from '../../pipeline/orchestrator.js';
import { FileWatcher } from '../../watcher/file-watcher.js';
import { findNearestProject } from '../../discovery/project-scanner.js';
import { cleanupNativeExtractor } from '../../paths.js';

export async function cmdWatch(args: string[]): Promise<void> {
  let repoPath: string;
  let projectName: string;

  if (!args[0] || args[0].startsWith('--')) {
    const detected = findNearestProject(process.cwd());
    if (!detected) {
      console.error('No project detected. Run: lynx watch /path/to/project');
      process.exit(1);
    }
    repoPath = detected.rootPath;
    projectName = detected.name;
    console.log(`Auto-detected: ${detected.language} project "${projectName}" at ${repoPath}`);
  } else {
    repoPath = args[0];
    const nameIdx = args.indexOf('--name');
    projectName = nameIdx !== -1 ? args[nameIdx + 1] : path.basename(path.resolve(repoPath));
  }

  const modeIdx = args.indexOf('--mode');
  const mode = (modeIdx !== -1 ? args[modeIdx + 1] : 'fast') as 'full' | 'moderate' | 'fast';
  const llmEnrichment = args.includes('--llm');

  const resolvedPath = path.resolve(repoPath);
  const db = LynxDatabase.openProject(projectName);

  console.log(`[lynx-watch] Initial index of ${resolvedPath} as "${projectName}" (mode: ${mode})...`);
  const { status } = await runPipeline(db, resolvedPath, projectName, { mode, incremental: false, llmEnrichment });
  console.log(`[lynx-watch] Indexed: ${status.totalNodes} nodes, ${status.totalEdges} edges.`);

  const watcher = new FileWatcher(db, resolvedPath, projectName, mode);
  watcher.start();

  console.log(`[lynx-watch] Watching for changes. Press Ctrl+C to stop.`);

  const shutdown = async () => {
    console.log('\n[lynx-watch] Shutting down...');
    await watcher.stop();
    db.close();
    cleanupNativeExtractor();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  setInterval(() => {}, 60_000).unref();
}
