/*
 * resolve/pass-semantic.ts — CONFIGURES, EMITS, and LISTENS_ON from usage patterns.
 */

import type { LynxDatabase } from '../../../store/database.js';
import type { LynxConfigKey, LynxEdge, LynxEdgeType } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import type { ResolverIndexes } from './indexes.js';
import { addEdge, getFileNode, sanitizeQnPart, upsertChannelNode, upsertSyntheticNode } from './utils.js';

export function passSemanticLight(
  db: LynxDatabase,
  batches: ExtractionBatch[],
  idx: ResolverIndexes,
  edges: LynxEdge[]
): void {
  for (const batch of batches) {
    const fileNode = getFileNode(idx, batch.file.relPath);
    if (!fileNode) continue;

    for (const usage of batch.result.usages) {
      if (usage.refName === 'process' || usage.refName === 'env' || usage.refName.startsWith('NEXT_PUBLIC_')) {
        const configId = upsertSyntheticNode(db, idx, {
          project: idx.project,
          kind: 'ConfigKey',
          name: usage.refName,
          qualifiedName: `${idx.project}.config.${sanitizeQnPart(usage.refName)}`,
          filePath: '',
          startLine: 0,
          endLine: 0,
          isExported: false,
          isTest: false,
          isEntryPoint: false,
          keyName: usage.refName,
        } satisfies LynxConfigKey);

        addEdge(edges, idx.project, fileNode.id, configId, 'CONFIGURES', {
          refName: usage.refName,
          line: usage.startLine,
          resolution: 'env-usage',
          confidence: 0.4,
        });
      }
    }

    for (const channel of batch.result.channels) {
      const edgeType: LynxEdgeType = channel.direction === 'emit' ? 'EMITS' : 'LISTENS_ON';
      const channelId = upsertChannelNode(db, idx, channel.channelName, channel.transport);

      // Anchor EMITS/LISTENS_ON to the enclosing function when available,
      // so trace_path can traverse event-driven dependencies at symbol level.
      const enclosingFnId = channel.enclosingFuncQn
        ? idx.qnToId.get(channel.enclosingFuncQn)
        : undefined;
      const fnNode = enclosingFnId !== undefined ? idx.idToRow.get(enclosingFnId) : undefined;
      const isCallable = fnNode && (fnNode.kind === 'Function' || fnNode.kind === 'Method');
      const sameFile = fnNode && fnNode.file_path === batch.file.relPath;
      const sourceId = (isCallable && sameFile) ? fnNode!.id : fileNode.id;

      addEdge(edges, idx.project, sourceId, channelId, edgeType, {
        channelName: channel.channelName,
        transport: channel.transport,
        direction: channel.direction,
        line: channel.startLine,
        confidence: 0.7,
      });
    }
  }
}
