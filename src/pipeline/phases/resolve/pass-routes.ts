/*
 * resolve/pass-routes.ts — Route detection for Next.js App Router.
 */

import * as fs from 'node:fs';
import type { LynxDatabase } from '../../../store/database.js';
import { upsertNode } from '../../../store/nodes.js';
import type { LynxEdge, LynxRoute } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import type { NodeRef, ResolverIndexes } from './indexes.js';
import { addEdge, getFileNode, hashString } from './utils.js';

export function passRoutes(
  db: LynxDatabase,
  batches: ExtractionBatch[],
  idx: ResolverIndexes,
  edges: LynxEdge[]
): void {
  const nextAppRoute = /(?:src\/)?app\/(.+?)\/(route|page)\.(ts|tsx|js|jsx)$/;
  const nextApiRoute = /(?:src\/)?app\/api\/(.+?)\/route\.(ts|tsx|js|jsx)$/;

  for (const batch of batches) {
    const fp = batch.file.relPath;
    const apiMatch = fp.match(nextApiRoute) || fp.match(nextAppRoute);
    if (!apiMatch) continue;

    let urlPath: string;
    if (fp.match(nextApiRoute)) {
      const pathSegments = apiMatch[1].split('/');
      urlPath = '/api/' + pathSegments
        .map(s => {
          if (s.startsWith('[') && s.endsWith(']')) {
            const inner = s.slice(1, -1);
            return inner.startsWith('...') ? '*' : ':' + inner;
          }
          return s;
        })
        .join('/');
    } else {
      const pathSegments = apiMatch[1].split('/');
      urlPath = '/' + pathSegments
        .map(s => {
          if (s.startsWith('[') && s.endsWith(']')) {
            const inner = s.slice(1, -1);
            return inner.startsWith('...') ? '*' : ':' + inner;
          }
          return s;
        })
        .join('/');
    }

    let httpMethod = 'ALL';
    try {
      const source = fs.readFileSync(batch.file.absPath, 'utf-8');
      const methods: string[] = [];
      for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(source)) {
          methods.push(m);
        }
      }
      if (methods.length > 0) httpMethod = methods.join(',');
    } catch {
      // file not readable — keep 'ALL'
    }

    const routeQn = `${idx.project}.route.${hashString(`${httpMethod}:${urlPath}`)}`;
    if (idx.qnToId.has(routeQn)) continue;

    const routeNode: LynxRoute = {
      project: idx.project,
      kind: 'Route',
      name: urlPath,
      qualifiedName: routeQn,
      filePath: fp,
      startLine: 1,
      endLine: 1,
      isExported: false,
      isTest: false,
      isEntryPoint: true,
      httpMethod,
      urlPath,
      isExternal: false,
    };
    const routeId = upsertNode(db, routeNode);
    const row: NodeRef = {
      id: routeId,
      kind: 'Route',
      name: urlPath,
      qualified_name: routeQn,
      file_path: fp,
      start_line: 1,
      is_exported: 0,
      properties: JSON.stringify({ httpMethod, urlPath, framework: 'nextjs-app' }),
    };
    idx.qnToId.set(routeQn, routeId);
    idx.idToRow.set(routeId, row);
    idx.allRows.push(row);

    const fileNode = getFileNode(idx, fp);
    if (fileNode) {
      addEdge(edges, idx.project, routeId, fileNode.id, 'DEFINES', {
        framework: 'nextjs-app',
        resolution: 'route-file',
        confidence: 0.95,
      });
    }
  }
}
