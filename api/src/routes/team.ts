/*
 * team.ts — Read-only shared graph endpoints for Team federation.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveLicenseAccess } from "../license-access.js";
import { licensesDb } from "../db.js";
import { LynxDatabase } from "../../../dist/store/database.js";
import { executeLocalSearchGraph } from "../../../dist/federation/search-core.js";
import { executeLocalTracePath } from "../../../dist/federation/trace-core.js";
import type {
  FederatedSearchParams,
  FederatedTraceParams,
} from "../../../dist/federation/types.js";

type JsonRecord = Record<string, unknown>;

const SEARCH_FIELDS = new Set([
  "project",
  "query",
  "label",
  "namePattern",
  "qnPattern",
  "nameLike",
  "qnLike",
  "filePattern",
  "limit",
  "offset",
  "minDegree",
  "maxDegree",
  "excludeEntryPoints",
  "hasSemanticQuery",
]);

const TRACE_FIELDS = new Set([
  "functionName",
  "project",
  "direction",
  "depth",
  "mode",
  "riskLabels",
  "includeTests",
  "customEdgeTypes",
  "maxResults",
  "page",
  "pageSize",
]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyFields(body: JsonRecord, allowed: Set<string>): boolean {
  return Object.keys(body).every((key) => allowed.has(key));
}

function optionalString(
  body: JsonRecord,
  key: string,
): string | undefined | null {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function integerInRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    return null;
  return value;
}

function optionalNonNegativeInteger(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    return null;
  return value;
}

function optionalBoolean(value: unknown, fallback = false): boolean | null {
  if (value === undefined) return fallback;
  return typeof value === "boolean" ? value : null;
}

function authorizeTeam(
  request: FastifyRequest,
):
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; error: string } {
  const authorization = request.headers.authorization;
  const match =
    typeof authorization === "string"
      ? /^Bearer\s+(.+)$/i.exec(authorization)
      : null;
  if (!match)
    return {
      ok: false,
      status: 401,
      error: "missing_or_invalid_authorization",
    };

  const access = resolveLicenseAccess(match[1].trim());
  if (!access.license)
    return {
      ok: false,
      status: 401,
      error: access.reason || "invalid_license",
    };
  if (access.license.tier !== "team" && access.license.tier !== "enterprise") {
    return { ok: false, status: 403, error: "team_tier_required" };
  }
  return { ok: true, userId: access.license.sub };
}

function hasProjectAccess(userId: string, project: string): boolean {
  return Boolean(
    licensesDb
      .prepare(
        "SELECT 1 FROM team_project_access WHERE user_id = ? AND project = ?",
      )
      .get(userId, project),
  );
}

function parseSearchBody(value: unknown): FederatedSearchParams | null {
  if (!isRecord(value) || !hasOnlyFields(value, SEARCH_FIELDS)) return null;

  const project = optionalString(value, "project");
  const query = optionalString(value, "query");
  const label = optionalString(value, "label");
  const namePattern = optionalString(value, "namePattern");
  const qnPattern = optionalString(value, "qnPattern");
  const nameLike = optionalString(value, "nameLike");
  const qnLike = optionalString(value, "qnLike");
  const filePattern = optionalString(value, "filePattern");
  if (
    !project ||
    query === null ||
    label === null ||
    namePattern === null ||
    qnPattern === null ||
    nameLike === null ||
    qnLike === null ||
    filePattern === null
  )
    return null;

  const limit = integerInRange(value.limit, 10, 1, 1000);
  const offset = integerInRange(value.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const minDegree = optionalNonNegativeInteger(value.minDegree);
  const maxDegree = optionalNonNegativeInteger(value.maxDegree);
  const excludeEntryPoints = optionalBoolean(value.excludeEntryPoints);
  const hasSemanticQuery = optionalBoolean(value.hasSemanticQuery);
  if (
    limit === null ||
    offset === null ||
    minDegree === null ||
    maxDegree === null ||
    excludeEntryPoints === null ||
    hasSemanticQuery === null
  )
    return null;
  if (
    minDegree !== undefined &&
    maxDegree !== undefined &&
    minDegree > maxDegree
  )
    return null;

  return {
    project,
    query,
    label,
    namePattern,
    qnPattern,
    nameLike,
    qnLike,
    filePattern,
    limit,
    offset,
    minDegree,
    maxDegree,
    excludeEntryPoints,
    hasSemanticQuery,
  };
}

function parseTraceBody(value: unknown): FederatedTraceParams | null {
  if (!isRecord(value) || !hasOnlyFields(value, TRACE_FIELDS)) return null;

  const functionName = optionalString(value, "functionName");
  const project = optionalString(value, "project");
  if (!functionName || !project) return null;

  const direction = value.direction === undefined ? "both" : value.direction;
  if (
    direction !== "inbound" &&
    direction !== "outbound" &&
    direction !== "both"
  )
    return null;

  const mode = value.mode === undefined ? "calls" : value.mode;
  if (
    !["calls", "references", "data_flow", "cross_service", "auto"].includes(
      String(mode),
    )
  )
    return null;

  const depth = integerInRange(value.depth, 3, 1, 10);
  const riskLabels = optionalBoolean(value.riskLabels);
  const includeTests = optionalBoolean(value.includeTests);
  const maxResults = integerInRange(value.maxResults, 30, 1, 100);
  const page = integerInRange(value.page, 0, 0, Number.MAX_SAFE_INTEGER);
  if (
    depth === null ||
    riskLabels === null ||
    includeTests === null ||
    maxResults === null ||
    page === null
  )
    return null;

  const pageSize = integerInRange(
    value.pageSize,
    Math.min(maxResults, 12),
    1,
    Math.min(maxResults, 100),
  );
  if (pageSize === null) return null;

  let customEdgeTypes: string[] | undefined;
  if (value.customEdgeTypes !== undefined) {
    if (
      !Array.isArray(value.customEdgeTypes) ||
      value.customEdgeTypes.some(
        (entry) => typeof entry !== "string" || !entry.trim(),
      )
    )
      return null;
    customEdgeTypes = [
      ...new Set(value.customEdgeTypes.map((entry) => entry.trim())),
    ];
  }

  return {
    functionName,
    project,
    direction,
    depth,
    mode: String(mode),
    riskLabels,
    includeTests,
    customEdgeTypes,
    maxResults,
    page,
    pageSize,
  };
}

function openProject(project: string): LynxDatabase | null {
  try {
    const db = LynxDatabase.openReadOnlyProject(project);
    if (!db.getProject(project)) {
      db.close();
      return null;
    }
    return db;
  } catch {
    return null;
  }
}

export function teamRoutes(app: FastifyInstance): void {
  app.post("/v1/team/search-graph", async (request, reply) => {
    const authorization = authorizeTeam(request);
    if (!authorization.ok)
      return reply
        .status(authorization.status)
        .send({ error: authorization.error });

    const params = parseSearchBody(request.body);
    if (!params) return reply.status(400).send({ error: "invalid_request" });
    if (!hasProjectAccess(authorization.userId, params.project)) {
      return reply.status(403).send({ error: "project_access_denied" });
    }

    const db = openProject(params.project);
    if (!db) return reply.status(404).send({ error: "project_not_found" });
    try {
      return reply.send(executeLocalSearchGraph(db, params));
    } finally {
      db.close();
    }
  });

  app.post("/v1/team/trace-path", async (request, reply) => {
    const authorization = authorizeTeam(request);
    if (!authorization.ok)
      return reply
        .status(authorization.status)
        .send({ error: authorization.error });

    const params = parseTraceBody(request.body);
    if (!params) return reply.status(400).send({ error: "invalid_request" });
    if (!hasProjectAccess(authorization.userId, params.project)) {
      return reply.status(403).send({ error: "project_access_denied" });
    }

    const db = openProject(params.project);
    if (!db) return reply.status(404).send({ error: "project_not_found" });
    try {
      return reply.send(executeLocalTracePath(db, params));
    } finally {
      db.close();
    }
  });
}
