/*
 * dashboard/server.ts — HTTP server for the local LYNX dashboard.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { URL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { lynxHome, readLynxConfig, readLynxConfigSafe, upsertLynxConfig } from '../../config/runtime.js';
import { LynxDatabase } from '../../store/database.js';
import { runPipeline } from '../../pipeline/orchestrator.js';
import { collectProjectCards, collectActionGraph, getSavingsLabScenarios } from './data.js';
import { renderDashboard } from './html.js';
import { readRequestBody, pickFolderNative, RequestBodyTooLargeError } from './utils.js';
import { getTimeWindows, type TimeWindow } from '../../usage/aggregation.js';
import { getCachedMetrics } from '../../usage/cache.js';
import { closeAllProjectWatchers } from '../../watcher/watcher-manager.js';
import { clearProjectMetrics } from '../../store/metrics-db.js';
import { clearUsageEvents } from '../../usage/metrics.js';
import { invalidateProject } from '../../usage/cache.js';

const PORT = parseInt(process.env.LYNX_DASHBOARD_PORT || '9191', 10);
let _server: http.Server | null = null;
let _wss: WebSocketServer | null = null;
let _watchFs: fs.FSWatcher | null = null;
let _watchHome: fs.FSWatcher | null = null;
let _dashboardRetry: ReturnType<typeof setTimeout> | null = null;

// A short, bounded recovery window covers the common case where an agent is
// restarting while an older dashboard process is still releasing the port.
// It deliberately is not an infinite loop: another application may own 9191.
const DASHBOARD_RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000];

function retryDashboard(port: number, attempt: number): void {
  if (_server || _dashboardRetry) return;
  const delay = DASHBOARD_RETRY_DELAYS_MS[attempt];
  if (delay === undefined) {
    console.error(`[lynx] Dashboard port ${port} remained unavailable after ${attempt} retries.`);
    return;
  }
  _dashboardRetry = setTimeout(() => {
    _dashboardRetry = null;
    if (!_server) startDashboard(port, attempt + 1);
  }, delay);
  _dashboardRetry.unref();
}

// ── Rate limiter: max 1 req/sec per IP for /api/projects ──────────
const _rateMap = new Map<string, number>();
function _rateLimit(ip: string): boolean {
  const now = Date.now();
  const last = _rateMap.get(ip) || 0;
  if (now - last < 1000) return false;
  _rateMap.set(ip, now);
  // Cleanup stale entries every 60s
  if (_rateMap.size > 200) {
    for (const [k, v] of _rateMap) if (now - v > 60000) _rateMap.delete(k);
  }
  return true;
}

function writeJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function writeHtml(res: http.ServerResponse, html: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function isValidProjectName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && !/[\/\\]/.test(name);
}

async function handleApiProjectsAdd(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readRequestBody(req);
  let parsed: { project_name?: string; project_path?: string };
  try { parsed = JSON.parse(body); } catch {
    writeJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  const { project_name, project_path } = parsed;
  if (!project_name || !project_path) {
    writeJson(res, 400, { error: 'project_name and project_path are required' });
    return;
  }
  if (!isValidProjectName(project_name)) {
    writeJson(res, 400, { error: 'Invalid project_name. Use alphanumeric characters, hyphens, and underscores only.' });
    return;
  }
  if (!fs.existsSync(project_path)) {
    writeJson(res, 400, { error: `Path does not exist: ${project_path}` });
    return;
  }

  const dbName = project_name.toLowerCase() === 'lynx' ? 'lynx-project' : project_name;
  const db = LynxDatabase.openProject(dbName);
  runPipeline(db, project_path, dbName, { mode: 'fast' })
    .then((result) => {
      console.error(`[dashboard] Indexed new project "${dbName}": ${result.status.totalNodes} nodes, ${result.status.totalEdges} edges`);
      db.close();
    })
    .catch((err) => {
      console.error(`[dashboard] Index failed for "${dbName}":`, String(err));
      try { db.close(); } catch { /* ignore */ }
    });
  writeJson(res, 202, { ok: true, project_name: dbName, message: 'Indexing started. Refresh to see updates.' });
}

