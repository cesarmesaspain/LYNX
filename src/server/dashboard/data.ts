/*
 * dashboard/data.ts — Data collection functions for the LYNX dashboard.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { lynxHome, readLynxConfig } from '../../config/runtime.js';
import { summarizeUsage, computeSemanticROI, readUsageEvents } from '../../usage/metrics.js';
import { aggregateTotal } from '../../usage/aggregation.js';
import { getCachedMetrics, invalidateProject } from '../../usage/cache.js';
import { LynxDatabase } from '../../store/database.js';
import { storedTimestampMs } from '../../store/time.js';
import { summarizeHistory, flushTodayEvents } from '../../store/metrics-db.js';
import { getProjectBrief, type ProjectBriefRow } from '../../intelligence/project-brief.js';
import { isProjectLocked } from '../../store/lock.js';

export interface ProjectCard {
  name: string;
  /** Display-friendly name: normalizes "lynx" to "LYNX" */
  displayName: string;
  dbPath: string;
  nodes: number;
  edges: number;
  edgeTypes: number;
  filesIndexed: number;
  entryPoints: number;
  hotspots: number;
  riskyNodes: number;
  tokensSaved: number;
  filesAvoided: number;
  uniqueFiles: number;
  semanticROI: number | null;
  semanticTopChanged: number;
  semanticEvents: number;
  lastIndexed: string | null;

  // ── Phase 6: Operational fields ─────────────────────────
  freshness: 'ready' | 'stale' | 'updating' | 'failed' | 'unknown';
  status: string | null;
  statusError: string | null;
  dbSizeBytes: number;
  indexDurationMs: number | null;
  hoursSinceIndex: number | null;
  llmProvider: string | null;
  llmModel: string | null;
  llmCalls: number;
  llmTokensUsed: number;
  llmCostUsd: number;
  errorCount: number;
  brief: ProjectBriefRow | null;
}
export interface HotspotRow {
  name: string;
  qualified_name: string;
  file_path: string;
  complexity: number;
  fan_in: number;
}

export interface RouteRow {
  url_path: string;
  http_method: string;
  file_path: string;
  line: number;
}

export interface ActionGraphNode {
  id: number;
  name: string;
  qn: string;
  kind: string;
  file: string;
  x: number;
  y: number;
  z: number;
  size: number;
  color: string;
  role: 'entry' | 'hotspot' | 'value' | 'risk' | 'code';
  fanIn: number;
  fanOut: number;
  risk: number;
  tokens: number;
  why: string;
  action: string;
  riskText: string;
  callers: string[];
  callees: string[];
}

export interface ActionGraphEdge {
  source: number;
  target: number;
  type: string;
}

export interface ActionGraph {
  project: string;
  mode: string;
  nodes: ActionGraphNode[];
  edges: ActionGraphEdge[];
  total_nodes: number;
  total_edges: number;
  role_counts: Record<string, number>;
  narrative: string;
}

export interface ActionGraphRow {
  id: number;
  name: string;
  qualified_name: string;
  kind: string;
  file_path: string;
  is_entry_point: number;
  properties: string;
  fan_in: number;
  fan_out: number;
}

export interface SavingsScenario {
  id: string;
  title: string;
  description: string;
  team: string;
  withoutLynx: {
    discoveryTokens: number;
    timeSeconds: number;
    operations: number;
    hallucinations: number;
    reworkMinutes: number;
    iterations: number;
  };
  withLynx: {
    discoveryTokens: number;
    timeSeconds: number;
    operations: number;
    hallucinations: number;
    reworkMinutes: number;
    iterations: number;
  };
  savings: {
    tokens: number;
    timeSeconds: number;
    operations: number;
    dollarsPerMonth: number;
    hoursPerMonth: number;
    mainWin: string;
  };
  dimensions: Array<{ label: string; saving: string }>;
}
const _cardsCache = new Map<string, { cards: ProjectCard[]; ts: number }>();
const CARDS_CACHE_TTL_MS = 500;

export function invalidateCardsCache(): void {
  _cardsCache.clear();
}

