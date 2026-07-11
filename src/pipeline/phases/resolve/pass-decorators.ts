/*
 * resolve/pass-decorators.ts — DECORATES edges.
 */

import type { LynxEdge } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import { callableKinds } from './constants.js';
import type { ResolverIndexes } from './indexes.js';
import { addEdge, preferSameFile, resolveCaller } from './utils.js';

export function passDecorators(
  batches: ExtractionBatch[],
  idx: ResolverIndexes,
  edges: LynxEdge[]
): void {
  for (const batch of batches) {
    const fileDecorators = batch.result.decorators || [];
    for (const dec of fileDecorators) {
      const source = resolveCaller(idx, batch.file.relPath, dec.targetQn);
      if (!source) continue;

      const candidates = (idx.nameToRows.get(dec.name) || [])
        .filter((node) => callableKinds.has(node.kind) || node.kind === 'Class');
      const target = preferSameFile(candidates, batch.file.relPath)
        || (candidates.length === 1 ? candidates[0] : undefined);

      if (target && source.id !== target.id) {
        addEdge(edges, idx.project, source.id, target.id, 'DECORATES', {
          decorator: dec.name,
          line: dec.startLine,
          resolution: 'decorator-extraction',
          confidence: 0.8,
        });
      }
    }
  }
}
