/*
 * resolve/pass-calls.ts — CALLS and HTTP_CALLS edges.
 */

import * as fs from 'node:fs';
import type { LynxDatabase } from '../../../store/database.js';
import { upsertNode } from '../../../store/nodes.js';
import type { LynxEdge, LynxRoute } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import type { NodeRef, ResolverIndexes, ResolverState } from './indexes.js';
import { addEdge, hashString, resolveCaller, resolveCallee } from './utils.js';

const HTTP_METHOD_BY_CALL = new Map<string, string>([
  ['fetch', 'GET'], ['request', 'GET'],
  ['get', 'GET'], ['post', 'POST'], ['put', 'PUT'],
  ['patch', 'PATCH'], ['delete', 'DELETE'], ['del', 'DELETE'],
  ['head', 'HEAD'], ['options', 'OPTIONS'],
]);

const KNOWN_HTTP_CLIENTS = new Set([
  'axios', 'ky', 'got', 'undici', 'ofetch', '$fetch',
  'api', 'httpClient', 'client', 'supabase',
]);

function resolveHttpRoute(
  db: LynxDatabase,
  idx: ResolverIndexes,
  calleeName: string,
  args: string[]
): (NodeRef & { urlPath: string; httpMethod: string }) | undefined {
  const methodPart = calleeName.split('.').pop()?.toLowerCase() || calleeName.toLowerCase();
  const httpMethod = HTTP_METHOD_BY_CALL.get(methodPart);
  if (!httpMethod) return undefined;
  const dotIdx = calleeName.indexOf('.');
  if (dotIdx > 0) {
    const prefixed = calleeName.slice(0, dotIdx);
    const clientPrefix = prefixed.split('.').pop() || '';
    if (!KNOWN_HTTP_CLIENTS.has(clientPrefix) && !KNOWN_HTTP_CLIENTS.has(prefixed)) {
      const maybeUrl = extractUrl(args);
      if (!maybeUrl) return undefined;
    }
  }

  if (!calleeName.includes('.') && methodPart !== 'fetch' && methodPart !== 'request') {
    const url = extractUrl(args);
    if (!url) return undefined;
  }

  const firstString = extractUrl(args);
  if (!firstString) return undefined;

  const routeQn = `${idx.project}.route.${hashString(`${httpMethod}:${firstString}`)}`;
  const existingId = idx.qnToId.get(routeQn);
  if (existingId) {
    const existing = idx.idToRow.get(existingId);
    return existing ? { ...existing, urlPath: firstString, httpMethod } : undefined;
  }

  const routeNode: LynxRoute = {
    project: idx.project,
    kind: 'Route',
    name: firstString,
    qualifiedName: routeQn,
    filePath: '',
    startLine: 0,
    endLine: 0,
    isExported: false,
    isTest: false,
    // This node represents an outbound destination inferred from a caller,
    // not an application route declared by this repository.
    isEntryPoint: false,
    httpMethod,
    urlPath: firstString,
    isExternal: true,
  };
  const id = upsertNode(db, routeNode);
  const row: NodeRef = {
    id,
    kind: 'Route',
    name: firstString,
    qualified_name: routeQn,
    file_path: '',
    start_line: 0,
    is_exported: 0,
    properties: JSON.stringify({ httpMethod, urlPath: firstString, external: true }),
  };
  idx.qnToId.set(routeQn, id);
  idx.idToRow.set(id, row);
  idx.allRows.push(row);
  return { ...row, urlPath: firstString, httpMethod };
}

function extractUrl(args: string[]): string | undefined {
  for (const arg of args) {
    const trimmed = arg.trim();
    const stringMatch = trimmed.match(/^['\"\x60]([\/][^'\"\x60]*|https?:\/\/[^'\"\x60]*)['\"\x60]$/);
    if (stringMatch) return stringMatch[1];
    const templateMatch = trimmed.match(/^\x60([^]*?)\x60$/);
    if (templateMatch) {
      const content = templateMatch[1];
      const staticPart = content.replace(/\$\{[^}]*\}/g, ':param');
      if (staticPart.startsWith('/') || staticPart.startsWith('http')) {
        return staticPart.length > 100 ? staticPart.slice(0, 100) + '...' : staticPart;
      }
    }
    if (/\b(?:url|endpoint|path|href|link|apiUrl|baseUrl)\b/i.test(trimmed)) {
      return '[dynamic]';
    }
  }
  return undefined;
}

export function passCalls(
  db: LynxDatabase,
  batches: ExtractionBatch[],
  idx: ResolverIndexes,
  edges: LynxEdge[],
  state: ResolverState
): void {
  for (const batch of batches) {
    for (const call of batch.result.calls) {
      state.totalCalls++;
      const caller = resolveCaller(idx, batch.file.relPath, call.enclosingFuncQn);
      if (!caller) {
        state.unresolvedCalls++;
        state.unresolvedCallReasons.caller_not_found =
          (state.unresolvedCallReasons.caller_not_found || 0) + 1;
        continue;
      }

      const route = resolveHttpRoute(db, idx, call.calleeName, call.args);
      if (route) {
        addEdge(edges, idx.project, caller.id, route.id, 'HTTP_CALLS', {
          callee: call.calleeName,
          url_path: route.urlPath,
          method: route.httpMethod,
          line: call.startLine,
          resolution: 'http-pattern',
          confidence: 0.8,
        });
        continue;
      }

      const resolved = resolveCallee(idx, batch.file.relPath, call.calleeName);
      if (!resolved) {
        state.unresolvedCalls++;
        const methodName = call.calleeName.split('.').pop() || call.calleeName;
        const receiverName = call.calleeName.includes('.')
          ? call.calleeName.split('.')[0]
          : methodName;
        const imported = batch.result.imports.find((entry) =>
          entry.localName === receiverName || entry.localName === methodName);
        const localBinding = (idx.kindNameToRows.get(`Variable:${methodName}`) || [])
          .some((node) => node.file_path === batch.file.relPath);
        const internalCandidates = [
          ...(idx.kindNameToRows.get(`Function:${methodName}`) || []),
          ...(idx.kindNameToRows.get(`Method:${methodName}`) || []),
        ];
        let reason = 'target_absent';
        if (localBinding) reason = 'dynamic_local_binding';
        else if (imported) {
          reason = /^\.{1,2}\//.test(imported.modulePath)
            ? 'imported_internal_target_missing'
            : 'external_dependency_target';
        } else if (call.calleeName.includes('.')) reason = 'receiver_target_unknown';
        else if (internalCandidates.length > 0) reason = 'ambiguous_internal_target';
        state.unresolvedCallReasons[reason] =
          (state.unresolvedCallReasons[reason] || 0) + 1;
        continue;
      }
      if (resolved.node.id === caller.id) {
        state.unresolvedCalls++;
        state.unresolvedCallReasons.self_reference =
          (state.unresolvedCallReasons.self_reference || 0) + 1;
        continue;
      }

      addEdge(edges, idx.project, caller.id, resolved.node.id, 'CALLS', {
        callee: call.calleeName,
        args: call.args.join(', ').substring(0, 200),
        line: call.startLine,
        resolution: resolved.reason,
        confidence: resolved.confidence,
      });
    }
  }
}
