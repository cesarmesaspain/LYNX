/*
 * resolve/orchestrator.ts — resolveAll: runs all 15 resolution passes in order.
 */

import type { LynxDatabase } from '../../../store/database.js';
import { insertEdgesBatch } from '../../../store/edges.js';
import type { LynxEdge } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import { buildIndexes, type ResolverState } from './indexes.js';
import { dedupeEdges, countByType } from './utils.js';
import { passStructure } from './pass-structure.js';
import { passBranch } from './pass-branch.js';
import { passDefinitions } from './pass-definitions.js';
import { enrichHeritageFromSource, passHeritage } from './pass-heritage.js';
import { passImports } from './pass-imports.js';
import { passCalls } from './pass-calls.js';
import { passRoutes } from './pass-routes.js';
import { passUsages } from './pass-usages.js';
import { passThrows } from './pass-throws.js';
import { passTests } from './pass-tests.js';
import { passSemanticLight } from './pass-semantic.js';
import { passChannelsFromSource } from './pass-channels.js';
import { passDependencies } from './pass-dependencies.js';
import { passDecorators } from './pass-decorators.js';
import { passRegistryDispatch } from './pass-registry-dispatch.js';

export interface ResolutionStats {
  unresolvedCalls: number;
  unresolvedCallReasons: Record<string, number>;
  totalCalls: number;
  totalEdges: number;
  edgeTypeBreakdown: Record<string, number>;
  passTimingsMs: Record<string, number>;
  fileCoverage: ResolverState['fileCoverage'];
}

export function resolveAll(
  db: LynxDatabase,
  batches: ExtractionBatch[],
  project: string
): ResolutionStats {
  if (batches.length === 0) {
    return {
      unresolvedCalls: 0,
      unresolvedCallReasons: {},
      totalCalls: 0,
      totalEdges: 0,
      edgeTypeBreakdown: {},
      passTimingsMs: {},
      fileCoverage: new Map(),
    };
  }

  const edges: LynxEdge[] = [];
  const state: ResolverState = {
    totalCalls: 0,
    unresolvedCalls: 0,
    unresolvedCallReasons: {},
    fileCoverage: new Map(),
  };
  const idx = buildIndexes(db, project);
  const passTimingsMs: Record<string, number> = {};
  const timed = (name: string, operation: () => void): void => {
    const started = performance.now();
    operation();
    passTimingsMs[name] = Number((performance.now() - started).toFixed(2));
  };

  timed('structure', () => passStructure(db, batches, idx, edges));
  timed('branch', () => passBranch(db, batches, project, idx, edges));
  timed('definitions', () => passDefinitions(batches, idx, edges));
  timed('heritage-source', () => enrichHeritageFromSource(batches, idx));
  timed('heritage', () => passHeritage(idx, edges));
  timed('imports', () => passImports(batches, idx, edges));
  timed('calls', () => passCalls(db, batches, idx, edges, state));
  timed('registry-dispatch', () => passRegistryDispatch(batches, idx, edges));
  timed('routes', () => passRoutes(db, batches, idx, edges));
  timed('usages', () => passUsages(batches, idx, edges));
  timed('throws', () => passThrows(db, batches, idx, edges));
  timed('tests', () => passTests(batches, idx, edges));
  timed('semantic', () => passSemanticLight(db, batches, idx, edges));
  timed('channels', () => passChannelsFromSource(db, batches, idx, edges));
  timed('dependencies', () => passDependencies(db, batches, idx, edges));
  timed('decorators', () => passDecorators(batches, idx, edges));

  const dedupeStarted = performance.now();
  const deduped = dedupeEdges(edges);
  passTimingsMs.dedupe = Number((performance.now() - dedupeStarted).toFixed(2));
  const edgeTypeBreakdown = countByType(deduped);

  if (deduped.length > 0) {
    const insertStarted = performance.now();
    insertEdgesBatch(db, deduped);
    passTimingsMs.insert = Number((performance.now() - insertStarted).toFixed(2));
  }
  if (process.env.LYNX_PROFILE === '1') {
    process.stderr.write(`[resolve.profile] ${JSON.stringify(passTimingsMs)}\n`);
  }

  return {
    unresolvedCalls: state.unresolvedCalls,
    unresolvedCallReasons: state.unresolvedCallReasons,
    totalCalls: state.totalCalls,
    totalEdges: deduped.length,
    edgeTypeBreakdown,
    passTimingsMs,
    fileCoverage: state.fileCoverage,
  };
}