export function collectProjectCards(): ProjectCard[] {
  const cacheKey = '__global__';
  const cached = _cardsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CARDS_CACHE_TTL_MS) return cached.cards;

  const cards: ProjectCard[] = [];
  const dbsDir = path.join(lynxHome(), 'dbs');
  if (!fs.existsSync(dbsDir)) return cards;

  for (const file of fs.readdirSync(dbsDir)) {
    if (!file.endsWith('.db')) continue;
    const project = file.replace(/\.db$/, '');
    const dbPath = path.join(dbsDir, file);
    try {
      const db = LynxDatabase.openProject(project);
      let nodes = 0;
      let edges = 0;
      let edgeTypes = 0;
      let filesIndexed = 0;
      let entryPoints = 0;
      let hotspotsCount = 0;
      let riskyNodes = 0;
      let lastIndexed: string | null = null;
      let brief: ProjectBriefRow | null = null;
let projectStatus: string | null = null;
let projectStatusError: string | null = null;
	let freshness: ProjectCard["freshness"] = 'unknown';
	let dbSizeBytes = 0;
	let indexDurationMs: number | null = null;
	let hoursSinceIndex: number | null = null;

      try {
        nodes = (
          db.db
            .prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?')
            .get(project) as { cnt: number }
        ).cnt;
        edges = (
          db.db
            .prepare('SELECT COUNT(*) as cnt FROM edges WHERE project = ?')
            .get(project) as { cnt: number }
        ).cnt;
        edgeTypes = (
          db.db
            .prepare(
              'SELECT COUNT(DISTINCT type) as cnt FROM edges WHERE project = ?'
            )
            .get(project) as { cnt: number }
        ).cnt;
        filesIndexed = (
          db.db
            .prepare('SELECT COUNT(*) as cnt FROM file_hashes WHERE project = ?')
            .get(project) as { cnt: number }
        ).cnt;
        entryPoints = (
          db.db
            .prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND is_entry_point = 1')
            .get(project) as { cnt: number }
        ).cnt;
        const riskStats = db.db.prepare(`
          WITH degree AS (
            SELECT n.id,
              COALESCE((SELECT COUNT(*) FROM edges e WHERE e.project = n.project AND e.target_id = n.id), 0) AS fan_in,
              COALESCE((SELECT COUNT(*) FROM edges e WHERE e.project = n.project AND e.source_id = n.id), 0) AS fan_out
            FROM nodes n
            WHERE n.project = ? AND n.kind NOT IN ('Folder')
          )
          SELECT
            SUM(CASE WHEN fan_in + fan_out >= 30 THEN 1 ELSE 0 END) AS hotspots,
            SUM(CASE WHEN fan_in >= 10 THEN 1 ELSE 0 END) AS risky
          FROM degree
        `).get(project) as { hotspots: number | null; risky: number | null };
        hotspotsCount = riskStats.hotspots || 0;
        riskyNodes = riskStats.risky || 0;

        const meta = db.db
          .prepare('SELECT indexed_at, status, status_error FROM projects WHERE name = ?')
          .get(project) as { indexed_at?: string; status?: string; status_error?: string | null } | undefined;
        lastIndexed = meta?.indexed_at || null;
        projectStatus = meta?.status || null;
        projectStatusError = meta?.status_error || null;
        brief = getProjectBrief(db, project);

        // Phase 6: compute freshness and operational metrics while db is open
        if (nodes > 0 && lastIndexed) {
          const projStatus = projectStatus || 'ready';
          if (projStatus === 'failed') {
            freshness = 'failed';
          } else if (isProjectLocked(project) || projStatus === 'updating') {
            freshness = 'updating';
          } else {
            const cfg = readLynxConfig();
            const ageHours = (Date.now() - storedTimestampMs(lastIndexed)) / (1000 * 60 * 60);
            freshness = ageHours > cfg.stale_threshold_hours ? 'stale' : 'ready';
          }
        }

        dbSizeBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
        hoursSinceIndex = lastIndexed
          ? Math.max(0, Math.round((Date.now() - storedTimestampMs(lastIndexed)) / (1000 * 60 * 60)))
          : null;
      } finally {
        db.close();
      }

      // Use aggregateTotal as canonical source (events_archive + JSONL, deduped).
      // Replaces the old summarizeUsage + summarizeHistory dual-source path which
      // could diverge when snapshots were stale/corrupted.
      const agg = aggregateTotal(project);
      const tokensSaved = agg.totals.tokens_saved;
      const filesAvoided = agg.totals.files_avoided;

      // Keep legacy summary paths for fields not yet in aggregateTotal
      const recent = summarizeUsage(project, 2000);

      // flushTodayEvents keeps daily_snapshots in sync with events_archive.
      flushTodayEvents(project);
      const history = summarizeHistory(project, 90);

      // LLM usage from recent events
      const recentEvents = readUsageEvents(project, 100);
      const llmEvents = recentEvents.filter(e => e.llm_provider && e.llm_provider !== 'heuristic');
      const llmProvider = llmEvents.length > 0 ? llmEvents[0].llm_provider || null : null;
      const llmModel = null; // Not tracked in usage events currently
      const llmCalls = agg.totals.llm_events;
      const llmTokensUsed = 0; // Not tracked per-event
      const llmCostUsd = agg.totals.llm_cost_usd;

      // Error count from recent failures
      const errorCount = recentEvents.filter(e =>
        (e as any).error != null
      ).length;

      cards.push({
        name: project,
        displayName: project === 'lynx' ? 'LYNX' : project,
        dbPath,
        nodes,
        edges,
        edgeTypes,
        filesIndexed,
        entryPoints,
        hotspots: hotspotsCount,
        riskyNodes,
        // Canonical: from aggregateTotal (events_archive + JSONL, deduped)
        tokensSaved,
        filesAvoided,
        uniqueFiles: agg.totals.unique_files_avoided,
        semanticROI: recent.semantic_roi,
        semanticTopChanged: agg.totals.llm_events,
        semanticEvents: agg.totals.llm_events,
        lastIndexed,
        // Phase 6 fields
        freshness,
        status: projectStatus,
        statusError: projectStatusError,
        dbSizeBytes,
        indexDurationMs,
        hoursSinceIndex,
        llmProvider: llmProvider || (recent.llm_events > 0 ? 'heuristic' : null),
        llmModel,
        llmCalls,
        llmTokensUsed,
        llmCostUsd,
        errorCount,
        brief,
      });
    } catch {
      // Stale/unreadable DB — skip
    }
  }

  // Show newest project first in Overview Action Graph
  cards.sort((a, b) => {
    const aDate = a.lastIndexed || '';
    const bDate = b.lastIndexed || '';
    if (aDate && bDate) return aDate > bDate ? -1 : aDate < bDate ? 1 : 0;
    if (aDate) return -1;
    if (bDate) return 1;
    return b.tokensSaved - a.tokensSaved;
  });

  // Show all indexed projects — sort by tokens, but never hide a valid index
  const result = cards.filter((c) => c.nodes > 0);
  _cardsCache.set(cacheKey, { cards: result, ts: Date.now() });
  return result;
}

