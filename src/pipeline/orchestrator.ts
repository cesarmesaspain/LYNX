/*
 * orchestrator.ts — 4-phase indexing pipeline.
 *
 * Orchestrates the full indexing flow:
 *   1. Discover files
 *   2. Extract definitions, calls, imports (with SHA256 skip in incremental mode)
 *   3. Resolve edges (CALLS, IMPORTS, USAGE, DEFINES)
 *   4. Analyze (hotspots, clustering, file tree)
 *
 * Single entry point: runPipeline()
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { LynxDatabase } from '../store/database.js';
import { upsertNode, upsertNodesBatch, deleteNodesByFile, deleteNodesByProject } from '../store/nodes.js';
import { deleteEdgesByProject, deleteEdgesForNodesInFile } from '../store/edges.js';
import { getAllFileHashes, upsertFileHash, insertIndexRun, deleteFileHash, deleteFindingsByFile, getCachedLlmSummary, upsertCachedLlmSummary } from '../store/memory.js';
import { discoverFiles } from './phases/discover.js';
import { extractAll, fileToModuleQn } from './phases/extract.js';
import { resolveAll } from './phases/resolve/index.js';
import { analyze } from './phases/analyze.js';
import { computeCyclomaticComplexities, computeTransitiveLoopDepths } from '../intelligence/complexity.js';
import { explainArchitecture } from '../intelligence/narrative.js';
import type { LynxIndexMode, LynxIndexStatus, LynxArchitecture } from '../types.js';
import type { ResolutionStats } from './phases/resolve/index.js';
import type { Narrative } from '../intelligence/narrative.js';
import { getGitContext } from '../git/context.js';
import { enrichFile } from '../llm/client.js';
import { createHash } from 'node:crypto';
import { ensureProjectBrief } from '../intelligence/project-brief.js';
import { getTier } from '../commercial/license.js';
import { maxFilesForTier } from '../commercial/tiers.js';

export interface PipelineOptions {
  mode?: LynxIndexMode;
  incremental?: boolean;
  /** Test-only fault injection. Never enabled by MCP or normal CLI calls. */
  testFailAt?: 'cleanup' | 'nodes' | 'edges' | 'hashes' | 'run';
  /** Test-only: skip optional post-commit brief generation. */
  testSkipProjectBrief?: boolean;
  llmEnrichment?: boolean;
}

export interface IncrementalUpdateMetrics {
  updateMode: 'full' | 'incremental' | 'full_fallback';
  filesInspected: number;
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  reindexed: string[];
  fallbackReason: string | null;
  nodesAdded: number;
  nodesRemoved: number;
  edgesAdded: number;
  edgesRemoved: number;
  durationMs: number;
  health: 'healthy' | 'failed';
}

export interface PipelineResult {
  status: LynxIndexStatus;
  architecture: LynxArchitecture;
  narrative: Narrative;
  filesProcessed: number;
  filesSkipped: number;
  llmSummaryCache: {
    hits: number;
    misses: number;
    contextTokensAvoided: number;
  };
  incremental: IncrementalUpdateMetrics;
  coverage: {
    files_discovered: number;
    files_processed: number;
    files_skipped: number;
    files_with_nodes: number;
    excluded_directories: string[];
    functions_extracted: number;
    calls_extracted: number;
    calls_resolved: number;
    calls_unresolved: number;
    call_resolution_rate: number;
  };
}

/**
 * Run the complete indexing pipeline against a repository.
 */