async function handleApiProjectsDelete(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readRequestBody(req);
  let parsed: { project_name?: string };
  try { parsed = JSON.parse(body); } catch {
    writeJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  const { project_name } = parsed;
  if (!project_name) {
    writeJson(res, 400, { error: 'project_name is required' });
    return;
  }
  if (!isValidProjectName(project_name)) {
    writeJson(res, 400, { error: 'Invalid project_name.' });
    return;
  }
  const dbsDir = path.join(lynxHome(), 'dbs');
  const dbPath = path.join(dbsDir, project_name + '.db');
  if (!fs.existsSync(dbPath)) {
    writeJson(res, 404, { error: `Project "${project_name}" not found` });
    return;
  }
  const db = LynxDatabase.openProject(project_name);
  try {
    const nodeCount = (db.db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?').get(project_name) as { cnt: number }).cnt;
    const edgeCount = (db.db.prepare('SELECT COUNT(*) as cnt FROM edges WHERE project = ?').get(project_name) as { cnt: number }).cnt;
    db.deleteProject(project_name);
    writeJson(res, 200, { ok: true, deleted: project_name, nodes_removed: nodeCount, edges_removed: edgeCount });
  } finally {
    db.close();
  }
}

async function handleApiMetrics(res: http.ServerResponse, url: URL): Promise<void> {
  const project = url.searchParams.get('project') || '';
  const window = (url.searchParams.get('window') || 'total') as TimeWindow;
  const format = url.searchParams.get('format') || 'json';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(url.searchParams.get('page_size') || '100', 10) || 100));

  try {
    const data = getCachedMetrics(project, window);
    const avoidedInputUsdPer1m = readLynxConfig().savings_pricing?.avoided_input_usd_per_1m || 0;
    const avoidedCostUsd = (Number(data.totals.tokens_saved || 0) / 1_000_000) * avoidedInputUsdPer1m;
    const monetary = {
      avoided_input_usd_per_1m: avoidedInputUsdPer1m,
      avoided_cost_usd: avoidedCostUsd,
      net_savings_usd: avoidedCostUsd - Number(data.totals.llm_cost_usd || 0),
    };

    if (format === 'csv') {
      const csv = metricsToCsv(data);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="lynx-metrics-${project || 'all'}-${window}.csv"`,
      });
      res.end(csv);
      return;
    }

    const allCategories = data.categories;
    const totalCategories = allCategories.length;
    const start = (page - 1) * pageSize;
    const pagedCategories = allCategories.slice(start, start + pageSize);

    writeJson(res, 200, {
      ...data,
      monetary,
      categories: pagedCategories,
      pagination: {
        page,
        page_size: pageSize,
        total_categories: totalCategories,
        total_pages: Math.ceil(totalCategories / pageSize),
        has_more: start + pageSize < totalCategories,
      },
    });
  } catch (err) {
    writeJson(res, 500, { error: 'Metrics query failed: ' + String(err) });
  }
}

function handleApiDiagnostics(res: http.ServerResponse): void {
  const cards = collectProjectCards();
  const cfg = readLynxConfig();
  const diag = {
    generated_at: new Date().toISOString(),
    projects: cards.map(c => ({
      name: c.name, freshness: c.freshness, status: c.status,
      statusError: c.statusError, nodes: c.nodes, edges: c.edges,
      filesIndexed: c.filesIndexed, dbSizeBytes: c.dbSizeBytes,
      hoursSinceIndex: c.hoursSinceIndex, llmCalls: c.llmCalls,
      llmCostUsd: c.llmCostUsd, errorCount: c.errorCount, lastIndexed: c.lastIndexed,
    })),
    config: {
      auto_index: cfg.auto_index, auto_index_limit: cfg.auto_index_limit,
      auto_watch: cfg.auto_watch, stale_threshold_hours: cfg.stale_threshold_hours,
      locale: cfg.locale,
    },
    runtime: {
      node: process.version, pid: process.pid,
      uptime_seconds: Math.round(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    },
  };
  writeJson(res, 200, diag);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    await routeRequest(req, res, url);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      writeJson(res, 413, { error: err.message });
      return;
    }
    writeJson(res, 500, { error: 'Dashboard render error: ' + String(err) });
  }
}

async function routeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  if (await handleMutationRoute(req, res, url)) return;

  if (url.pathname === '/api/action-graph') {
    const project = url.searchParams.get('project') || '';
    const mode = url.searchParams.get('mode') || 'value';
    try {
      const graph = collectActionGraph(project, mode);
      writeJson(res, 200, graph);
    } catch (err) {
      writeJson(res, 404, { error: `Project "${project}" not found or not indexed yet.`, details: String(err) });
    }
    return;
  }

  if (url.pathname === '/api/projects') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!_rateLimit(ip)) {
      writeJson(res, 429, { error: 'Too many requests. Wait 1 second.' });
      return;
    }
    writeJson(res, 200, collectProjectCards());
    return;
  }

  if (url.pathname === '/api/pick-folder') {
    try {
      const folderPath = pickFolderNative();
      writeJson(res, 200, folderPath ? { path: folderPath } : { path: null, cancelled: true });
    } catch (err) {
      writeJson(res, 500, { error: String(err) });
    }
    return;
  }

  if (url.pathname === '/api/savings-lab') {
    writeJson(res, 200, getSavingsLabScenarios(readLynxConfig().locale));
    return;
  }

  if (url.pathname === '/api/metrics') {
    await handleApiMetrics(res, url);
    return;
  }

  if (url.pathname === '/api/metrics/windows') {
    writeJson(res, 200, getTimeWindows());
    return;
  }

  if (url.pathname === '/api/health') {
    writeJson(res, 200, { ok: true, uptime: process.uptime(), pid: process.pid, memory_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)) });
    return;
  }

  if (url.pathname === '/api/diagnostics') {
    handleApiDiagnostics(res);
    return;
  }

  if (url.pathname === '/api/config' && req.method === 'GET') {
    writeJson(res, 200, readLynxConfigSafe());
    return;
  }

  // Fallback: render dashboard HTML
  writeHtml(res, renderDashboard(collectProjectCards()));
}

async function handleMutationRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/api/lynx-enabled' && req.method === 'POST') {
    const body = await readRequestBody(req);
    try {
      const value = JSON.parse(body) as { enabled?: unknown };
      if (typeof value.enabled !== 'boolean') throw new Error('enabled must be boolean');
      upsertLynxConfig({ enabled: value.enabled });
      if (!value.enabled) await closeAllProjectWatchers();
      writeJson(res, 200, { ok: true, enabled: value.enabled, restart_required: true });
    } catch {
      writeJson(res, 400, { error: 'Invalid enabled value' });
    }
    return true;
  }
  if (url.pathname === '/api/projects/add' && req.method === 'POST') {
    await handleApiProjectsAdd(req, res);
    return true;
  }
  if (url.pathname === '/api/projects/delete' && req.method === 'POST') {
    await handleApiProjectsDelete(req, res);
    return true;
  }
  if (url.pathname === '/api/agent-response' && req.method === 'GET') {
    writeJson(res, 200, readLynxConfig().agent_response || null);
    return true;
  }
  if (url.pathname === '/api/agent-response' && req.method === 'POST') {
    const body = await readRequestBody(req);
    try {
      const value = JSON.parse(body);
      upsertLynxConfig({ agent_response: value });
      writeJson(res, 200, { ok: true, agent_response: value });
    } catch {
      writeJson(res, 400, { error: 'Invalid JSON body' });
    }
    return true;
  }
  if (url.pathname === '/api/config' && req.method === 'POST') {
    const body = await readRequestBody(req);
    try {
      const values = JSON.parse(body);
      upsertLynxConfig(values);
      writeJson(res, 200, { ok: true });
    } catch {
      writeJson(res, 400, { error: 'Invalid JSON body' });
    }
    return true;
  }
  if (url.pathname === '/api/metrics/clear' && req.method === 'POST') {
    const body = await readRequestBody(req);
    let parsed: { project?: string };
    try { parsed = JSON.parse(body); } catch {
      writeJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const project = parsed.project || undefined;
    if (project && !isValidProjectName(project)) {
      writeJson(res, 400, { error: 'Invalid project name' });
      return true;
    }
    try {
      const dbResult = clearProjectMetrics(project);
      const jsonlRemoved = clearUsageEvents(project);
      if (project) invalidateProject(project);
      writeJson(res, 200, {
        ok: true,
        project: project || null,
        deleted: { events_archive: dbResult.events, daily_snapshots: dbResult.snapshots, usage_jsonl: jsonlRemoved },
      });
    } catch (err) {
      writeJson(res, 500, { error: 'Failed to clear metrics: ' + String(err) });
    }
    return true;
  }
  if (url.pathname === '/api/locale' && req.method === 'POST') {
    const locale = url.searchParams.get('locale');
    if (locale !== 'es' && locale !== 'en') writeJson(res, 400, { error: 'locale must be es or en' });
    else {
      upsertLynxConfig({ locale });
      writeJson(res, 200, { ok: true, locale });
    }
    return true;
  }
  return false;
}

export function startDashboard(port = PORT, retryAttempt = 0): http.Server {
  if (_server) return _server;

  const server = http.createServer(handleRequest);
  // Claim startup immediately so concurrent callers (for example a retry and
  // the service health loop) cannot create competing HTTP servers.
  _server = server;

  function setupRealtime() {
    // WebSocket server sharing the same HTTP server.
    const wss = new WebSocketServer({ server, path: '/ws' });
    _wss = wss;
    const clients = new Set<WebSocket>();

    wss.on('connection', (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    });

    function broadcastUpdate() {
      if (clients.size === 0) return;
      const cards = collectProjectCards();
      const briefPayload = Object.fromEntries(cards
        .filter((c) => c.brief)
        .map((c) => [c.name, {
          brief: c.brief?.brief || '',
          generated_at: c.brief?.generated_at || '',
        }]));
      const body = JSON.stringify({ type: 'cards_updated', cards, briefs: briefPayload });
      for (const ws of clients) {
        if (ws.readyState === 1 /* OPEN */) {
          ws.send(body);
        }
      }
    }

    // File watcher on dbs directory — push updates on index/brief changes.
    const dbsDir = path.join(lynxHome(), 'dbs');
    if (!fs.existsSync(dbsDir)) {
      fs.mkdirSync(dbsDir, { recursive: true });
    }
    let watchDebounce: ReturnType<typeof setTimeout> | null = null;
    const scheduleBroadcast = () => {
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(broadcastUpdate, 800);
    };
    _watchFs = fs.watch(dbsDir, (_eventType, filename) => {
      if (!filename || (!filename.endsWith('.db') && !filename.endsWith('.db-wal'))) return;
      scheduleBroadcast();
    });

    // Second watcher on lynxHome for metrics.db / usage.jsonl changes.
    try {
      _watchHome = fs.watch(lynxHome(), (_eventType, filename) => {
        if (!filename || (filename !== 'metrics.db' && filename !== 'metrics.db-wal' && filename !== 'usage.jsonl')) return;
        scheduleBroadcast();
      });
    } catch { /* home dir might not exist yet */ }
  }

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[lynx] Dashboard port ${port} in use — retrying when it is released.`);
      if (_server === server) _server = null;
      retryDashboard(port, retryAttempt);
      return;
    }
    console.error(`[lynx] Dashboard error:`, err.message);
  });

  server.on('close', () => {
    _wss?.close();
    _wss = null;
    _watchFs?.close();
    _watchFs = null;
    _watchHome?.close();
    _watchHome = null;
    if (_server === server) _server = null;
  });

  server.listen(port, '127.0.0.1', () => {
    console.error(`[lynx] Dashboard: http://localhost:${port}  ws://localhost:${port}/ws`);
    setupRealtime();
  });

  return server;
}

