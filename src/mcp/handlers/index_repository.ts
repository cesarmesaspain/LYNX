import * as path from 'node:path';
import { getDb } from '../server.js';
import { runPipeline } from '../../pipeline/orchestrator.js';
import { acquireProjectLock, releaseProjectLock } from '../../store/lock.js';
import { projectLocked } from '../diagnostics.js';
import { resolveProjectReference } from '../project-resolution.js';

export async function handleIndexRepository(
  args: Record<string, unknown>
): Promise<unknown> {
  const repoPath = String(args.repo_path || '');
  const mode = (args.mode as string) || 'full';
  const name = args.name ? String(args.name) : undefined;
  const forceLock = args.force_lock === true; // emergency override for stuck locks

  if (!repoPath) {
    return { error: 'repo_path is required' };
  }

  const resolvedPath = path.resolve(repoPath);
  const existingForRoot = resolveProjectReference(resolvedPath);
  const requestedName = name?.trim();
  const nameResolution = requestedName ? resolveProjectReference(requestedName) : undefined;
  if (requestedName && existingForRoot.resolved && requestedName !== existingForRoot.project &&
    (!nameResolution?.resolved || nameResolution.project !== existingForRoot.project)) {
    return {
      error: 'PROJECT_IDENTITY_CONFLICT',
      message: `"${resolvedPath}" is already indexed as "${existingForRoot.project}".`,
      project: existingForRoot.project,
      hint: 'Use the existing canonical project name, or delete that project before assigning a different name.',
    };
  }
  const projectName = existingForRoot.resolved
    ? existingForRoot.project
    : nameResolution?.resolved
      ? nameResolution.project
      : requestedName || path.basename(resolvedPath);

  // Initialize DB for this project if not cached
  const db = getDb(projectName, { createPersistent: true });

  // ── Lock acquisition ──────────────────────────────────────
  if (!forceLock) {
    const lockResult = acquireProjectLock(projectName);
    if (!lockResult.acquired) {
      return {
        error: 'INDEX_LOCKED',
        message: lockResult.reason,
        project: projectName,
        hint: 'Use force_lock=true to override a stale lock',
      };
    }
  }

  db.setProjectStatus(projectName, 'updating');

  const startTime = Date.now();

  const incremental = args.incremental !== false;

  let result: Awaited<ReturnType<typeof runPipeline>>;
  try {
    result = await runPipeline(
      db,
      resolvedPath,
      projectName,
      {
        mode: mode as 'full' | 'moderate' | 'fast', incremental,
        testSkipProjectBrief: process.env.VITEST === 'true' && args.__test_skip_project_brief === true,
        testFailAt: process.env.VITEST === 'true' ? args.__test_fail_at as never : undefined,
      }
    );
    db.setProjectStatus(projectName, 'ready');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    db.setProjectStatus(projectName, 'failed', errMsg.slice(0, 500));
    releaseProjectLock(projectName);
    throw err;
  }

  releaseProjectLock(projectName);

  const elapsed = Date.now() - startTime;
  const { status, filesProcessed, filesSkipped, incremental: update } = result;

  return {
    project: projectName,
    root_path: resolvedPath,
    mode,
    project_status: 'ready',
    incremental_requested: incremental,
    update_mode: update.updateMode,
    files_inspected: update.filesInspected,
    files_added: update.added,
    files_modified: update.modified,
    files_deleted: update.deleted,
    files_renamed: update.renamed,
    files_reindexed: update.reindexed,
    fallback_reason: update.fallbackReason,
    nodes_added: update.nodesAdded,
    nodes_removed: update.nodesRemoved,
    edges_added: update.edgesAdded,
    edges_removed: update.edgesRemoved,
    health: update.health,
    nodes_indexed: status.totalNodes,
    edges_created: status.totalEdges,
    files_processed: filesProcessed,
    files_skipped: filesSkipped,
    duration_ms: elapsed,
    duration_human: `${(elapsed / 1000).toFixed(2)}s`,
    coverage: result.coverage,
  };
}
