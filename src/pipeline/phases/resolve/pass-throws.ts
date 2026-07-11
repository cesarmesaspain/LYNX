/*
 * resolve/pass-throws.ts — RAISES/THROWS edges.
 */

import type { LynxDatabase } from '../../../store/database.js';
import type { LynxEdge, LynxEdgeType, LynxExternalSymbol } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import type { ResolverIndexes } from './indexes.js';
import { addEdge, preferSameFile, resolveCaller, sanitizeQnPart, upsertSyntheticNode } from './utils.js';

export function passThrows(
  db: LynxDatabase,
  batches: ExtractionBatch[],
  idx: ResolverIndexes,
  edges: LynxEdge[]
): void {
  for (const batch of batches) {
    const fileThrows = batch.result.throws || [];
    for (const thr of fileThrows) {
      const source = resolveCaller(idx, batch.file.relPath, thr.enclosingFuncQn);
      if (!source) continue;

      const edgeType: LynxEdgeType =
        ['Error', 'Panic', 'error', 'panic'].some((e) => thr.exceptionName.includes(e))
          ? 'RAISES'
          : 'THROWS';

      const typeKinds = ['Class', 'Interface', 'Type', 'Enum'];
      const candidates = (idx.nameToRows.get(thr.exceptionName) || [])
        .filter((node) => typeKinds.includes(node.kind));

      const target = preferSameFile(candidates, batch.file.relPath)
        || (candidates.length === 1 ? candidates[0] : undefined);

      if (target && target.id !== source.id) {
        addEdge(edges, idx.project, source.id, target.id, edgeType, {
          exceptionName: thr.exceptionName,
          line: thr.startLine,
          resolution: 'throw-extraction',
          confidence: 0.7,
        });
      } else if (!target) {
        const externalId = upsertSyntheticNode(db, idx, {
          project: idx.project,
          kind: 'ExternalSymbol',
          name: thr.exceptionName,
          qualifiedName: `${idx.project}.external.exception.${sanitizeQnPart(thr.exceptionName)}`,
          filePath: '',
          startLine: 0,
          endLine: 0,
          isExported: false,
          isTest: false,
          isEntryPoint: false,
          symbolType: 'exception',
        } satisfies LynxExternalSymbol);

        addEdge(edges, idx.project, source.id, externalId, edgeType, {
          exceptionName: thr.exceptionName,
          line: thr.startLine,
          resolution: 'external-exception',
          confidence: 0.55,
        });
      }
    }
  }
}
