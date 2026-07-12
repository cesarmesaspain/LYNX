/*
 * server.ts — JSON-RPC 2.0 MCP server over stdio.
 *
 * Reads JSON-RPC requests from stdin, dispatches to tool handlers,
 * writes responses to stdout. Uses the official MCP protocol format.
 */

import { TOOLS, withEvidenceDiscipline } from './tools.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LynxToolDef } from './tools.js';
import { handlePackContext } from './handlers/pack_context.js';
import { handleSearchGraph } from './handlers/search_graph.js';
import { handleTracePath } from './handlers/trace_path.js';
import { handleGetCodeSnippet } from './handlers/get_code_snippet.js';
import { handleGetArchitecture } from './handlers/get_architecture.js';
import { handleQueryGraph } from './handlers/query_graph.js';
import { handleIndexRepository } from './handlers/index_repository.js';
import { handleIndexStatus } from './handlers/index_status.js';
import { handleDetectChanges } from './handlers/detect_changes.js';
import { handleAssessImpact } from './handlers/assess_impact.js';
import { handlePackMemory } from './handlers/pack_memory.js';
import { handleAnalyzeHotspots } from './handlers/analyze_hotspots.js';
import { handleFindDeadCode } from './handlers/find_dead_code.js';
import { handleSearchCode } from './handlers/search_code.js';
import { handleManageAdr } from './handlers/manage_adr.js';
import { handleIngestTraces } from './handlers/ingest_traces.js';
import { handleDeleteProject } from './handlers/delete_project.js';
import { handleListProjects } from './handlers/list_projects.js';
import { handleGetGraphSchema } from './handlers/get_graph_schema.js';
import { handleCompareRuns } from './handlers/compare_runs.js';
import { handleExplainSymbol } from './handlers/explain_symbol.js';
import { handleSmartReview } from './handlers/smart_review.js';
import { handleSemanticSearch } from './handlers/semantic_search.js';
import { handleWatchProject } from './handlers/watch_project.js';
import { handleFindTests } from './handlers/find_tests.js';
import { handleBatchGetCode } from './handlers/batch_get_code.js';
import { handleToolCatalog } from './handlers/tool_catalog.js';
import { decayCounter } from '../cli/hook-augment.js';
import { cleanupNativeExtractor } from '../paths.js';
import { LynxDatabase } from '../store/database.js';
import { findNearestProject } from '../discovery/project-scanner.js';
import { discoverFiles } from '../pipeline/phases/discover.js';
import { runPipeline } from '../pipeline/orchestrator.js';
import { lynxHome, readLynxConfig } from '../config/runtime.js';
import { closeAllProjectWatchers, getProjectWatcherStatus, startProjectWatcher } from '../watcher/watcher-manager.js';
import { startDashboard } from '../server/dashboard/index.js';
import { summarizeUsage } from '../usage/metrics.js';
import { resolveProjectReference } from './project-resolution.js';

// ── Handler registry ──────────────────────────────────────────

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

const STRICT_CANONICAL_PROJECT_TOOLS = new Set(['delete_project']);

const HANDLERS: Record<string, Handler> = {
  tool_catalog: handleToolCatalog,
  pack_context: handlePackContext,
  search_graph: handleSearchGraph,
  trace_path: handleTracePath,
  get_code_snippet: handleGetCodeSnippet,
  get_architecture: handleGetArchitecture,
  query_graph: handleQueryGraph,
  index_repository: handleIndexRepository,
  index_status: handleIndexStatus,
  detect_changes: handleDetectChanges,
  assess_impact: handleAssessImpact,
  pack_memory: handlePackMemory,
  analyze_hotspots: handleAnalyzeHotspots,
  find_dead_code: handleFindDeadCode,
  search_code: handleSearchCode,
  manage_adr: handleManageAdr,
  ingest_traces: handleIngestTraces,
  delete_project: handleDeleteProject,
  list_projects: handleListProjects,
  get_graph_schema: handleGetGraphSchema,
  compare_runs: handleCompareRuns,
  explain_symbol: handleExplainSymbol,
  smart_review: handleSmartReview,
  semantic_search: handleSemanticSearch,
  watch_project: handleWatchProject,
  find_tests: handleFindTests,
  batch_get_code: handleBatchGetCode,
};

const CORE_TOOL_NAMES = new Set([
  'pack_context', 'search_graph', 'get_code_snippet', 'trace_path',
  'find_tests', 'detect_changes', 'assess_impact', 'list_projects',
  'tool_catalog',
]);

// ── JSON-RPC dispatch ─────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const DB_CACHE = new Map<string, LynxDatabase>();

