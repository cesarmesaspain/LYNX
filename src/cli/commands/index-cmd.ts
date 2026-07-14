import * as path from 'node:path';
import * as fs from 'node:fs';
import { LynxDatabase } from '../../store/database.js';
import { runPipeline } from '../../pipeline/orchestrator.js';
import { resolveProjectPath } from '../../discovery/project-scanner.js';
import { cleanupNativeExtractor } from '../../paths.js';
import { resolveProjectReference } from '../../mcp/project-resolution.js';

export async function cmdIndex(args: string[]): Promise<void> {
  const firstArg = args[0];
  const resolved = resolveProjectPath(firstArg);

  let repoPath: string;
  let projectName: string;

  if (resolved && fs.existsSync(path.resolve(resolved.rootPath))) {
    // Path exists on disk: use it directly.
    repoPath = path.resolve(resolved.rootPath);
    projectName = resolved.name;
  } else if (firstArg && !firstArg.startsWith('--')) {
    // Arg is NOT a real directory — try DB lookup by project name.
    const candidateName = path.basename(firstArg);
    let db: LynxDatabase | null = null;
    let meta: { name: string; rootPath: string } | null = null;
    try {
      db = LynxDatabase.openProject(candidateName);
      meta = db.getProject(candidateName);
    } catch { /* DB may not exist yet */ }

    if (meta && meta.rootPath) {
      projectName = meta.name;
      repoPath = meta.rootPath;
      db?.close();
    } else {
      db?.close();
      console.error(
        `"${firstArg}" is not a valid directory and no indexed project matches that name.\n` +
        'Usage: lynx index <path>         — index a directory\n' +
        '       lynx index <project-name>  — re-index a previously catalogued project\n' +
        '       lynx index                 — auto-detect from current directory'
      );
      process.exit(1);
    }
  } else if (!resolved) {
    console.error('No project detected in current directory. Run: lynx index /path/to/project');
    process.exit(1);
  } else {
    repoPath = path.resolve(resolved.rootPath);
    projectName = resolved.name;
  }

  const nameIdx = args.indexOf('--name');
  if (nameIdx !== -1) projectName = args[nameIdx + 1];

  const existingForRoot = resolveProjectReference(repoPath);
  if (existingForRoot.resolved) {
    if (nameIdx !== -1 && projectName !== existingForRoot.project) {
      console.error(`"${repoPath}" is already indexed as "${existingForRoot.project}". Use that canonical name or delete it before renaming.`);
      process.exit(1);
    }
    projectName = existingForRoot.project;
  } else {
    const existingForName = resolveProjectReference(projectName);
    if (existingForName.resolved) projectName = existingForName.project;
  }

  const modeIdx = args.indexOf('--mode');
  const mode = (modeIdx !== -1 ? args[modeIdx + 1] : 'moderate') as 'full' | 'moderate' | 'fast';
  const llmEnrichment = args.includes('--llm');
  const incremental = args.includes('--incremental');

  console.log(`Indexing ${repoPath} as "${projectName}" (mode: ${mode}${incremental ? ', incremental' : ''})...`);

  const db = LynxDatabase.openProject(projectName);
  const { status, architecture } = await runPipeline(db, repoPath, projectName, { mode, incremental, llmEnrichment });

  console.log(`Done. ${status.totalNodes} nodes, ${status.totalEdges} edges.`);
  console.log(`Hotspots: ${architecture.hotspots.length}, Clusters: ${architecture.clusters.length}`);

  db.close();
  cleanupNativeExtractor();
}
