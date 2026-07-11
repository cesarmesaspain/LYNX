/*
 * resolve/pass-channels.ts — EMITS/LISTENS_ON from source-level regex scan.
 */

import * as fs from 'node:fs';
import type { LynxDatabase } from '../../../store/database.js';
import type { LynxEdge } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import type { ResolverIndexes } from './indexes.js';
import { addEdge, getFileNode, upsertChannelNode } from './utils.js';

export function passChannelsFromSource(
  db: LynxDatabase,
  batches: ExtractionBatch[],
  idx: ResolverIndexes,
  edges: LynxEdge[]
): void {
  const emitRe = /\.(?:emit|send|publish|broadcast)\s*\(\s*['"]([^'"]+)['"]/g;
  const listenRe = /\.(?:on|once|subscribe|addListener)\s*\(\s*['"]([^'"]+)['"]/g;

  for (const batch of batches) {
    const fileNode = getFileNode(idx, batch.file.relPath);
    if (!fileNode) continue;

    let source: string;
    try { source = fs.readFileSync(batch.file.absPath, 'utf-8'); }
    catch { continue; }

    const seen = new Set<string>();

    for (const m of source.matchAll(emitRe)) {
      const channelName = m[1];
      const key = `EMITS:${channelName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = source.substring(0, m.index || 0).split('\n').length;
      const channelId = upsertChannelNode(db, idx, channelName, 'event_emitter');
      addEdge(edges, idx.project, fileNode.id, channelId, 'EMITS', {
        channelName,
        transport: 'event_emitter',
        line,
        confidence: 0.6,
      });
    }

    for (const m of source.matchAll(listenRe)) {
      const channelName = m[1];
      const key = `LISTENS_ON:${channelName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = source.substring(0, m.index || 0).split('\n').length;
      const channelId = upsertChannelNode(db, idx, channelName, 'event_emitter');
      addEdge(edges, idx.project, fileNode.id, channelId, 'LISTENS_ON', {
        channelName,
        transport: 'event_emitter',
        line,
        confidence: 0.6,
      });
    }
  }
}
