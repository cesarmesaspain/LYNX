import { describe, expect, it, vi } from "vitest";
import { LynxDatabase } from "../../../src/store/database.js";
import { HttpSharedIndexProvider } from "../../../src/federation/http-shared-provider.js";
import type {
  FederatedSearchParams,
  FederatedTraceParams,
  LocalSearchResult,
  LocalTraceResult,
} from "../../../src/federation/types.js";

const searchParams: FederatedSearchParams = {
  project: "team-project",
  query: "handleSearch",
  limit: 20,
  offset: 0,
  excludeEntryPoints: false,
};

const traceParams: FederatedTraceParams = {
  functionName: "handleSearch",
  project: "team-project",
  direction: "both",
  depth: 3,
  mode: "calls",
  riskLabels: true,
  includeTests: true,
  maxResults: 50,
  page: 0,
  pageSize: 12,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json" }),
  } as Response;
}

describe("HttpSharedIndexProvider", () => {
  it("posts search parameters with Bearer auth and normalizes shared provenance", async () => {
    const remote: LocalSearchResult = {
      results: [
        {
          name: "handleSearch",
          qualified_name: "remote.handler.handleSearch",
          file_path: "remote/handler.ts",
          start_line: 10,
          end_line: 20,
          kind: "Function",
          in_degree: 2,
          out_degree: 3,
          is_entry_point: false,
          is_test: false,
          provenance: "local",
          provider_count: 9,
        },
      ],
      total: 1,
    };
    const fetchImpl = vi.fn(async () =>
      jsonResponse(remote),
    ) as unknown as typeof fetch;
    const provider = new HttpSharedIndexProvider({
      baseUrl: "https://team.example.test/",
      accessToken: "team-token",
      timeoutMs: 500,
      fetchImpl,
    });
    const db = LynxDatabase.openMemory();
    try {
      const result = await provider.searchGraph(db, searchParams);
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
      expect(url).toBe("https://team.example.test/v1/team/search-graph");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer team-token",
      );
      expect(JSON.parse(String(init?.body))).toEqual(searchParams);
      expect(result.results[0].provenance).toBe("shared");
      expect(result.results[0].provider_count).toBe(1);
      expect(result.total).toBe(1);
    } finally {
      db.close();
    }
  });

  it("posts trace parameters and normalizes caller and callee provenance", async () => {
    const remote: LocalTraceResult = {
      root: {
        name: "handleSearch",
        qualified_name: "remote.handler.handleSearch",
        file_path: "remote/handler.ts",
        kind: "Function",
      },
      direction: "both",
      mode: "calls",
      callers: [
        {
          name: "route",
          qualified_name: "remote.route",
          file_path: "remote/route.ts",
          hop: 1,
          provenance: "local",
        },
      ],
      callees: [
        {
          name: "getDb",
          qualified_name: "remote.getDb",
          file_path: "remote/db.ts",
          hop: 1,
          provenance: "mixed",
        },
      ],
      edges: [{ fromName: "route", toName: "handleSearch", type: "CALLS" }],
      totalVisited: 3,
      maxHop: 1,
      totalCallers: 1,
      totalCallees: 1,
      page: 0,
      pageSize: 12,
    };
    const fetchImpl = vi.fn(async () =>
      jsonResponse(remote),
    ) as unknown as typeof fetch;
    const provider = new HttpSharedIndexProvider({
      baseUrl: "https://team.example.test",
      fetchImpl,
    });
    const db = LynxDatabase.openMemory();
    try {
      const result = await provider.tracePath(db, traceParams);
      const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
      expect(url).toBe("https://team.example.test/v1/team/trace-path");
      expect(JSON.parse(String(init?.body))).toEqual(traceParams);
      expect(result?.callers[0].provenance).toBe("shared");
      expect(result?.callees[0].provenance).toBe("shared");
    } finally {
      db.close();
    }
  });

  it("returns null for an empty remote trace and rejects non-success responses", async () => {
    const emptyFetch = vi.fn(async () =>
      jsonResponse(null),
    ) as unknown as typeof fetch;
    const emptyProvider = new HttpSharedIndexProvider({
      baseUrl: "https://team.example.test",
      fetchImpl: emptyFetch,
    });
    const db = LynxDatabase.openMemory();
    try {
      await expect(
        emptyProvider.tracePath(db, traceParams),
      ).resolves.toBeNull();
      const deniedFetch = vi.fn(async () =>
        jsonResponse({ error: "denied" }, 403),
      ) as unknown as typeof fetch;
      const deniedProvider = new HttpSharedIndexProvider({
        baseUrl: "https://team.example.test",
        accessToken: "secret-token",
        fetchImpl: deniedFetch,
      });
      await expect(
        deniedProvider.searchGraph(db, searchParams),
      ).rejects.toThrow("Team backend request failed with HTTP 403");
    } finally {
      db.close();
    }
  });
});
