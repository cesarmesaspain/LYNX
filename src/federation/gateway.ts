/*
 * gateway.ts — FederatedGateway: local-first, shared with timeout, dedup, provenance.
 *
 * Activates only via injectable FederatedGatewayConfig. Without config,
 * handlers use local provider directly (zero overhead).
 *
 * Rules:
 *   - Local ALWAYS runs first.
 *   - Shared runs concurrently with AbortController timeout IF authorized.
 *   - local_fallback ONLY when shared was allowed/authorized AND failed/timed out.
 *   - Dedup: search_graph by qualified_name + file_path normalized;
 *            trace_path by qualified_name identity.
 *   - Local data wins on conflict → tagged mixed.
 *   - Stable deterministic ordering.
 */

import type { LynxDatabase } from '../store/database.js';
import type {
  IndexProvider,
  FederatedGatewayConfig,
  FederatedSearchParams,
  FederatedTraceParams,
  SearchNode,
  LocalSearchResult,
  LocalTraceResult,
  GatewaySearchResult,
  GatewayTraceResult,
  Provenance,
} from './types.js';

// ── Search graph gateway ───────────────────────────────────

function normalizeFilePath(fp: string): string {
  return fp.replace(/\\/g, '/');
}

function searchDedupKey(n: SearchNode): string {
  return `${n.qualified_name}|${normalizeFilePath(n.file_path)}`;
}

export async function federatedSearchGraph(
  db: LynxDatabase,
  params: FederatedSearchParams,
  config: FederatedGatewayConfig
): Promise<GatewaySearchResult> {
  const { localProvider, sharedProvider, authorizer, sharedTimeoutMs } = config;
  const started = Date.now();

  // 1. Local always runs first (synchronous, no overhead)
  const localResult = await localProvider.searchGraph(db, params);

  // 2. Check authorization for shared
  const authResult = authorizer.authorizeProject(params.project);
  const sharedAuthorized = authResult.allowed;

  let sharedLatencyMs: number | undefined;
  let sharedError: string | undefined;
  let sharedResults: SearchNode[] = [];
  let sharedAvailable = false;

  // 3. Shared only if authorized
  if (sharedAuthorized) {
    try {
      const sharedPromise = Promise.resolve(
        sharedProvider.searchGraph(db, params)
      );

      // Race with timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Shared provider timed out')), sharedTimeoutMs);
      });

      const sharedResult = await Promise.race([sharedPromise, timeoutPromise]);
      sharedLatencyMs = Date.now() - started;

      // sharedAvailable = true when shared responded (even with empty results)
      sharedAvailable = true;

      if (sharedResult && sharedResult.results.length > 0) {
        sharedResults = sharedResult.results.map(r => ({
          ...r,
          provenance: 'shared' as Provenance,
          provider_count: 1,
        }));

        // Apply post-query filter
        sharedResults = sharedResults
          .map(r => authorizer.filterResult(r, params.project))
          .filter((r): r is SearchNode => r !== null);
      }
    } catch (err) {
      sharedError = err instanceof Error ? err.message : String(err);
      sharedLatencyMs = Date.now() - started;
      // sharedAvailable stays false — local_fallback will be true
    }
  }

  // 4. Merge with dedup — local wins on conflict
  const seen = new Map<string, SearchNode>();

  // Insert local results first
  for (const r of localResult.results) {
    const key = searchDedupKey(r);
    seen.set(key, { ...r, provenance: 'local' as Provenance, provider_count: 1 });
  }

  // Insert shared results — skip if local already has it
  for (const r of sharedResults) {
    const key = searchDedupKey(r);
    if (seen.has(key)) {
      // Conflict: local wins, mark as mixed
      const existing = seen.get(key)!;
      existing.provenance = 'mixed';
      existing.provider_count = 2;
    } else {
      seen.set(key, r);
    }
  }

  // Stable sort: local first, then shared, within each by qualified_name
  const localEntries: SearchNode[] = [];
  const sharedEntries: SearchNode[] = [];
  const mixedEntries: SearchNode[] = [];
  const otherEntries: SearchNode[] = [];

  for (const r of seen.values()) {
    switch (r.provenance) {
      case 'local': localEntries.push(r); break;
      case 'shared': sharedEntries.push(r); break;
      case 'mixed': mixedEntries.push(r); break;
      default: otherEntries.push(r); break;
    }
  }

  const sortFn = (a: SearchNode, b: SearchNode) =>
    a.qualified_name.localeCompare(b.qualified_name);

  localEntries.sort(sortFn);
  sharedEntries.sort(sortFn);
  mixedEntries.sort(sortFn);
  otherEntries.sort(sortFn);

  const merged = [...localEntries, ...mixedEntries, ...sharedEntries, ...otherEntries];

  // 5. Determine provenance summary
  const localCount = merged.filter(r => r.provenance === 'local').length;
  const sharedCount = merged.filter(r => r.provenance === 'shared').length;
  const mixedCount = merged.filter(r => r.provenance === 'mixed').length;

  // local_fallback only when shared was authorized but delivered no results
  // (regardless of whether it errored, timed out, or returned empty)
  const localFallback = sharedAuthorized && !sharedAvailable;

  return {
    results: merged,
    total: merged.length,
    provenance_summary: {
      local_count: localCount,
      shared_count: sharedCount,
      mixed_count: mixedCount,
      local_fallback: localFallback,
      shared_available: sharedAvailable,
      shared_authorized: sharedAuthorized,
      shared_latency_ms: sharedLatencyMs,
      shared_error: sharedError || undefined,
    },
  };
}

