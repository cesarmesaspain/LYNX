import * as path from 'node:path';
import * as fs from 'node:fs';
import { LynxDatabase } from '../../store/database.js';
import { runPipeline } from '../../pipeline/orchestrator.js';
import { resolveProjectPath } from '../../discovery/project-scanner.js';
import { cleanupNativeExtractor } from '../../paths.js';
import { resolveProjectReference } from '../../mcp/project-resolution.js';
import { acquireProjectLock, forceAcquireProjectLock, releaseProjectLock } from '../../store/lock.js';

const INDEX_USAGE = `Usage: lynx index [path|project-name] [options]

Options:
  --name <name>       Set the project name
  --mode <mode>       full, moderate, or fast (default: moderate)
  --incremental       Skip files whose content hash is unchanged
  --llm               Enable optional LLM enrichment
  --force-lock        Replace a stale index lock
  --result-file <p>   Write the structured result as JSON
  -h, --help          Show this help`;

export async function cmdIndex(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(INDEX_USAGE);
    return;
  }
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
  const forceLock = args.includes('--force-lock');
  const resultFileIdx = args.indexOf('--result-file');
  const resultFile = resultFileIdx !== -1 ? args[resultFileIdx + 1] : undefined;

  console.log(`Indexing ${repoPath} as "${projectName}" (mode: ${mode}${incremental ? ', incremental' : ''})...`);

  const lock = forceLock
    ? forceAcquireProjectLock(projectName)
    : acquireProjectLock(projectName);
  if (!lock.acquired) {
    console.error(lock.reason || `Project ${projectName} is already being indexed.`);
    process.exitCode = 1;
    return;
  }

  const db = LynxDatabase.openProject(projectName);
  db.setProjectStatus(projectName, 'updating');
  try {
    const result = await runPipeline(
      db, repoPath, projectName, { mode, incremental, llmEnrichment },
    );
    const { status, architecture, filesProcessed, phaseTimingsMs } = result;

    db.setProjectStatus(projectName, 'ready');

    if (resultFile) {
      const resolvedResultFile = path.resolve(resultFile);
      fs.mkdirSync(path.dirname(resolvedResultFile), { recursive: true });
      const temporary = `${resolvedResultFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(result)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, resolvedResultFile);
    }

    console.log(`Done. ${status.totalNodes} nodes, ${status.totalEdges} edges.`);
    console.log(
      filesProcessed === 0 && incremental
        ? `Hotspots: ${architecture.hotspots.length}, graph unchanged.`
        : `Hotspots: ${architecture.hotspots.length}, Clusters: ${architecture.clusters.length}`,
    );
    console.log(`Phases: ${JSON.stringify(phaseTimingsMs)}`);
    if (result.persistBreakdown) {
      console.log(`Persist breakdown: ${JSON.stringify(result.persistBreakdown)}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.setProjectStatus(projectName, 'failed', message.slice(0, 500));
    throw error;
  } finally {
    db.close();
    releaseProjectLock(projectName);
    cleanupNativeExtractor();
  }
}