export function listMcpTools(): Array<Pick<LynxToolDef, 'name' | 'description' | 'inputSchema'>> {
  const profile = process.env.LYNX_TOOL_PROFILE || 'core';
  const visible = profile === 'advanced' ? TOOLS : TOOLS.filter(tool => CORE_TOOL_NAMES.has(tool.name));
  return visible.map(withEvidenceDiscipline).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function getDb(project?: string): LynxDatabase {
  const key = project || '_memory';
  if (!DB_CACHE.has(key)) {
    if (project) {
      // Try persistent project DB first
      try {
        const db = LynxDatabase.openProject(project);
        DB_CACHE.set(key, db);
        return db;
      } catch {
        // Fall through to in-memory
      }
    }
    DB_CACHE.set(key, LynxDatabase.openMemory());
  }
  return DB_CACHE.get(key)!;
}

function setDb(project: string, db: LynxDatabase): void {
  DB_CACHE.set(project, db);
}

export function normalizeProjectArgs(
  toolName: string,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; resolution?: { input: string; canonical_name: string; matched_by: 'root_path' } } | { error: string; hint: string } {
  if (typeof args.project !== 'string' || !args.project.trim()) return { args };

  const input = args.project;
  if (STRICT_CANONICAL_PROJECT_TOOLS.has(toolName) && path.isAbsolute(input)) {
    return {
      error: `Tool '${toolName}' requires the canonical project name, not a root path`,
      hint: 'Use list_projects to obtain the project name before performing this operation.',
    };
  }

  const resolved = resolveProjectReference(input);
  if (!resolved.resolved || resolved.matchedBy === 'name') return { args };
  return {
    args: { ...args, project: resolved.project },
    resolution: { input, canonical_name: resolved.project, matched_by: 'root_path' },
  };
}

function buildIndexContext(args: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof args.project !== 'string' || !args.project) return undefined;
  const meta = getDb(args.project).getProject(args.project);
  if (!meta) return undefined;
  const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(meta.indexedAt).getTime()) / 1000));
  const watcher = getProjectWatcherStatus(args.project);
  return {
    project: meta.name,
    indexed_at: meta.indexedAt,
    index_age_seconds: ageSeconds,
    freshness: meta.status === 'ready' && ageSeconds < 24 * 3600 ? 'fresh' : meta.status,
    watcher: watcher ? { active: watcher.watching, pending_changes: watcher.pendingChanges } : { active: false },
  };
}

