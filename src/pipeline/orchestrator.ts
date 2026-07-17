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

import * as path from "node:path";
import * as fs from "node:fs";
import type { LynxDatabase } from "../store/database.js";
import {
  upsertNode,
  upsertNodesBatch,
  deleteNodesByFile,
  deleteNodesByProject,
} from "../store/nodes.js";
import {
  deleteEdgesByProject,
  deleteEdgesForNodesInFile,
  insertEdgesBatch,
} from "../store/edges.js";
import { findNodeIdsByQns } from "../store/nodes.js";
import type { LynxEdge } from "../types.js";
import {
  getAllFileHashes,
  countFilesWithGraphNodes,
  upsertFileHash,
  insertIndexRun,
  getLastIndexCoverage,
  countFileCallCoverage,
  deleteFileCallCoverage,
  getProjectCallCoverage,
  upsertFileCallCoverage,
  deleteFileHash,
  deleteFindingsByFile,
  getCachedLlmSummary,
  upsertCachedLlmSummary,
} from "../store/memory.js";
import { discoverFiles } from "./phases/discover.js";
import { extractAll, fileToModuleQn } from "./phases/extract.js";
import { resolveAll } from "./phases/resolve/index.js";
import { analyze } from "./phases/analyze.js";
import {
  computeCyclomaticComplexities,
  computeTransitiveLoopDepths,
} from "../intelligence/complexity.js";
import { explainArchitecture } from "../intelligence/narrative.js";
import type {
  LynxIndexMode,
  LynxIndexStatus,
  LynxArchitecture,
} from "../types.js";
import type { ResolutionStats } from "./phases/resolve/index.js";
import type { Narrative } from "../intelligence/narrative.js";
import { getGitContext, isGitWorkingTreeDirty } from "../git/context.js";
import { enrichFile } from "../llm/client.js";
import { createHash } from "node:crypto";
import { ensureProjectBrief } from "../intelligence/project-brief.js";
import { getTier } from "../commercial/license.js";
import { maxFilesForTier } from "../commercial/tiers.js";
import { projectLegacyGraphToSacg } from "../sacg/legacy-projection.js";
import { persistSacgSnapshot } from "../store/sacg-persistence.js";
import { shouldUseBulkEvidencePersistence } from "./sacg-persistence-policy.js";

export interface PipelineOptions {
  mode?: LynxIndexMode;
  incremental?: boolean;
  /** Test-only fault injection. Never enabled by MCP or normal CLI calls. */
  testFailAt?: "cleanup" | "nodes" | "edges" | "hashes" | "run";
  /** Test-only: skip optional post-commit brief generation. */
  testSkipProjectBrief?: boolean;
  llmEnrichment?: boolean;
}

export interface IncrementalUpdateMetrics {
  updateMode: "full" | "incremental" | "full_fallback";
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
  health: "healthy" | "failed";
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
  phaseTimingsMs: {
    discover: number;
    extract: number;
    resolve: number;
    complexity: number;
    analyze: number;
    persist: number;
    total: number;
  };
  persistBreakdown?: Record<string, number>;
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
    unresolved_call_reasons: Record<string, number>;
    call_resolution_rate: number;
    partial_files: Array<{ file: string; reasons: string[] }>;
  };
}

type ExtractionBatch = Awaited<ReturnType<typeof extractAll>>[number];

function persistDiscoveredFileMetadata(
  db: LynxDatabase,
  project: string,
  batches: ExtractionBatch[],
): void {
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
        const source = fs.readFileSync(batch.file.absPath, "utf-8");
        sha256 = createHash("sha256").update(source).digest("hex");
      }
    } catch {
      /* keep discovered metadata */
    }
    upsertFileHash(db, project, batch.file.relPath, sha256, mtimeNs, size);
  }
}

/**
 * Run the complete indexing pipeline against a repository.
 */
