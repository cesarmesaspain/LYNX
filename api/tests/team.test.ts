import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { licensesDb } from "../src/db.js";
import { signLicense } from "../src/jwt.js";
import { LynxDatabase } from "../../dist/store/database.js";

const PROJECT = "team-shared-project";
const UNKNOWN_PROJECT = "team-missing-project";
const TEAM_USER = "team-route-user";
const PRO_USER = "team-route-pro";
const CANCELED_USER = "team-route-canceled";

const app = createApp();

function tokenFor(sub: string, email: string, tier: "pro" | "team"): string {
  return signLicense({ sub, email, tier, machines: [] });
}

const teamToken = tokenFor(TEAM_USER, "team-route@example.com", "team");
const proToken = tokenFor(PRO_USER, "team-route-pro@example.com", "pro");
const canceledToken = tokenFor(
  CANCELED_USER,
  "team-route-canceled@example.com",
  "team",
);

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function projectDbPath(project: string): string {
  return path.join(process.env.LYNX_HOME!, "dbs", `${project}.db`);
}

function seedProject(): void {
  const db = LynxDatabase.openProject(PROJECT);
  try {
    db.upsertProject(PROJECT, "/tmp/team-shared-project");

    const insertNode = db.db.prepare(`
      INSERT INTO nodes (
        id, project, kind, name, qualified_name, file_path, start_line, end_line,
        is_exported, is_test, is_entry_point, properties
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
    `);

    insertNode.run(
      1,
      PROJECT,
      "Function",
      "main",
      "src.cli.main",
      "src/cli.ts",
      1,
      10,
      1,
      0,
      1,
    );
    insertNode.run(
      2,
      PROJECT,
      "Function",
      "searchGraph",
      "src.graph.searchGraph",
      "src/graph.ts",
      12,
      30,
      1,
      0,
      0,
    );
    insertNode.run(
      3,
      PROJECT,
      "Function",
      "readDb",
      "src.store.readDb",
      "src/store.ts",
      5,
      20,
      1,
      0,
      0,
    );

    const insertEdge = db.db.prepare(
      "INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, 'CALLS', '{}')",
    );
    insertEdge.run(PROJECT, 1, 2);
    insertEdge.run(PROJECT, 2, 3);
  } finally {
    db.close();
  }
}

function seedEntitlements(): void {
  const insertUser = licensesDb.prepare(
    "INSERT OR REPLACE INTO users (id, email, tier, billing_status) VALUES (?, ?, ?, ?)",
  );
  insertUser.run(TEAM_USER, "team-route@example.com", "team", "active");
  insertUser.run(PRO_USER, "team-route-pro@example.com", "pro", "active");
  insertUser.run(
    CANCELED_USER,
    "team-route-canceled@example.com",
    "team",
    "canceled",
  );

  licensesDb
    .prepare(
      "INSERT OR REPLACE INTO team_project_access (user_id, project) VALUES (?, ?)",
    )
    .run(TEAM_USER, PROJECT);
}

beforeAll(async () => {
  seedProject();
  seedEntitlements();
  await app.ready();
});

afterAll(async () => {
  licensesDb
    .prepare("DELETE FROM team_project_access WHERE user_id IN (?, ?, ?)")
    .run(TEAM_USER, PRO_USER, CANCELED_USER);
  licensesDb
    .prepare("DELETE FROM users WHERE id IN (?, ?, ?)")
    .run(TEAM_USER, PRO_USER, CANCELED_USER);
  await app.close();
});