// ── Trace path gateway ─────────────────────────────────────

function traceDedupKey(e: { qualified_name: string }): string {
  return e.qualified_name;
}

export async function federatedTracePath(
  db: LynxDatabase,
  params: FederatedTraceParams,
  config: FederatedGatewayConfig
): Promise<GatewayTraceResult | null> {
  const { localProvider, sharedProvider, authorizer, sharedTimeoutMs } = config;
  const started = Date.now();

  // 1. Local always runs first
  const localResult = await localProvider.tracePath(db, params);
  if (!localResult) return null;

  // 2. Authorization
  const authResult = authorizer.authorizeProject(params.project);
  const sharedAuthorized = authResult.allowed;

  let sharedLatencyMs: number | undefined;
  let sharedError: string | undefined;
  let sharedCallers: typeof localResult.callers = [];
  let sharedCallees: typeof localResult.callees = [];
  let sharedEdges: typeof localResult.edges = [];
  let sharedAvailable = false;

  if (sharedAuthorized) {
    try {
      const sharedPromise = Promise.resolve(
        sharedProvider.tracePath(db, params)
      );

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Shared provider timed out')), sharedTimeoutMs);
      });

      const sharedResult = await Promise.race([sharedPromise, timeoutPromise]);
      sharedLatencyMs = Date.now() - started;

      // sharedAvailable = true when shared responded (even with null/empty)
      sharedAvailable = true;

      if (sharedResult) {
        // Post-authorization filter for callers/callees (have file_path)
        sharedCallers = sharedResult.callers
          .map(r => authorizer.filterResult(r, params.project))
          .filter((r): r is NonNullable<typeof r> => r !== null)
          .map(r => ({ ...r, provenance: 'shared' as Provenance }));

        sharedCallees = sharedResult.callees
          .map(r => authorizer.filterResult(r, params.project))
          .filter((r): r is NonNullable<typeof r> => r !== null)
          .map(r => ({ ...r, provenance: 'shared' as Provenance }));

        // Trace edges have no file path and therefore cannot be authorized on
        // their own. Return only relationships whose two endpoints survived
        // the node-level authorization filter; otherwise an edge could reveal
        // names from an inaccessible shared project.
        const visibleSharedSymbols = new Set([
          localResult.root.qualified_name,
          ...sharedCallers.map(r => r.qualified_name),
          ...sharedCallees.map(r => r.qualified_name),
        ]);
        sharedEdges = sharedResult.edges.filter(edge =>
          visibleSharedSymbols.has(edge.fromName) && visibleSharedSymbols.has(edge.toName)
        );
      }
    } catch (err) {
      sharedError = err instanceof Error ? err.message : String(err);
      sharedLatencyMs = Date.now() - started;
    }
  }

  // 4. Merge callers — local wins on conflict
  const callerMap = new Map<string, typeof localResult.callers[0]>();
  for (const c of localResult.callers) {
    callerMap.set(traceDedupKey(c), { ...c, provenance: 'local' as Provenance });
  }
  for (const c of sharedCallers) {
    const key = traceDedupKey(c);
    if (callerMap.has(key)) {
      const existing = callerMap.get(key)!;
      existing.provenance = 'mixed';
    } else {
      callerMap.set(key, c);
    }
  }

  const calleeMap = new Map<string, typeof localResult.callees[0]>();
  for (const c of localResult.callees) {
    calleeMap.set(traceDedupKey(c), { ...c, provenance: 'local' as Provenance });
  }
  for (const c of sharedCallees) {
    const key = traceDedupKey(c);
    if (calleeMap.has(key)) {
      const existing = calleeMap.get(key)!;
      existing.provenance = 'mixed';
    } else {
      calleeMap.set(key, c);
    }
  }

  // Stable sort: local first, then by name
  const sortTrace = (arr: Array<{ provenance: Provenance; qualified_name: string }>) =>
    arr.sort((a, b) => {
      if (a.provenance !== b.provenance) {
        if (a.provenance === 'local') return -1;
        if (b.provenance === 'local') return 1;
      }
      return a.qualified_name.localeCompare(b.qualified_name);
    });

  const allCallers = [...callerMap.values()];
  const allCallees = [...calleeMap.values()];
  sortTrace(allCallers);
  sortTrace(allCallees);

  // Merge edges — dedup by from+to+type
  const edgeMap = new Map<string, typeof localResult.edges[0]>();
  for (const e of localResult.edges) {
    edgeMap.set(`${e.fromName}->${e.toName}:${e.type}`, e);
  }
  for (const e of sharedEdges) {
    const key = `${e.fromName}->${e.toName}:${e.type}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, e);
    }
  }

  // Counts
  const localCount = allCallers.filter(e => e.provenance === 'local').length +
                     allCallees.filter(e => e.provenance === 'local').length;
  const sharedCount = allCallers.filter(e => e.provenance === 'shared').length +
                      allCallees.filter(e => e.provenance === 'shared').length;
  const mixedCount = allCallers.filter(e => e.provenance === 'mixed').length +
                     allCallees.filter(e => e.provenance === 'mixed').length;
  const localFallback = sharedAuthorized && !sharedAvailable;

  return {
    function: localResult.root,
    direction: localResult.direction,
    mode: localResult.mode,
    callers: allCallers,
    callees: allCallees,
    edges: [...edgeMap.values()],
    total_visited: allCallers.length + allCallees.length,
    max_depth: localResult.maxHop,
    provenance_summary: {
      local_count: localCount,
      shared_count: sharedCount,
      mixed_count: mixedCount,
      local_fallback: localFallback,
      shared_available: sharedAvailable,
      shared_authorized: sharedAuthorized,
      shared_latency_ms: sharedLatencyMs,
      shared_error: sharedError || undefined,
    },
    pagination: {
      page: localResult.page,
      page_size: localResult.pageSize,
      total_callers: allCallers.length,
      total_callees: allCallees.length,
      callers_on_page: allCallers.length,
      callees_on_page: allCallees.length,
      has_more: false,
    },
  };
}