export async function runPipeline(
  db: LynxDatabase,
  repoPath: string,
  project: string,
  opts: PipelineOptions = {}
): Promise<PipelineResult> {
  const startedAt = Date.now();
  const beforeNodes = (db.db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE project = ?').get(project) as { count: number }).count;
  const beforeEdges = (db.db.prepare('SELECT COUNT(*) AS count FROM edges WHERE project = ?').get(project) as { count: number }).count;
  const mode = opts.mode || 'moderate';
  // Incremental indexing is the normal path. Deletions and renames still
  // trigger the explicit full fallback below, where relationship resolution
  // cannot be safely limited to the changed files.
  const requestedIncremental = opts.incremental === true;
  const llmEnrichment = opts.llmEnrichment === true || process.env.LYNX_INDEX_LLM === '1';
  const llmSummaryCache = { hits: 0, misses: 0, contextTokensAvoided: 0 };

  // Save project metadata
  db.upsertProject(project, repoPath);

  // Phase 1: Discover files (cap for free tier)
  const discovery = discoverFiles(repoPath, mode);
  const maxFiles = maxFilesForTier(getTier());
  if (discovery.files.length > maxFiles) {
    discovery.files = discovery.files.slice(0, maxFiles);
  }

  // Load file hash cache for incremental mode
  const fileHashMap = requestedIncremental ? getAllFileHashes(db, project) : undefined;
  const presentPaths = new Set(discovery.files.map((file) => file.relPath));
  const deleted = fileHashMap ? [...fileHashMap.keys()].filter((file) => !presentPaths.has(file)).sort() : [];
  const added = fileHashMap ? discovery.files.filter((file) => !fileHashMap.has(file.relPath)).map((file) => file.relPath).sort() : [];
  const renamed: Array<{ from: string; to: string }> = [];
  if (fileHashMap && deleted.length > 0 && added.length > 0) {
    for (const from of deleted) {
      const hash = fileHashMap.get(from);
      const to = discovery.files.find((file) => added.includes(file.relPath) && hash === hashFile(file.absPath));
      if (to && hash) {
        renamed.push({ from, to: to.relPath });
        // Seed the cache before extraction so the unchanged renamed file is
        // skipped. Persistent paths are updated later inside the graph transaction.
        fileHashMap.set(to.relPath, hash);
      }
    }
  }
  // Renames with matching content hash: update paths in-place, no re-extraction.
  // True deletions (path gone, no matching hash) still require full fallback.
  const trueDeletions = renamed.length > 0
    ? deleted.filter(d => !renamed.some(r => r.from === d))
    : deleted;
  let fallbackReason: string | null = trueDeletions.length > 0 ? 'deleted_or_renamed_file_requires_full_relationship_resolution' : null;
  const incremental = requestedIncremental && fallbackReason === null;

  // Phase 2: Extract — skip unchanged files in incremental mode
  const batches = await extractAll(discovery.files, project, incremental ? fileHashMap : undefined);
  const modified = batches.filter((batch) => !batch.skipped && fileHashMap?.has(batch.file.relPath)).map((batch) => batch.file.relPath).sort();

  if (llmEnrichment) {
    // Optional Phase 2.5: enrich with LLM/heuristics.
    // Disabled by default to keep pure indexing fast.
    for (const batch of batches) {
      if (batch.skipped || batch.result.hasError) continue;
      try {
        const source = fs.readFileSync(batch.file.absPath, 'utf-8');
        const hash = batch.sha256 || createHash('sha256').update(source).digest('hex');
        const cachedSummary = getCachedLlmSummary(db, project, hash);
        if (cachedSummary) {
          llmSummaryCache.hits++;
          llmSummaryCache.contextTokensAvoided += Math.max(0, cachedSummary.sourceTokensEst - cachedSummary.summaryTokensEst);
        } else {
          llmSummaryCache.misses++;
        }
        const { metadata } = await enrichFile(
          source,
          hash,
          batch.file.relPath,
          batch.result.language,
          batch.result.nodes,
          cachedSummary ? { cachedSummary: cachedSummary.summary } : undefined,
        );
        if (!cachedSummary && metadata.summary) {
          upsertCachedLlmSummary(
            db, project, hash, metadata.summary,
            estimateTokens(source), estimateTokens(metadata.summary),
          );
        }
        batch.result.llmMetadata = metadata;

        for (const node of batch.result.nodes) {
          if (metadata.suggestedTestFile) node.isTest = true;
          if (metadata.suggestedEntryPoint) node.isEntryPoint = true;
          if (metadata.summary) node.llmSummary = metadata.summary;
        }
        if (metadata.suggestedTestFile) {
          batch.result.isTestFile = true;
        }
      } catch {
        // LLM enrichment is best-effort — never block indexing
      }
    }
  }

  // Track changed files for cleanup in incremental mode
  const changedFiles: string[] = [];
  let stats!: ResolutionStats;
  let architecture!: LynxArchitecture;
  let hotspotCount = 0;
  let filesProcessed = 0;
  let filesSkipped = 0;
  // Everything below is persistent graph state. Nested helper transactions use
  // SQLite savepoints, so this outer transaction is the only commit boundary.
  db.beginBulk();
  try {
    db.transaction(() => {

  // A non-incremental run is a full rebuild. Clear previous graph rows so
  // repeated `lynx index --mode fast` stays idempotent.
  if (!incremental) {
    db.transaction(() => {
      deleteEdgesByProject(db, project);
      deleteNodesByProject(db, project);
      db.db.prepare('DELETE FROM file_hashes WHERE project = ?').run(project);
    });
  }
  failIfRequested(opts, 'cleanup');

  // Renamed files with matching content hash: update paths in-place without
  // re-extraction. Nodes and edges are preserved (they reference node.id, not
  // file_path). Only file_path, qualified_name, and file_hashes are updated.
  if (renamed.length > 0 && fileHashMap) {
    db.transaction(() => {
      for (const { from, to } of renamed) {
        const oldModuleQn = fileToModuleQn(from);
        const newModuleQn = fileToModuleQn(to);
        db.db
          .prepare(
            `UPDATE nodes SET file_path = ?, qualified_name = REPLACE(qualified_name, ?, ?)
             WHERE project = ? AND file_path = ?`
          )
          .run(to, oldModuleQn, newModuleQn, project, from);
        const hash = fileHashMap.get(from)!;
        deleteFileHash(db, project, from);
        const newFile = discovery.files.find(f => f.relPath === to)!;
        upsertFileHash(db, project, to, hash, 0, newFile.size);
        // Feed the new path into fileHashMap so extractAll skips it — the
        // content hasn't changed and the nodes are already updated.
        fileHashMap.set(to, hash);
      }
    });
  }

  // Removed paths must never survive a successful update. This is intentionally
  // performed before extraction results are written; full fallback then rebuilds
  // the entire graph from the same semantic reference pipeline.
  if (trueDeletions.length > 0) {
    db.transaction(() => {
      for (const file of trueDeletions) {
        deleteEdgesForNodesInFile(db, project, file);
        deleteNodesByFile(db, project, file);
        deleteFindingsByFile(db, project, file);
        deleteFileHash(db, project, file);
      }
    });
  }

  // Delete old nodes/edges for files whose hash changed (incremental only)
  if (incremental) {
    db.transaction(() => {
      for (const batch of batches) {
        if (batch.skipped) continue;
        changedFiles.push(batch.file.relPath);
        deleteEdgesForNodesInFile(db, project, batch.file.relPath);
        deleteNodesByFile(db, project, batch.file.relPath);
      }
    });
  }

  // Insert/update nodes and resolve relationships inside the same commit unit.
  const nodesToUpsert = [];
  for (const batch of batches) {
    if (batch.skipped || batch.result.hasError) continue;
    nodesToUpsert.push(...batch.result.nodes);
  }
  if (nodesToUpsert.length > 1) upsertNodesBatch(db, nodesToUpsert);
  else if (nodesToUpsert.length === 1) upsertNode(db, nodesToUpsert[0]);
  failIfRequested(opts, 'nodes');

  const resolveBatches = incremental ? batches.filter((b) => !b.skipped) : batches;
  stats = resolveAll(db, resolveBatches, project);
  failIfRequested(opts, 'edges');

  // Files processed/skipped counts
  filesProcessed = batches.filter((b) => !b.skipped).length;
  filesSkipped = batches.filter((b) => b.skipped).length;

  // Post-resolution: compute cyclomatic complexity and transitive loop depths
  if (!incremental || filesProcessed > 0) {
    computeCyclomaticComplexities(db, project, repoPath);
    computeTransitiveLoopDepths(db, project);
  }

  // Phase 4: Analyze (hotspots, clusters, file tree)
  ({ architecture, hotspotCount } = analyze(db, project));

  // Upsert file hashes and filesystem metadata for every discovered batch.
  // This keeps the deterministic drift check accurate even when extraction
  // is skipped because the content hash has not changed.
  db.transaction(() => {
    for (const batch of batches) {
      if (!batch.sha256) continue;
      let mtimeNs = 0;
      let sha256 = batch.sha256;
      let size = batch.file.size;
      try {
        const stat = fs.statSync(batch.file.absPath);
        mtimeNs = Math.floor(stat.mtimeMs * 1_000_000);
        size = stat.size;
        if (!batch.skipped) {
          const source = fs.readFileSync(batch.file.absPath, 'utf-8');
          sha256 = createHash('sha256').update(source).digest('hex');
        }
      } catch { /* keep discovered metadata */ }
      upsertFileHash(db, project, batch.file.relPath, sha256, mtimeNs, size);
    }
  });
  failIfRequested(opts, 'hashes');
  const provisionalAvgComplexity = architecture.hotspots.length > 0
    ? architecture.hotspots.reduce((sum, h) => sum + h.complexity, 0) / architecture.hotspots.length
    : 0;
  insertIndexRun(db, {
    project, totalNodes: architecture.totalNodes, totalEdges: architecture.totalEdges,
    hotspotCount, avgComplexity: provisionalAvgComplexity, filesProcessed, filesSkipped, mode,
  });
  failIfRequested(opts, 'run');
    });
  } finally {
    db.endBulk();
  }

  // Compute avg complexity
  const avgComplexity =
    architecture.hotspots.length > 0
      ? architecture.hotspots.reduce((sum, h) => sum + h.complexity, 0) /
        architecture.hotspots.length
      : 0;

  // Git context
  const gitCtx = getGitContext(repoPath, { refresh: true });

  // Build status
  const status: LynxIndexStatus = {
    project,
    totalNodes: architecture.totalNodes,
    totalEdges: architecture.totalEdges,
    status: architecture.totalNodes > 0 ? 'ready' : 'empty',
    rootPath: repoPath,
    git: gitCtx
      ? { branch: gitCtx.branch, headSha: gitCtx.headSha, isGit: true }
      : null,
  };

  // Generate narrative
  const godComponents = architecture.hotspots.filter((h) => h.complexity > 1000);
  const narrative = explainArchitecture(
    architecture.totalNodes,
    architecture.totalEdges,
    architecture.hotspots.length,
    godComponents.length,
    avgComplexity
  );

  // Generate/update the cached architecture brief outside the hot path.
  // Best-effort: indexing must remain reliable even if external intelligence is unavailable.
  try {
    if (!opts.testSkipProjectBrief) await ensureProjectBrief(db, project);
  } catch {
    // Keep indexing pure and non-blocking from the user's perspective.
  }

  // Checkpoint
  db.checkpoint();

  const functionsExtracted = db.db.prepare(
    `SELECT COUNT(*) AS count FROM nodes WHERE project = ? AND kind IN ('Function', 'Method')`,
  ).get(project) as { count: number };
  const filesWithNodes = db.db.prepare(
    `SELECT COUNT(DISTINCT file_path) AS count FROM nodes WHERE project = ? AND file_path != ''`,
  ).get(project) as { count: number };
  db.setProjectIndexedCommit(project, gitCtx?.headSha ?? null);

  return {
    status, architecture, narrative, filesProcessed, filesSkipped, llmSummaryCache,
    coverage: {
      files_discovered: discovery.files.length,
      files_processed: filesProcessed,
      files_skipped: filesSkipped,
      files_with_nodes: filesWithNodes.count,
      excluded_directories: discovery.excludedDirs.slice(0, 100),
      functions_extracted: functionsExtracted.count,
      calls_extracted: stats.totalCalls,
      calls_resolved: Math.max(0, stats.totalCalls - stats.unresolvedCalls),
      calls_unresolved: stats.unresolvedCalls,
      call_resolution_rate: stats.totalCalls === 0 ? 1 : Number(((stats.totalCalls - stats.unresolvedCalls) / stats.totalCalls).toFixed(4)),
    },
    incremental: {
      updateMode: incremental ? 'incremental' : (requestedIncremental ? 'full_fallback' : 'full'),
      filesInspected: discovery.files.length,
      added,
      modified,
      deleted,
      renamed,
      reindexed: batches.filter((batch) => !batch.skipped).map((batch) => batch.file.relPath).sort(),
      fallbackReason,
      nodesAdded: Math.max(0, architecture.totalNodes - beforeNodes),
      nodesRemoved: Math.max(0, beforeNodes - architecture.totalNodes),
      edgesAdded: Math.max(0, architecture.totalEdges - beforeEdges),
      edgesRemoved: Math.max(0, beforeEdges - architecture.totalEdges),
      durationMs: Date.now() - startedAt,
      health: 'healthy',
    },
  };
}

function hashFile(filePath: string): string | null {
  try { return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); } catch { return null; }
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function failIfRequested(opts: PipelineOptions, stage: NonNullable<PipelineOptions['testFailAt']>): void {
  if (opts.testFailAt === stage) throw new Error(`LYNX_TEST_PIPELINE_FAILURE:${stage}`);
}