describe("Team shared graph routes", () => {
  it("requires a Bearer license", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/team/search-graph",
      payload: { project: PROJECT, query: "search" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "missing_or_invalid_authorization",
    });
  });

  it("requires Team or Enterprise tier", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/team/search-graph",
      headers: auth(proToken),
      payload: { project: PROJECT, query: "search" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "team_tier_required" });
  });

  it("rejects inactive billing entitlements", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/team/search-graph",
      headers: auth(canceledToken),
      payload: { project: PROJECT, query: "search" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "inactive_license" });
  });

  it("denies projects not granted to the authenticated user", async () => {
    licensesDb
      .prepare(
        "DELETE FROM team_project_access WHERE user_id = ? AND project = ?",
      )
      .run(TEAM_USER, PROJECT);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/team/search-graph",
        headers: auth(teamToken),
        payload: { project: PROJECT, query: "search" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "project_access_denied" });
    } finally {
      licensesDb
        .prepare(
          "INSERT OR REPLACE INTO team_project_access (user_id, project) VALUES (?, ?)",
        )
        .run(TEAM_USER, PROJECT);
    }
  });

  it("returns deterministic search results from an authorized shared project", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/team/search-graph",
      headers: auth(teamToken),
      payload: { project: PROJECT, query: "search", limit: 10, offset: 0 },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(1);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      name: "searchGraph",
      qualified_name: "src.graph.searchGraph",
      file_path: "src/graph.ts",
      kind: "Function",
    });
  });

  it("returns trace data and null for an unknown function", async () => {
    const traced = await app.inject({
      method: "POST",
      url: "/v1/team/trace-path",
      headers: auth(teamToken),
      payload: {
        project: PROJECT,
        functionName: "main",
        direction: "outbound",
        depth: 3,
        mode: "calls",
        maxResults: 30,
        page: 0,
        pageSize: 12,
      },
    });

    expect(traced.statusCode).toBe(200);
    expect(traced.json()).toMatchObject({
      root: { name: "main", qualified_name: "src.cli.main" },
      direction: "outbound",
      mode: "calls",
      totalCallees: 2,
    });

    const missing = await app.inject({
      method: "POST",
      url: "/v1/team/trace-path",
      headers: auth(teamToken),
      payload: { project: PROJECT, functionName: "doesNotExist" },
    });

    expect(missing.statusCode).toBe(200);
    expect(missing.body).toBe("null");
  });

  it("rejects malformed request bodies", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/team/search-graph",
      headers: auth(teamToken),
      payload: {
        project: PROJECT,
        query: "search",
        limit: 0,
        unexpected: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("does not create a graph database for an authorized unknown project", async () => {
    licensesDb
      .prepare(
        "INSERT OR REPLACE INTO team_project_access (user_id, project) VALUES (?, ?)",
      )
      .run(TEAM_USER, UNKNOWN_PROJECT);
    const dbPath = projectDbPath(UNKNOWN_PROJECT);
    fs.rmSync(dbPath, { force: true });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/team/search-graph",
        headers: auth(teamToken),
        payload: { project: UNKNOWN_PROJECT, query: "anything" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "project_not_found" });
      expect(fs.existsSync(dbPath)).toBe(false);
    } finally {
      licensesDb
        .prepare(
          "DELETE FROM team_project_access WHERE user_id = ? AND project = ?",
        )
        .run(TEAM_USER, UNKNOWN_PROJECT);
    }
  });

  it("leaves the shared graph unchanged after read requests", async () => {
    const before = LynxDatabase.openReadOnlyProject(PROJECT);
    const countsBefore = {
      nodes: (
        before.db.prepare("SELECT COUNT(*) AS count FROM nodes").get() as {
          count: number;
        }
      ).count,
      edges: (
        before.db.prepare("SELECT COUNT(*) AS count FROM edges").get() as {
          count: number;
        }
      ).count,
    };
    before.close();

    await app.inject({
      method: "POST",
      url: "/v1/team/search-graph",
      headers: auth(teamToken),
      payload: { project: PROJECT, query: "search" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/team/trace-path",
      headers: auth(teamToken),
      payload: { project: PROJECT, functionName: "main" },
    });

    const after = LynxDatabase.openReadOnlyProject(PROJECT);
    try {
      const countsAfter = {
        nodes: (
          after.db.prepare("SELECT COUNT(*) AS count FROM nodes").get() as {
            count: number;
          }
        ).count,
        edges: (
          after.db.prepare("SELECT COUNT(*) AS count FROM edges").get() as {
            count: number;
          }
        ).count,
      };
      expect(countsAfter).toEqual(countsBefore);
      expect(after.db.pragma("query_only", { simple: true })).toBe(1);
    } finally {
      after.close();
    }
  });
});