export function isDashboardListening(): boolean {
  return _server?.listening === true;
}

export function stopDashboard(): void {
  if (_dashboardRetry) {
    clearTimeout(_dashboardRetry);
    _dashboardRetry = null;
  }
  const server = _server;
  _server = null;
  if (server?.listening) server.close();
}

// ── CSV export ─────────────────────────────────────────────────

import type { WindowedMetrics } from '../../usage/aggregation.js';

function metricsToCsv(data: WindowedMetrics): string {
  const lines: string[] = [];

  // Header section with metadata
  lines.push('# LYNX Metrics Export');
  lines.push(`# Window: ${data.window}`);
  lines.push(`# Period: ${data.since} — ${data.until}`);
  lines.push(`# Computed: ${data.computed_at}`);
  lines.push('');

  // Totals — derive provenance from the metrics array
  const provByKey = new Map(data.metrics.map(m => [m.key, m.provenance.kind]));
  const p = (key: string) => provByKey.get(key) || 'measured';
  lines.push('## Totals');
  lines.push('metric,value,unit,provenance,category');
  lines.push(`tokens_saved,${data.totals.tokens_saved},tokens,${p('tokens_saved')},total`);
  lines.push(`files_avoided,${data.totals.files_avoided},files,${p('files_avoided')},total`);
  lines.push(`unique_files_avoided,${data.totals.unique_files_avoided},files,${p('unique_files')},total`);
  lines.push(`events,${data.totals.events},events,${p('events')},total`);
  lines.push(`llm_events,${data.totals.llm_events},events,${p('llm_events')},total`);
  lines.push(`llm_cost_usd,${data.totals.llm_cost_usd},USD,${p('llm_cost')},total`);
  lines.push(`sessions,${data.totals.sessions},sessions,${p('sessions')},total`);
  lines.push(`tasks,${data.totals.tasks},tasks,${p('tasks')},total`);
  lines.push(`deterministic_events,${data.totals.deterministic_events},events,measured,total`);
  lines.push('');

  // Category breakdown
  lines.push('## Categories (mutually exclusive)');
  lines.push('category,label,tokens_saved,files_avoided,events,latency_ms');
  for (const c of data.categories) {
    lines.push(`${c.category},"${c.label}",${c.tokens_saved},${c.files_avoided},${c.events},${c.latency_ms}`);
  }
  lines.push('');

  // Metrics with provenance
  lines.push('## Metrics');
  lines.push('key,label,value,unit,kind,formula,confidence,sample_size');
  for (const m of data.metrics) {
    const formula = m.provenance.formula ? `"${m.provenance.formula.replace(/"/g, '""')}"` : '';
    lines.push(`${m.key},"${m.label}",${m.value},${m.unit},${m.provenance.kind},${formula},${m.provenance.confidence},${m.provenance.sample_size}`);
  }
  lines.push('');

  // Coverage
  lines.push('## Telemetry Coverage');
  lines.push('event_coverage,sessions_tracked,tasks_tracked,llm_active,deterministic_mode,summary');
  lines.push(`${data.coverage.event_coverage},${data.coverage.sessions_tracked},${data.coverage.tasks_tracked},${data.coverage.llm_tracking_active},${data.coverage.deterministic_mode},"${data.coverage.summary}"`);

  return lines.join('\n') + '\n';
}
