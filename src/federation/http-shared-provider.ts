/*
 * http-shared-provider.ts — Read-only HTTP provider for Team federation.
 */

import type { LynxDatabase } from "../store/database.js";
import type {
  FederatedSearchParams,
  FederatedTraceParams,
  IndexProvider,
  LocalSearchResult,
  LocalTraceResult,
  SearchNode,
  TraceEntry,
} from "./types.js";

export interface HttpSharedIndexProviderOptions {
  baseUrl: string;
  accessToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function normalizedBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSearchNode(value: unknown): SearchNode {
  if (!isRecord(value))
    throw new Error("Team backend returned an invalid search node");
  const requiredStrings = [
    "name",
    "qualified_name",
    "file_path",
    "kind",
  ] as const;
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string")
      throw new Error(
        `Team backend returned an invalid search node field: ${key}`,
      );
  }
  const requiredNumbers = [
    "start_line",
    "end_line",
    "in_degree",
    "out_degree",
  ] as const;
  for (const key of requiredNumbers) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      throw new Error(
        `Team backend returned an invalid search node field: ${key}`,
      );
    }
  }
  if (
    typeof value.is_entry_point !== "boolean" ||
    typeof value.is_test !== "boolean"
  ) {
    throw new Error("Team backend returned invalid search node flags");
  }
  return {
    name: value.name as string,
    qualified_name: value.qualified_name as string,
    file_path: value.file_path as string,
    start_line: value.start_line as number,
    end_line: value.end_line as number,
    kind: value.kind as string,
    in_degree: value.in_degree as number,
    out_degree: value.out_degree as number,
    is_entry_point: value.is_entry_point,
    is_test: value.is_test,
    provenance: "shared",
    provider_count: 1,
    ...(typeof value.deterministic_score === "number"
      ? { deterministic_score: value.deterministic_score }
      : {}),
  };
}

function normalizeTraceEntry(value: unknown): TraceEntry {
  if (!isRecord(value))
    throw new Error("Team backend returned an invalid trace entry");
  if (
    typeof value.name !== "string" ||
    typeof value.qualified_name !== "string" ||
    typeof value.file_path !== "string" ||
    typeof value.hop !== "number"
  ) {
    throw new Error("Team backend returned an invalid trace entry");
  }
  return {
    name: value.name as string,
    qualified_name: value.qualified_name as string,
    file_path: value.file_path as string,
    hop: value.hop,
    ...(typeof value.risk === "string" ? { risk: value.risk } : {}),
    provenance: "shared",
  };
}

export class HttpSharedIndexProvider implements IndexProvider {
  readonly label = "shared" as const;

  private readonly baseUrl: string;
  private readonly accessToken?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpSharedIndexProviderOptions) {
    const baseUrl = normalizedBaseUrl(options.baseUrl);
    if (!baseUrl) throw new Error("Team backend base URL is required");
    this.baseUrl = baseUrl;
    this.accessToken = options.accessToken?.trim() || undefined;
    this.timeoutMs = Math.max(100, options.timeoutMs ?? 2000);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async searchGraph(
    _db: LynxDatabase,
    params: FederatedSearchParams,
  ): Promise<LocalSearchResult> {
    const payload = await this.postJson("/v1/team/search-graph", params);
    if (
      !isRecord(payload) ||
      !Array.isArray(payload.results) ||
      typeof payload.total !== "number"
    ) {
      throw new Error("Team backend returned an invalid search response");
    }
    return {
      results: payload.results.map(normalizeSearchNode),
      total: payload.total,
    };
  }

  async tracePath(
    _db: LynxDatabase,
    params: FederatedTraceParams,
  ): Promise<LocalTraceResult | null> {
    const payload = await this.postJson("/v1/team/trace-path", params);
    if (payload === null) return null;
    if (
      !isRecord(payload) ||
      !isRecord(payload.root) ||
      !Array.isArray(payload.callers) ||
      !Array.isArray(payload.callees) ||
      !Array.isArray(payload.edges)
    ) {
      throw new Error("Team backend returned an invalid trace response");
    }
    const root = payload.root;
    if (
      typeof root.name !== "string" ||
      typeof root.qualified_name !== "string" ||
      typeof root.file_path !== "string" ||
      typeof root.kind !== "string"
    ) {
      throw new Error("Team backend returned an invalid trace root");
    }
    const numberFields = [
      "totalVisited",
      "maxHop",
      "totalCallers",
      "totalCallees",
      "page",
      "pageSize",
    ] as const;
    for (const key of numberFields) {
      if (typeof payload[key] !== "number" || !Number.isFinite(payload[key])) {
        throw new Error(`Team backend returned an invalid trace field: ${key}`);
      }
    }
    if (
      typeof payload.direction !== "string" ||
      typeof payload.mode !== "string"
    ) {
      throw new Error("Team backend returned invalid trace metadata");
    }
    return {
      root: {
        name: root.name,
        qualified_name: root.qualified_name,
        file_path: root.file_path,
        kind: root.kind,
      },
      direction: payload.direction,
      mode: payload.mode,
      callers: payload.callers.map(normalizeTraceEntry),
      callees: payload.callees.map(normalizeTraceEntry),
      edges: payload.edges as LocalTraceResult["edges"],
      totalVisited: payload.totalVisited as number,
      maxHop: payload.maxHop as number,
      totalCallers: payload.totalCallers as number,
      totalCallees: payload.totalCallees as number,
      page: payload.page as number,
      pageSize: payload.pageSize as number,
    };
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers({
        accept: "application/json",
        "content-type": "application/json",
      });
      if (this.accessToken)
        headers.set("authorization", `Bearer ${this.accessToken}`);
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Team backend request failed with HTTP ${response.status}`,
        );
      }
      return await response.json();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(
          `Team backend request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