export async function runPipeline(
  db: LynxDatabase,
  repoPath: string,
  project: string,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const startedAt = Date.now();
  const phaseTimingsMs = {
    discover: 0,
    extract: 0,
    resolve: 0,
    complexity: 0,
    analyze: 0,
    persist: 0,
    total: 0,
  };
  const beforeNodes = (
    db.db
      .prepare("SELECT COUNT(*) AS count FROM nodes WHERE project = ?")
      .get(project) as { count: number }
  ).count;
  const beforeEdges = (
    db.db
      .prepare("SELECT COUNT(*) AS count FROM edges WHERE project = ?")
      .get(project) as { count: number }
  ).count;
  const mode = opts.mode || "moderate";
  // Incremental indexing is the normal path. Deletions and renames still
  // trigger the explicit full fallback below, where relationship resolution
  // cannot be safely limited to the changed files.
  const requestedIncremental = opts.incremental === true;
  const llmEnrichment =
    opts.llmEnrichment === true || process.env.LYNX_INDEX_LLM === "1";
  const llmSummaryCache = { hits: 0, misses: 0, contextTokensAvoided: 0 };

  // Save project metadata
  db.upsertProject(project, repoPath);

  // Phase 1: Discover files (cap for free tier)
  let phaseStartedAt = Date.now();
  const discovery = discoverFiles(repoPath, mode);
  phaseTimingsMs.discover = Date.now() - phaseStartedAt;
  const maxFiles = maxFilesForTier(getTier());
  if (discovery.files.length > maxFiles) {
    discovery.files = discovery.files.slice(0, maxFiles);
  }

  // Load file hash cache for incremental mode
  const fileHashMap = requestedIncremental
    ? getAllFileHashes(db, project)
    : undefined;
  const persistedFileCount = fileHashMap?.size || 0;
  const presentPaths = new Set(discovery.files.map((file) => file.relPath));
  const deleted = fileHashMap
    ? [...fileHashMap.keys()].filter((file) => !presentPaths.has(file)).sort()
    : [];
  const added = fileHashMap
    ? discovery.files
        .filter((file) => !fileHashMap.has(file.relPath))
        .map((file) => file.relPath)
        .sort()
    : [];
  const renamed: Array<{ from: string; to: string }> = [];
  if (fileHashMap && deleted.length > 0 && added.length > 0) {
    for (const from of deleted) {
      const hash = fileHashMap.get(from);
      const to = discovery.files.find(
        (file) =>
          added.includes(file.relPath) && hash === hashFile(file.absPath),
      );
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
  const trueDeletions =
    renamed.length > 0
      ? deleted.filter((d) => !renamed.some((r) => r.from === d))
      : deleted;
  let fallbackReason: string | null =
    trueDeletions.length > 0
      ? "deleted_or_renamed_file_requires_full_relationship_resolution"
      : null;
  const persistedCoverage = getLastIndexCoverage(db, project);
  if (
    requestedIncremental &&
    fallbackReason === null &&
    beforeNodes > 0 &&
    (fileHashMap?.size || 0) > 0 &&
    (!persistedCoverage || countFileCallCoverage(db, project) !== persistedFileCount)
  ) {
    fallbackReason = "missing_persisted_coverage_requires_full_rebuild";
  }
  if (fileHashMap && discovery.files.some((file) =>
    isNativeCoreFile(file.relPath) && fileHashMap.get(file.relPath) !== hashFile(file.absPath))) {
    fallbackReason = "native_c_cpp_change_requires_full_relationship_resolution";
  }
  const incremental = requestedIncremental && fallbackReason === null;

  // Phase 2: Extract — skip unchanged files in incremental mode
  phaseStartedAt = Date.now();
  const batches = await extractAll(
    discovery.files,
    project,
    incremental ? fileHashMap : undefined,
  );
  phaseTimingsMs.extract = Date.now() - phaseStartedAt;
  const modified = batches
    .filter((batch) => !batch.skipped && fileHashMap?.has(batch.file.relPath))
    .map((batch) => batch.file.relPath)
    .sort();

  // True no-op incremental runs must not reload or rewrite graph state. The
  // previous implementation still recomputed communities, complexity and the
  // complete file tree, making an unchanged repository almost as expensive as
  // a rebuild. Read only the lightweight architecture counters needed for the
  // response and leave the committed graph byte-for-byte untouched.
  if (
    incremental &&
    added.length === 0 &&
    modified.length === 0 &&
    deleted.length === 0 &&
    batches.every((batch) => batch.skipped)
  ) {
    const { architecture, hotspotCount } = analyze(db, project, {
      lightweight: true,
    });
    const gitCtx = getGitContext(repoPath, { refresh: true });
    db.transaction(() => {
      persistDiscoveredFileMetadata(db, project, batches);
      db.setProjectIndexedCommit(project, gitCtx?.headSha ?? null);
    });
    const functionsExtracted = db.db
      .prepare(
        `SELECT COUNT(*) AS count FROM nodes WHERE project = ? AND kind IN ('Function', 'Method')`,
      )
      .get(project) as { count: number };
    const filesWithNodes = countFilesWithGraphNodes(db, project);
    const status: LynxIndexStatus = {
      project,
      totalNodes: architecture.totalNodes,
      totalEdges: architecture.totalEdges,
      status: architecture.totalNodes > 0 ? "ready" : "empty",
      rootPath: repoPath,
      git: gitCtx
        ? { branch: gitCtx.branch, headSha: gitCtx.headSha, isGit: true }
        : null,
    };
    const avgComplexity =
      architecture.hotspots.length > 0
        ? architecture.hotspots.reduce((sum, h) => sum + h.complexity, 0) /
          architecture.hotspots.length
        : 0;
    const narrative = explainArchitecture(
      architecture.totalNodes,
      architecture.totalEdges,
      hotspotCount,
      architecture.hotspots.filter((h) => h.complexity > 1000).length,
      avgComplexity,
    );
    return {
      status,
      architecture,
      narrative,
      filesProcessed: 0,
      filesSkipped: batches.length,
      llmSummaryCache,
      phaseTimingsMs: { ...phaseTimingsMs, total: Date.now() - startedAt },
      coverage: {
        files_discovered: discovery.files.length,
        files_processed: 0,
        files_skipped: batches.length,
        files_with_nodes: filesWithNodes,
        excluded_directories: discovery.excludedDirs.slice(0, 100),
        functions_extracted: functionsExtracted.count,
        calls_extracted: persistedCoverage!.callsExtracted,
        calls_resolved: persistedCoverage!.callsResolved,
        calls_unresolved: persistedCoverage!.callsUnresolved,
        unresolved_call_reasons: persistedCoverage!.unresolvedCallReasons,
        call_resolution_rate: persistedCoverage!.callResolutionRate,
        partial_files: persistedCoverage!.partialFiles,
      },
      incremental: {
        updateMode: "incremental",
        filesInspected: discovery.files.length,
        added: [],
        modified: [],
        deleted: [],
        renamed: [],
        reindexed: [],
        fallbackReason: null,
        nodesAdded: 0,
        nodesRemoved: 0,
        edgesAdded: 0,
        edgesRemoved: 0,
        durationMs: Date.now() - startedAt,
        health: "healthy",
      },
    };
  }

  const gitCtx = getGitContext(repoPath, { refresh: true });
  const workingTree = gitCtx ? isGitWorkingTreeDirty(repoPath) : false;

  if (llmEnrichment) {
    // Optional Phase 2.5: enrich with LLM/heuristics.
    // Disabled by default to keep pure indexing fast.
    for (const batch of batches) {
      if (batch.skipped || batch.result.hasError) continue;
      try {
        const source = fs.readFileSync(batch.file.absPath, "utf-8");
        const hash =
          batch.sha256 || createHash("sha256").update(source).digest("hex");
        const cachedSummary = getCachedLlmSummary(db, project, hash);
        if (cachedSummary) {
          llmSummaryCache.hits++;
          llmSummaryCache.contextTokensAvoided += Math.max(
            0,
            cachedSummary.sourceTokensEst - cachedSummary.summaryTokensEst,
          );
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
            db,
            project,
            hash,
            metadata.summary,
            estimateTokens(source),
            estimateTokens(metadata.summary),
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
  let partialFiles: Array<{ file: string; reasons: string[] }> = [];
  let reindexedFiles: string[] = [];
  let aggregateCoverage!: ReturnType<typeof getProjectCallCoverage>;
  // Everything below is persistent graph state. Nested helper transactions use
  // SQLite savepoints, so this outer transaction is the only commit boundary.
  const persistBreakdown: Record<string, number> = {};
  let _t = Date.now();
  const _mark = (label: string) => {
    const now = Date.now();
    persistBreakdown[label] = now - _t;
    _t = now;
  };
  db.beginBulk();
  const persistStartedAt = Date.now();
  _t = persistStartedAt;
  try {
    db.transaction(() => {
      // A non-incremental run is a full rebuild. Clear previous graph rows so
      // repeated `lynx index --mode fast` stays idempotent.
      if (!incremental) {
        db.transaction(() => {
          deleteEdgesByProject(db, project);
          deleteNodesByProject(db, project);
          db.db
            .prepare("DELETE FROM file_hashes WHERE project = ?")
            .run(project);
          deleteFileCallCoverage(db, project);
        });
      }
      _mark("cleanup");
      failIfRequested(opts, "cleanup");

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
             WHERE project = ? AND file_path = ?`,
              )
              .run(to, oldModuleQn, newModuleQn, project, from);
            db.db.prepare(
              'UPDATE file_call_coverage SET file_path = ? WHERE project = ? AND file_path = ?',
            ).run(to, project, from);
            const hash = fileHashMap.get(from)!;
            deleteFileHash(db, project, from);
            const newFile = discovery.files.find((f) => f.relPath === to)!;
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
            deleteFileCallCoverage(db, project, file);
          }
        });
      }

      // Delete old nodes/edges for files whose hash changed (incremental only)
      if (incremental) {
        db.transaction(() => {
          for (const batch of batches) {
            if (batch.skipped) continue;
            changedFiles.push(batch.file.relPath);
            deleteFileCallCoverage(db, project, batch.file.relPath);
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
      _mark("upsert-nodes");
      failIfRequested(opts, "nodes");

      const resolveBatches = (incremental
        ? batches.filter((b) => !b.skipped)
        : batches).map((batch) => batch.nativeEdges ? {
          ...batch,
          result: { ...batch.result, calls: [], usages: [] },
        } : batch);
      phaseStartedAt = Date.now();
      stats = resolveAll(db, resolveBatches, project);
      const nativeEdges = publishNativeEdges(db, project, batches);
      if (nativeEdges.length > 0) {
        const nativeCalls = batches.reduce((sum, batch) =>
          sum + (batch.nativeEdges ? batch.result.calls.length : 0), 0);
        const resolvedNativeCalls = Math.min(nativeCalls,
          nativeEdges.filter((edge) => edge.type === 'CALLS').length);
        stats.totalCalls += nativeCalls;
        stats.unresolvedCalls += nativeCalls - resolvedNativeCalls;
        if (nativeCalls > resolvedNativeCalls) {
          stats.unresolvedCallReasons.native_target_not_found =
            (stats.unresolvedCallReasons.native_target_not_found || 0) +
            nativeCalls - resolvedNativeCalls;
        }
        stats.totalEdges += nativeEdges.length;
        for (const edge of nativeEdges) {
          stats.edgeTypeBreakdown[edge.type] = (stats.edgeTypeBreakdown[edge.type] || 0) + 1;
        }
        for (const batch of batches) {
          if (!batch.nativeEdges) continue;
          const nativeCalls = batch.result.calls.length;
          const resolvedNativeCalls = Math.min(
            nativeCalls,
            batch.nativeEdges.filter((edge) => edge.type === 'CALLS').length,
          );
          const unresolvedNativeCalls = Math.max(0, nativeCalls - resolvedNativeCalls);
          const fileCoverage = stats.fileCoverage.get(batch.file.relPath) || {
            totalCalls: 0,
            unresolvedCalls: 0,
            unresolvedCallReasons: {},
          };
          fileCoverage.totalCalls += nativeCalls;
          fileCoverage.unresolvedCalls += unresolvedNativeCalls;
          if (unresolvedNativeCalls > 0) {
            fileCoverage.unresolvedCallReasons.native_target_not_found = unresolvedNativeCalls;
          }
          stats.fileCoverage.set(batch.file.relPath, fileCoverage);
        }
      }
      phaseTimingsMs.resolve = Date.now() - phaseStartedAt;
      _mark("resolve-edges");
      failIfRequested(opts, "edges");

      // Resolution has finished inserting edges. Rebuild the indexes before the
      // read-heavy complexity/hotspot/community passes; running those queries on
      // the deliberately de-indexed bulk table turns a sub-second analysis into a
      // tens-of-seconds scan.
      db.prepareBulkReads();
      _mark("prepare-bulk-reads");

      // Files processed/skipped counts
      filesProcessed = batches.filter((b) => !b.skipped).length;
      filesSkipped = batches.filter((b) => b.skipped).length;

      // Post-resolution: compute cyclomatic complexity and transitive loop depths
      if (!incremental || filesProcessed > 0) {
        phaseStartedAt = Date.now();
        computeCyclomaticComplexities(db, project, repoPath);
        computeTransitiveLoopDepths(db, project);
        phaseTimingsMs.complexity = Date.now() - phaseStartedAt;
      }
      _mark("complexity");

      // Phase 4: Analyze (hotspots, clusters, file tree)
      phaseStartedAt = Date.now();
      ({ architecture, hotspotCount } = analyze(db, project));
      phaseTimingsMs.analyze = Date.now() - phaseStartedAt;
      _mark("analyze");

      // Upsert file hashes and filesystem metadata for every discovered batch.
      // This keeps the deterministic drift check accurate even when extraction
      // is skipped because the content hash has not changed.
      db.transaction(() => {
        persistDiscoveredFileMetadata(db, project, batches);
      });
      failIfRequested(opts, "hashes");
      _mark("file-hashes");
      partialFiles = batches
        .filter((batch) => (batch.result.partialReasons?.length || 0) > 0)
        .map((batch) => ({
          file: batch.file.relPath,
          reasons: batch.result.partialReasons!,
        }));
      for (const batch of batches) {
        if (batch.skipped) continue;
        const fileCoverage = stats.fileCoverage.get(batch.file.relPath) || {
          totalCalls: 0,
          unresolvedCalls: 0,
          unresolvedCallReasons: {},
        };
        upsertFileCallCoverage(db, project, {
          filePath: batch.file.relPath,
          totalCalls: fileCoverage.totalCalls,
          unresolvedCalls: fileCoverage.unresolvedCalls,
          unresolvedCallReasons: fileCoverage.unresolvedCallReasons,
          partialReasons: batch.result.partialReasons || [],
        });
      }
      aggregateCoverage = getProjectCallCoverage(db, project);
      reindexedFiles = batches
        .filter((batch) => !batch.skipped)
        .map((batch) => batch.file.relPath)
        .sort();

      // Resolution and hash persistence are the final consumers of the large
      // extraction payloads. Release them before SACG projection so calls,
      // usages and the new semantic graph are not resident simultaneously.
      nodesToUpsert.length = 0;
      for (const batch of batches) {
        batch.result.nodes = [];
        batch.result.calls = [];
        batch.result.imports = [];
        batch.result.usages = [];
        batch.result.channels = [];
        batch.result.throws = [];
        batch.result.decorators = [];
      }
      const provisionalAvgComplexity =
        architecture.hotspots.length > 0
          ? architecture.hotspots.reduce((sum, h) => sum + h.complexity, 0) /
            architecture.hotspots.length
          : 0;
      insertIndexRun(db, {
        project,
        totalNodes: architecture.totalNodes,
        totalEdges: architecture.totalEdges,
        hotspotCount,
        avgComplexity: provisionalAvgComplexity,
        filesProcessed,
        filesSkipped,
        mode,
        coverage: aggregateCoverage,
      });
      _mark("insert-run");
      const sacgInput = projectLegacyGraphToSacg(db, project, {
        sourceCommit: gitCtx?.headSha ?? null,
        sourceBranch: gitCtx?.branch ?? null,
        workingTree,
      });
      _mark("sacg-project");
      persistSacgSnapshot(db, sacgInput, {
        canonicalPayloads: true,
        skipExistingSnapshot: true,
        bulkEvidence: shouldUseBulkEvidencePersistence(
          sacgInput.evidence.length,
          process.env.LYNX_BULK_EVIDENCE ??
            process.env.LYNX_EXPERIMENTAL_BULK_EVIDENCE,
        ),
      });
      _mark("sacg-persist");
      failIfRequested(opts, "run");
    });
  } finally {
    db.endBulk();
    _mark("end-bulk");
    phaseTimingsMs.persist = Math.max(
      0,
      Date.now() -
        persistStartedAt -
        phaseTimingsMs.resolve -
        phaseTimingsMs.complexity -
        phaseTimingsMs.analyze,
    );
  }

  // Compute avg complexity
  const avgComplexity =
    architecture.hotspots.length > 0
      ? architecture.hotspots.reduce((sum, h) => sum + h.complexity, 0) /
        architecture.hotspots.length
      : 0;

  // Build status
  const status: LynxIndexStatus = {
    project,
    totalNodes: architecture.totalNodes,
    totalEdges: architecture.totalEdges,
    status: architecture.totalNodes > 0 ? "ready" : "empty",
    rootPath: repoPath,
    git: gitCtx
      ? { branch: gitCtx.branch, headSha: gitCtx.headSha, isGit: true }
      : null,
  };

  // Generate narrative
  const godComponents = architecture.hotspots.filter(
    (h) => h.complexity > 1000,
  );
  const narrative = explainArchitecture(
    architecture.totalNodes,
    architecture.totalEdges,
    architecture.hotspots.length,
    godComponents.length,
    avgComplexity,
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

  const functionsExtracted = db.db
    .prepare(
      `SELECT COUNT(*) AS count FROM nodes WHERE project = ? AND kind IN ('Function', 'Method')`,
    )
    .get(project) as { count: number };
  const filesWithNodes = countFilesWithGraphNodes(db, project);
  db.setProjectIndexedCommit(project, gitCtx?.headSha ?? null);

  phaseTimingsMs.total = Date.now() - startedAt;
  return {
    status,
    architecture,
    narrative,
    filesProcessed,
    filesSkipped,
    llmSummaryCache,
    phaseTimingsMs,
    persistBreakdown,
    coverage: {
      files_discovered: discovery.files.length,
      files_processed: filesProcessed,
      files_skipped: filesSkipped,
      files_with_nodes: filesWithNodes,
      excluded_directories: discovery.excludedDirs.slice(0, 100),
      functions_extracted: functionsExtracted.count,
      calls_extracted: aggregateCoverage.callsExtracted,
      calls_resolved: aggregateCoverage.callsResolved,
      calls_unresolved: aggregateCoverage.callsUnresolved,
      unresolved_call_reasons: aggregateCoverage.unresolvedCallReasons,
      call_resolution_rate: aggregateCoverage.callResolutionRate,
      partial_files: aggregateCoverage.partialFiles,
    },
    incremental: {
      updateMode: incremental
        ? "incremental"
        : requestedIncremental
          ? "full_fallback"
          : "full",
      filesInspected: discovery.files.length,
      added,
      modified,
      deleted,
      renamed,
      reindexed: reindexedFiles,
      fallbackReason,
      nodesAdded: Math.max(0, architecture.totalNodes - beforeNodes),
      nodesRemoved: Math.max(0, beforeNodes - architecture.totalNodes),
      edgesAdded: Math.max(0, architecture.totalEdges - beforeEdges),
      edgesRemoved: Math.max(0, beforeEdges - architecture.totalEdges),
      durationMs: Date.now() - startedAt,
      health: "healthy",
    },
  };
}

function hashFile(filePath: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function isNativeCoreFile(filePath: string): boolean {
  return /\.(?:c|h|cc|cpp|cxx|hh|hpp|hxx)$/i.test(filePath);
}

function publishNativeEdges(
  db: LynxDatabase,
  project: string,
  batches: Awaited<ReturnType<typeof extractAll>>,
): LynxEdge[] {
  const observations = batches.flatMap((batch) => batch.nativeEdges || []);
  if (observations.length === 0) return [];
  const qualifiedNames = [...new Set(observations.flatMap((edge) =>
    [edge.sourceQualifiedName, edge.targetQualifiedName]))];
  const ids = findNodeIdsByQns(db, project, qualifiedNames);
  const missing = qualifiedNames.filter((qualifiedName) => !ids.has(qualifiedName));
  if (missing.length > 0) {
    throw new Error(`Native publication rejected: ${missing.length} graph nodes are missing`);
  }
  const edges: LynxEdge[] = observations.map((edge) => ({
    project,
    sourceId: ids.get(edge.sourceQualifiedName)!,
    targetId: ids.get(edge.targetQualifiedName)!,
    type: edge.type,
    properties: {
      line: edge.startLine,
      column: edge.startColumn,
      confidence: edge.confidence,
      resolution: edge.strategy,
      extractor: 'lynx-native-core',
      evidence: edge.evidence,
    },
  }));
  insertEdgesBatch(db, edges);
  return edges;
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function failIfRequested(
  opts: PipelineOptions,
  stage: NonNullable<PipelineOptions["testFailAt"]>,
): void {
  if (opts.testFailAt === stage)
    throw new Error(`LYNX_TEST_PIPELINE_FAILURE:${stage}`);
}
