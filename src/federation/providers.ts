/*
 * providers.ts — LocalIndexProvider and InMemorySharedIndexProvider.
 *
 * LocalIndexProvider delegates to the pure cores (search-core, trace-core).
 * InMemorySharedIndexProvider returns only explicitly configured fixtures.
 *
 * Both implement IndexProvider — no MCP coupling.
 */

import type { LynxDatabase } from '../store/database.js';
import { executeLocalSearchGraph } from './search-core.js';
import { executeLocalTracePath } from './trace-core.js';
import type {
  IndexProvider,
  FederatedSearchParams,
  FederatedTraceParams,
  LocalSearchResult,
  LocalTraceResult,
  SearchNode,
  TraceEntry,
  TraceEdge,
  TraceRoot,
} from './types.js';

// ── LocalIndexProvider ──────────────────────────────────────

export class LocalIndexProvider implements IndexProvider {
  readonly label = 'local' as const;

  searchGraph(db: LynxDatabase, params: FederatedSearchParams): LocalSearchResult {
    return executeLocalSearchGraph(db, params);
  }

  tracePath(db: LynxDatabase, params: FederatedTraceParams): LocalTraceResult | null {
    return executeLocalTracePath(db, params);
  }
}

// ── InMemorySharedIndexProvider ──────────────────────────────

type SearchFixture = {
  params: Partial<FederatedSearchParams>;
  results: SearchNode[];
};

type TraceFixture = {
  params: Partial<FederatedTraceParams>;
  result: LocalTraceResult;
};

/**
 * InMemorySharedIndexProvider returns only explicitly configured fixtures.
 *
 * Fixtures are matched by project. Optional delayMs simulates network latency.
 * No real shared backend, no credentials.
 */
export class InMemorySharedIndexProvider implements IndexProvider {
  readonly label = 'shared' as const;

  private searchFixtures: Map<string, SearchFixture[]> = new Map();
  private traceFixtures: Map<string, TraceFixture[]> = new Map();
  readonly delayMs: number;

  constructor(opts?: { delayMs?: number }) {
    this.delayMs = opts?.delayMs ?? 0;
  }

  /** Register a search fixture for a project. */
  setSearchResults(project: string, results: SearchNode[]): void {
    this.searchFixtures.set(project, [{ params: {}, results }]);
  }

  /** Register a search fixture with param matching. */
  addSearchFixture(project: string, params: Partial<FederatedSearchParams>, results: SearchNode[]): void {
    const existing = this.searchFixtures.get(project) || [];
    existing.push({ params, results });
    this.searchFixtures.set(project, existing);
  }

  /** Register a trace fixture for a project+functionName. */
  setTraceResult(
    project: string, functionName: string,
    overrides: Partial<LocalTraceResult> & { root: TraceRoot; callers?: TraceEntry[]; callees?: TraceEntry[] }
  ): void {
    const result: LocalTraceResult = {
      root: overrides.root,
      direction: overrides.direction || 'both',
      mode: overrides.mode || 'calls',
      callers: overrides.callers || [],
      callees: overrides.callees || [],
      edges: overrides.edges || [],
      totalVisited: overrides.totalVisited ?? 0,
      maxHop: overrides.maxHop ?? 0,
      totalCallers: overrides.totalCallers ?? (overrides.callers || []).length,
      totalCallees: overrides.totalCallees ?? (overrides.callees || []).length,
      page: overrides.page ?? 0,
      pageSize: overrides.pageSize ?? 12,
    };
    this.traceFixtures.set(`${project}::${functionName}`, [
      { params: { functionName }, result },
    ]);
  }

  async searchGraph(_db: LynxDatabase, params: FederatedSearchParams): Promise<LocalSearchResult> {
    if (this.delayMs > 0) {
      await new Promise(r => setTimeout(r, this.delayMs));
    }

    const fixtures = this.searchFixtures.get(params.project) || [];
    if (fixtures.length === 0) {
      return { results: [], total: 0 };
    }

    // Use the first fixture (or match by query)
    const fixture = fixtures[0];
    const results = fixture.results.map(r => ({
      ...r,
      provenance: 'shared' as const,
      provider_count: 1, // will be merged by gateway
    }));

    return { results, total: results.length };
  }

  async tracePath(_db: LynxDatabase, params: FederatedTraceParams): Promise<LocalTraceResult | null> {
    if (this.delayMs > 0) {
      await new Promise(r => setTimeout(r, this.delayMs));
    }

    const key = `${params.project}::${params.functionName}`;
    const fixtures = this.traceFixtures.get(key) || [];
    if (fixtures.length === 0) return null;

    const result = fixtures[0].result;
    return {
      ...result,
      callers: result.callers.map(e => ({ ...e, provenance: 'shared' as const })),
      callees: result.callees.map(e => ({ ...e, provenance: 'shared' as const })),
    };
  }
}