async function dispatch(req: JsonRpcRequest): Promise<string> {
  const id = req.id;

  // ── initialize ──────────────────────────────────────────
  if (req.method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: {
        name: 'lynx',
        version: '1.0.0',
      },
    });
  }

  // ── notifications (no response) ─────────────────────────
  if (req.method === 'notifications/initialized' || req.method?.startsWith('notifications/')) {
    return ''; // No response for notifications
  }

  // ── tools/list ──────────────────────────────────────────
  if (req.method === 'tools/list') {
    return jsonRpcResult(id, {
      // Keep the registry in one response. Some desktop MCP clients do not
      // follow tools/list cursors, which silently hid every tool after #10.
      tools: listMcpTools(),
    });
  }

  // ── tools/call ──────────────────────────────────────────
  if (req.method === 'tools/call') {
    const { name, arguments: args } = (req.params || {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };

    if (!name || !HANDLERS[name]) {
      return jsonRpcError(id, -32601, `Tool not found: ${name}`);
    }

    try {
      const normalized = normalizeProjectArgs(name, args || {});
      if ('error' in normalized) {
        return jsonRpcResult(id, { content: [{ type: 'text', text: JSON.stringify(normalized, null, 2) }] });
      }
      const result = await HANDLERS[name](normalized.args);
      decayCounter(); // Any LYNX MCP tool use decays the strict-mode counter by STRICT_DECAY
      const context = buildIndexContext(normalized.args);
      const enriched = result && typeof result === 'object' && !Array.isArray(result)
        ? {
            ...result as Record<string, unknown>,
            ...(normalized.resolution ? { project_resolution: normalized.resolution } : {}),
            ...(context ? { index_context: context } : {}),
          }
        : result;
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: typeof enriched === 'string' ? enriched : JSON.stringify(enriched, null, 2) }],
      });
    } catch (err) {
      return jsonRpcError(id, -32000, String(err));
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${req.method}`);
}

// ── Run server ──────────────────────────────────────────────

export async function runServer(): Promise<void> {
  const config = readLynxConfig();
  const verificationMode = process.env.LYNX_VERIFY === '1';
  if (!verificationMode && config.auto_dashboard) {
    try {
      startDashboard();
    } catch (err) {
      console.error('[lynx] Dashboard failed to start:', String(err));
    }
  }
  if (!verificationMode) void maybeAutoIndexCurrentProject();

  let pending = 0;
  let stdinClosed = false;

  const checkDone = () => {
    if (stdinClosed && pending === 0) {
      for (const db of DB_CACHE.values()) db.close();
      closeAllProjectWatchers().catch(() => undefined);
      cleanupNativeExtractor();
      // Let stdout drain before exit — else pipe tests lose the response
      setImmediate(() => process.exit(0));
    }
  };

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.resume();

  process.stdin.on('data', (chunk: string) => {
    buf += chunk;

    // Process complete lines (newline-delimited JSON-RPC)
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);

      if (!line) continue;

      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line);
      } catch {
        // Skip malformed lines
        continue;
      }

      // notifications — fire-and-forget
      if (req.method === 'notifications/initialized' || req.method?.startsWith('notifications/')) {
        continue;
      }

      pending++;
      dispatch(req)
        .then(response => {
          if (response) return writeResponse(response);
        })
        .catch(() => {})
        .finally(() => {
          pending--;
          checkDone();
        });
    }
  });

  process.stdin.on('end', () => {
    stdinClosed = true;
    checkDone();
  });
}

export async function maybeAutoIndexCurrentProject(): Promise<void> {
  const config = readLynxConfig();
  if (!config.auto_index) return;

  const detected = findNearestProject(process.cwd());
  if (!detected) return;

  let files;
  try {
    files = discoverFiles(detected.rootPath, 'fast').files;
  } catch {
    return;
  }

  if (files.length > config.auto_index_limit) {
    console.error(
      `[lynx] auto-index skipped: ${files.length} files exceeds limit ${config.auto_index_limit}`
    );
    return;
  }

  const project = resolveProjectNameByRoot(detected.name, detected.rootPath);
  try {
    const db = LynxDatabase.openProject(project);
    try {
      const result = await runPipeline(db, detected.rootPath, project, {
        mode: 'fast',
        incremental: true,
      });
      console.error(
        `[lynx] auto-index ready: ${project} ` +
        `(${result.status.totalNodes} nodes, ${result.status.totalEdges} edges, ` +
        `${result.filesProcessed} processed, ${result.filesSkipped} skipped)`
      );
    } finally {
      db.close();
    }

    if (config.auto_watch) {
      startAutoWatcher(project, detected.rootPath);
    }

    // Welcome-back: show accumulated savings from previous sessions
    try {
      const usage = summarizeUsage(project, 1000);
      if (usage.tokens_saved > 0) {
        const f = (n: number) => new Intl.NumberFormat('en-US').format(n);
        console.error(
          `[lynx] session stats for ${project}: ` +
          `${f(usage.tokens_saved)} tokens saved, ` +
          `${f(usage.files_avoided)} files avoided ` +
          `(${f(usage.unique_files_avoided)} unique) across ${usage.events} events`
        );
      }
    } catch {
      // Stats are non-critical
    }
  } catch (err) {
    console.error(`[lynx] auto-index failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function startAutoWatcher(project: string, rootPath: string): void {
  try {
    const { alreadyRunning } = startProjectWatcher(project, rootPath, 'fast');
    if (!alreadyRunning) console.error(`[lynx] auto-watch active: ${project}`);
  } catch (err) {
    console.error(`[lynx] auto-watch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function resolveProjectNameByRoot(defaultName: string, rootPath: string): string {
  const dbsDir = path.join(lynxHome(), 'dbs');
  if (!fs.existsSync(dbsDir)) return defaultName;

  let bestName = defaultName;
  let bestNodes = -1;
  for (const file of fs.readdirSync(dbsDir)) {
    if (!file.endsWith('.db')) continue;
    const candidate = file.replace(/\.db$/, '');
    try {
      const db = LynxDatabase.openProject(candidate);
      try {
        const row = db.db.prepare(
          'SELECT root_path FROM projects WHERE name = ?'
        ).get(candidate) as { root_path: string } | undefined;
        if (!row || row.root_path !== rootPath) continue;
        const count = (db.db.prepare(
          'SELECT COUNT(*) as cnt FROM nodes WHERE project = ?'
        ).get(candidate) as { cnt: number } | undefined)?.cnt ?? 0;
        if (count > bestNodes) {
          bestName = candidate;
          bestNodes = count;
        }
      } finally {
        db.close();
      }
    } catch {
      // Ignore unreadable ghost DBs.
    }
  }
  return bestName;
}

// ── JSON-RPC formatting helpers ─────────────────────────────

function jsonRpcResult(id: number | string | undefined, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: number | string | undefined, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function writeResponse(data: string): Promise<void> {
  return new Promise((resolve) => {
    // The callback fires only once Node has accepted the complete write. A
    // simple `write() === true` check can still lose large tool registries
    // when the server exits immediately after stdin closes.
    process.stdout.write(data + '\n', () => resolve());
  });
}

/**
 * unsetDb — remove a project's DB from the in-process cache.
 *
 * Intended for test teardown; production callers should normally rely
 * on process lifecycle. If `opts.close` is true and the cached DB is
 * an in-memory database, it is closed exactly once and the cache entry
 * is deleted — no closed DB remains stored.
 */
function unsetDb(project: string, opts?: { close?: boolean }): void {
  const old = DB_CACHE.get(project);
  if (opts?.close && old && old.dbPath === ':memory:') {
    try { old.close(); } catch { /* ok */ }
  }
  DB_CACHE.delete(project);
}

/** Close all cached project DBs and clear the cache. Used by test teardown. */
export function closeProjectDbs(): void {
  for (const db of DB_CACHE.values()) {
    try { db.close(); } catch { /* ok */ }
  }
  DB_CACHE.clear();
}

// Expose for handlers
export { getDb, setDb, unsetDb };