export function projectHealth(card: ProjectCard, isSpanish = false): { label: string; className: string } {
  if (card.riskyNodes > 500 || card.hotspots > 500) {
    return { label: isSpanish ? 'Superficie alta' : 'High Surface', className: 'health-watch' };
  }
  if (card.edges < card.nodes) {
    return { label: isSpanish ? 'Disperso' : 'Sparse', className: 'health-risk' };
  }
  return { label: isSpanish ? 'Saludable' : 'Healthy', className: 'health-good' };
}

export { getSavingsLabScenarios } from "./savings-lab.js";


export function collectActionGraph(project: string, mode: string): ActionGraph {
  if (!project) {
    return { project, mode, nodes: [], edges: [], total_nodes: 0, total_edges: 0, role_counts: {}, narrative: 'No project selected.' };
  }

  const db = LynxDatabase.openProject(project);
  try {
    const totalNodes = (db.db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?').get(project) as { cnt: number }).cnt;
    const totalEdges = (db.db.prepare('SELECT COUNT(*) as cnt FROM edges WHERE project = ?').get(project) as { cnt: number }).cnt;
    const usage = summarizeUsage(project, 2000);
    const history = summarizeHistory(project, 90);
    const tokens = usage.tokens_saved + history.total_tokens_saved;

    const candidateRows = db.db.prepare(`
      WITH
        fan_in AS (
          SELECT target_id AS id, COUNT(*) AS cnt
          FROM edges
          WHERE project = ?
          GROUP BY target_id
        ),
        fan_out AS (
          SELECT source_id AS id, COUNT(*) AS cnt
          FROM edges
          WHERE project = ?
          GROUP BY source_id
        )
      SELECT
        n.id, n.name, n.qualified_name, n.kind, n.file_path, n.is_entry_point, n.properties,
        COALESCE(fan_in.cnt, 0) as fan_in,
        COALESCE(fan_out.cnt, 0) as fan_out
      FROM nodes n
      LEFT JOIN fan_in ON fan_in.id = n.id
      LEFT JOIN fan_out ON fan_out.id = n.id
      WHERE n.project = ?
        AND n.kind NOT IN ('Folder')
      ORDER BY
        (COALESCE(fan_in.cnt, 0) + COALESCE(fan_out.cnt, 0)) DESC,
        n.is_entry_point DESC,
        CASE n.kind WHEN 'Route' THEN 4 WHEN 'Function' THEN 3 WHEN 'Method' THEN 3 WHEN 'Class' THEN 2 ELSE 1 END DESC
    `).all(project, project, project) as ActionGraphRow[];
    const { rows, entryIds, hotspotIds, riskIds } = selectActionGraphRows(candidateRows, mode, 260);

    const idSet = new Set(rows.map((r) => r.id));
    const edges = rows.length === 0
      ? []
      : db.db.prepare(`
          SELECT source_id, target_id, type
          FROM edges
          WHERE project = ?
            AND source_id IN (${rows.map(() => '?').join(',')})
            AND target_id IN (${rows.map(() => '?').join(',')})
          ORDER BY
            CASE type WHEN 'CALLS' THEN 0 WHEN 'IMPORTS' THEN 1 WHEN 'ROUTES_TO' THEN 2 ELSE 3 END,
            id ASC
          LIMIT 520
        `)
          .all(project, ...rows.map((r) => r.id), ...rows.map((r) => r.id))
          .filter((e) => idSet.has((e as { source_id: number }).source_id) && idSet.has((e as { target_id: number }).target_id))
          .map((e) => {
            const edge = e as { source_id: number; target_id: number; type: string };
            return { source: edge.source_id, target: edge.target_id, type: edge.type };
          });

    const maxDegree = Math.max(1, ...rows.map((r) => r.fan_in + r.fan_out));
    const perNodeTokens = rows.length > 0 ? Math.round(tokens / rows.length) : 0;
    const selectedIds = rows.map((r) => r.id);
    const callersById = new Map<number, string[]>();
    const calleesById = new Map<number, string[]>();
    if (selectedIds.length > 0) {
      const placeholders = selectedIds.map(() => '?').join(',');
      const callerRows = db.db.prepare(`
        SELECT e.target_id AS id, n.name AS name
        FROM edges e
        JOIN nodes n ON n.id = e.source_id
        WHERE e.project = ? AND e.target_id IN (${placeholders})
        ORDER BY e.target_id, e.id ASC
        LIMIT 1600
      `).all(project, ...selectedIds) as Array<{ id: number; name: string }>;
      for (const row of callerRows) {
        const list = callersById.get(row.id) || [];
        if (!list.includes(row.name) && list.length < 3) list.push(row.name);
        callersById.set(row.id, list);
      }

      const calleeRows = db.db.prepare(`
        SELECT e.source_id AS id, n.name AS name
        FROM edges e
        JOIN nodes n ON n.id = e.target_id
        WHERE e.project = ? AND e.source_id IN (${placeholders})
        ORDER BY e.source_id, e.id ASC
        LIMIT 1600
      `).all(project, ...selectedIds) as Array<{ id: number; name: string }>;
      for (const row of calleeRows) {
        const list = calleesById.get(row.id) || [];
        if (!list.includes(row.name) && list.length < 3) list.push(row.name);
        calleesById.set(row.id, list);
      }
    }
    const nodes = rows.map((r, i) => {
      const d = r.fan_in + r.fan_out;
      const role: ActionGraphNode['role'] = entryIds.has(r.id) ? 'entry' : hotspotIds.has(r.id) ? 'hotspot' : riskIds.has(r.id) ? 'risk' : 'value';
      const area = flowArea(r.file_path);
      const ring = area === 'entry' ? 68 : area === 'service' ? 128 : area === 'api' ? 175 : area === 'ui' ? 225 : 265;
      const angle = (i / Math.max(rows.length, 1)) * Math.PI * 2 + stableNoise(r.qualified_name) * 0.5;
      const z = Math.max(-145, Math.min(145, (r.is_entry_point ? 82 : 0) + (r.fan_in - r.fan_out) * 1.65 + (area === 'data' ? -65 : 0)));
      return {
        id: r.id,
        name: r.name,
        qn: r.qualified_name,
        kind: r.kind,
        file: r.file_path || '(virtual graph node)',
        x: Math.cos(angle) * ring,
        y: Math.sin(angle) * ring,
        z,
        size: d === maxDegree && rows.length > 1 ? 3.2 + Math.sqrt(d + 1) * 2.6 : 3.2 + Math.sqrt(d + 1) * 1.45,
        color: d === maxDegree && rows.length > 1 ? '#ffffff' : roleColor(role),
        role,
        fanIn: r.fan_in,
        fanOut: r.fan_out,
        risk: Math.round((d / maxDegree) * 100),
        tokens: perNodeTokens,
        why: nodeWhy(role, r.kind, r.fan_in, r.fan_out),
        action: nodeAction(role),
        riskText: nodeRiskText(r.fan_in, r.fan_out),
        callers: callersById.get(r.id) || [],
        callees: calleesById.get(r.id) || [],
      };
    });
    const roleCounts = nodes.reduce<Record<string, number>>((acc, node) => {
      acc[node.role] = (acc[node.role] || 0) + 1;
      return acc;
    }, {});

    return {
      project,
      mode,
      nodes,
      edges,
      total_nodes: totalNodes,
      total_edges: totalEdges,
      role_counts: roleCounts,
      narrative: graphNarrative(nodes.length, totalNodes, mode, roleCounts, tokens),
    };
  } finally {
    db.close();
  }
}

export function nodeWhy(
  role: ActionGraphNode['role'],
  kind: string,
  fanIn: number,
  fanOut: number
): string {
  if (role === 'entry') return `Entry point detected as ${kind}. Start impact analysis here.`;
  if (role === 'hotspot') return `Hotspot with ${fanIn + fanOut} graph connections. It concentrates code flow.`;
  if (role === 'risk') return `Risky symbol because ${fanIn} other symbols depend on it.`;
  return `Useful context node with ${fanIn + fanOut} graph connections.`;
}

export function nodeAction(role: ActionGraphNode['role']): string {
  if (role === 'entry') return 'Use trace_path when downstream flow is relevant, then inspect only the evidence you need.';
  if (role === 'hotspot') return 'Check relevant callers or callees before editing and keep the change narrow.';
  if (role === 'risk') return 'Check inbound callers before changing behavior.';
  return 'Use get_code_snippet when you need exact source.';
}

export function nodeRiskText(fanIn: number, fanOut: number): string {
  if (fanIn >= 50) return 'High. Many symbols depend on this node.';
  if (fanIn >= 10) return 'Medium. Several callers can be affected.';
  if (fanOut >= 40) return 'Medium. This node touches many dependencies.';
  return 'Low. Limited visible blast radius in this graph.';
}

export function graphNarrative(
  shown: number,
  total: number,
  mode: string,
  roleCounts: Record<string, number>,
  tokens: number
): string {
  const isSpanish = readLynxConfig().locale === 'es';
  if (isSpanish) {
    const parts = [
      `${shown} nodos accionables de ${total.toLocaleString()} totales`,
      `${roleCounts.hotspot || 0} puntos críticos`,
      `${roleCounts.risk || 0} de riesgo`,
      `${roleCounts.entry || 0} puntos de entrada`,
    ];
    if (tokens > 0) parts.push(`${tokens.toLocaleString()} tokens de contexto ahorrados`);
    return `${parts.join(' · ')}. Modo: ${mode === 'value' ? 'valor' : mode === 'risk' ? 'riesgo' : mode === 'entry' ? 'entrada' : 'críticos'}.`;
  }
  const parts = [
    `${shown} actionable nodes from ${total.toLocaleString()} total`,
    `${roleCounts.hotspot || 0} hotspots`,
    `${roleCounts.risk || 0} risky`,
    `${roleCounts.entry || 0} entry points`,
  ];
  if (tokens > 0) parts.push(`${tokens.toLocaleString()} context tokens saved`);
  return `${parts.join(' · ')}. Mode: ${mode}.`;
}

export function selectActionGraphRows(
  candidates: ActionGraphRow[],
  mode: string,
  limit: number
): { rows: ActionGraphRow[]; entryIds: Set<number>; hotspotIds: Set<number>; riskIds: Set<number> } {
  const sorted = [...candidates].sort((a, b) => degree(b) - degree(a));
  const selected: ActionGraphRow[] = [];
  const seen = new Set<number>();

  const add = (rows: ActionGraphRow[], max: number) => {
    for (const row of rows) {
      if (selected.length >= limit || max <= 0) break;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      selected.push(row);
      max--;
    }
  };

  // Percentile-based thresholds so modes always differ visually, even for small graphs.
  // hotspot = top 15% by total degree, risk = next 25%, value = bottom 60%.
  // Entry points are always their own category regardless of degree.
  const totalCandidates = sorted.length || 1;
  const hotspotCutoff = sorted[Math.floor(totalCandidates * 0.15)] ? degree(sorted[Math.floor(totalCandidates * 0.15)]) : 999;
  const riskCutoff = sorted[Math.floor(totalCandidates * 0.40)] ? degree(sorted[Math.floor(totalCandidates * 0.40)]) : 999;

  const entryIds = new Set(sorted.filter((r) => r.is_entry_point === 1 || r.kind === 'Route').map((r) => r.id));
  const entry = sorted.filter((r) => entryIds.has(r.id));
  const hotspot = sorted.filter((r) => !entryIds.has(r.id) && degree(r) >= Math.max(hotspotCutoff, 2));
  const hotspotIds = new Set(hotspot.map((r) => r.id));
  const risk = sorted.filter((r) => !entryIds.has(r.id) && !hotspotIds.has(r.id) && degree(r) >= Math.max(riskCutoff, 1));
  const riskIds = new Set(risk.map((r) => r.id));
  const value = sorted.filter((r) => !entryIds.has(r.id) && !hotspotIds.has(r.id) && !riskIds.has(r.id));

  if (mode === 'entry') {
    add(entry, 170);
    add(hotspot, 45);
    add(risk, 30);
  } else if (mode === 'hotspot') {
    add(hotspot, 175);
    add(risk, 45);
    add(entry, 25);
  } else if (mode === 'risk') {
    add(risk, 150);
    add(hotspot, 70);
    add(entry, 25);
  } else {
    add(value, 115);
    add(hotspot, 70);
    add(risk, 45);
    add(entry, 30);
  }

  add(sorted, limit - selected.length);
  return { rows: selected, entryIds, hotspotIds, riskIds };
}

export function degree(row: ActionGraphRow): number {
  return row.fan_in + row.fan_out;
}

export function roleColor(role: ActionGraphNode['role']): string {
  switch (role) {
    case 'entry': return '#38bdf8';
    case 'hotspot': return '#f59e0b';
    case 'risk': return '#ef4444';
    case 'value': return '#22c55e';
    default: return '#94a3b8';
  }
}

export function flowArea(filePath: string): string {
  if (/\/api\/|route\.(ts|tsx|js|jsx)$/.test(filePath)) return 'api';
  if (/\/lib\/|service|provider|auth|mailing|server/.test(filePath)) return 'service';
  if (/\/app\/|\/components\/|\.tsx$/.test(filePath)) return 'ui';
  if (/db|store|schema|repository|prisma/i.test(filePath)) return 'data';
  return 'entry';
}

export function stableNoise(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}
