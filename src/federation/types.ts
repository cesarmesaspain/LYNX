/*
 * types.ts — Federation type contracts.
 *
 * Shared between handler cores, index providers, and the federated gateway.
 * No runtime dependencies; pure type definitions only.
 */

import type { LynxDatabase } from '../store/database.js';

// ── Provenance ──────────────────────────────────────────

/** Where a result came from. */
export type Provenance = 'local' | 'shared' | 'mixed' | 'local_fallback';

// ── Search graph ────────────────────────────────────────

/** Structured search params — mirror of store/search.ts LynxSearchParams. */
export interface FederatedSearchParams {
  project: string;
  query?: string;
  label?: string;
  namePattern?: string;
  qnPattern?: string;
  filePattern?: string;
  limit: number;
  offset: number;
  minDegree?: number;
  maxDegree?: number;
  excludeEntryPoints: boolean;
  /** When true, forces structured search path even if only a query is provided. */
  hasSemanticQuery?: boolean;
}

/** A single node result from search (mapped, before narrative/LLM). */
export interface SearchNode {
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  kind: string;
  in_degree: number;
  out_degree: number;
  is_entry_point: boolean;
  is_test: boolean;
  /** Which provider(s) contributed this result. */
  provenance: Provenance;
  /** Number of providers that contributed (1 or 2). */
  provider_count: number;
}

/** Pure local search result. */
export interface LocalSearchResult {
  results: SearchNode[];
  total: number;
}

// ── Trace path ──────────────────────────────────────────

/** Structured trace params. */
export interface FederatedTraceParams {
  functionName: string;
  project: string;
  direction: 'inbound' | 'outbound' | 'both';
  depth: number;
  mode: string;
  riskLabels: boolean;
  includeTests: boolean;
  customEdgeTypes?: string[];
  maxResults: number;
  page: number;
  pageSize: number;
}

/** A single traversal entry (before narrative/LLM). */
export interface TraceEntry {
  name: string;
  qualified_name: string;
  file_path: string;
  hop: number;
  risk?: string;
  provenance: Provenance;
}

/** Edge from a traversal. */
export interface TraceEdge {
  fromName: string;
  toName: string;
  type: string;
}

/** Root node info from a traversal. */
export interface TraceRoot {
  name: string;
  qualified_name: string;
  file_path: string;
  kind: string;
}

/** Pure local trace result. */
export interface LocalTraceResult {
  root: TraceRoot;
  direction: string;
  mode: string;
  callers: TraceEntry[];
  callees: TraceEntry[];
  edges: TraceEdge[];
  totalVisited: number;
  maxHop: number;
  totalCallers: number;
  totalCallees: number;
  page: number;
  pageSize: number;
}

// ── Index provider interface ────────────────────────────

/** A search/trace provider that operates on one index (local or shared). */
export interface IndexProvider {
  /** Unique label for provenance tagging. */
  readonly label: 'local' | 'shared';

  searchGraph(db: LynxDatabase, params: FederatedSearchParams): LocalSearchResult | Promise<LocalSearchResult>;

  tracePath(db: LynxDatabase, params: FederatedTraceParams): LocalTraceResult | null | Promise<LocalTraceResult | null>;
}

// ── Authorization ───────────────────────────────────────

/** Result of an authorization check. */
export interface AuthResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Authorizer checks whether a caller may access results from a shared provider.
 *
 * Implementations can be noop (allow all), token-based, or RBAC.
 */
export interface Authorizer {
  /** Check before querying the shared provider for a project. */
  authorizeProject(project: string): AuthResult;

  /** Filter shared results before returning to the caller. */
  filterResult<T extends { file_path?: string }>(result: T, project: string): T | null;
}

// ── Gateway configuration ───────────────────────────────

/** Injected configuration for the federated gateway. */
export interface FederatedGatewayConfig {
  /** Service label for tracing/logging (e.g. "team-acme"). */
  teamName: string;

  /** The local index provider (always used). */
  localProvider: IndexProvider;

  /** The shared index provider (may be skipped if unauthorized/timed out). */
  sharedProvider: IndexProvider;

  /** Authorization check for shared access. */
  authorizer: Authorizer;

  /** Max wait for the shared provider in ms (default 3000). */
  sharedTimeoutMs: number;

  /** Whether to log gateway operations. */
  debug?: boolean;
}

// ── Gateway result wrappers ─────────────────────────────

/** Gateway response for search_graph. */
export interface GatewaySearchResult {
  results: SearchNode[];
  total: number;
  provenance_summary: {
    local_count: number;
    shared_count: number;
    mixed_count: number;
    local_fallback: boolean;
    shared_available: boolean;
    shared_authorized: boolean;
    shared_latency_ms?: number;
    shared_error?: string;
  };
}

/** Gateway response for trace_path. */
export interface GatewayTraceResult {
  function: TraceRoot;
  direction: string;
  mode: string;
  callers: TraceEntry[];
  callees: TraceEntry[];
  edges: TraceEdge[];
  total_visited: number;
  max_depth: number;
  provenance_summary: {
    local_count: number;
    shared_count: number;
    mixed_count: number;
    local_fallback: boolean;
    shared_available: boolean;
    shared_authorized: boolean;
    shared_latency_ms?: number;
    shared_error?: string;
  };
  pagination: {
    page: number;
    page_size: number;
    total_callers: number;
    total_callees: number;
    callers_on_page: number;
    callees_on_page: number;
    has_more: boolean;
  };
}
