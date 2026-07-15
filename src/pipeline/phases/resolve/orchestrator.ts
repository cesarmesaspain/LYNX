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
  totalCalls: number;
  totalEdges: number;
  edgeTypeBreakdown: Record<string, number>;
}

export function resolveAll(
  db: LynxDatabase,
  batches: ExtractionBatch[],
  project: string
): ResolutionStats {
  if (batches.length === 0) {
    return {
      unresolvedCalls: 0,
      totalCalls: 0,
      totalEdges: 0,
      edgeTypeBreakdown: {},
    };
  }

  const edges: LynxEdge[] = [];
  const state: ResolverState = { totalCalls: 0, unresolvedCalls: 0 };
  const idx = buildIndexes(db, project);

  passStructure(db, batches, idx, edges);
  passBranch(db, batches, project, idx, edges);
  passDefinitions(batches, idx, edges);
  enrichHeritageFromSource(batches, idx);
  passHeritage(idx, edges);
  passImports(batches, idx, edges);
  passCalls(db, batches, idx, edges, state);
  passRegistryDispatch(batches, idx, edges);
  passRoutes(db, batches, idx, edges);
  passUsages(batches, idx, edges);
  passThrows(db, batches, idx, edges);
  passTests(batches, idx, edges);
  passSemanticLight(db, batches, idx, edges);
  passChannelsFromSource(db, batches, idx, edges);
  passDependencies(db, batches, idx, edges);
  passDecorators(batches, idx, edges);

  const deduped = dedupeEdges(edges);
  const edgeTypeBreakdown = countByType(deduped);

  if (deduped.length > 0) {
    insertEdgesBatch(db, deduped);
  }

  return {
    unresolvedCalls: state.unresolvedCalls,
    totalCalls: state.totalCalls,
    totalEdges: deduped.length,
    edgeTypeBreakdown,
  };
}
