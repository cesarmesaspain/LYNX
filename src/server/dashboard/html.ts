/*
 * dashboard/html.ts — Dashboard HTML template.
 */

import { readLynxConfig } from '../../config/runtime.js';
import { escapeHtml, savingsLabScript, measuredImpactScript } from './utils.js';
import { actionGraphScript } from './scripts/action-graph.js';
import { webSocketScript } from './scripts/websocket.js';
import { tabScript } from './scripts/tabs.js';
import { projectHealth, type ProjectCard } from './data.js';

export function renderDashboard(cards: ProjectCard[]): string {
  const isSpanish = readLynxConfig().locale === 'es';
  const totalTokens = cards.reduce((s, c) => s + c.tokensSaved, 0);
  const totalFiles = cards.reduce((s, c) => s + c.filesAvoided, 0);
  const totalNodes = cards.reduce((s, c) => s + c.nodes, 0);
  const totalEdges = cards.reduce((s, c) => s + c.edges, 0);
  const totalIndexedFiles = cards.reduce((s, c) => s + c.filesIndexed, 0);
  const totalHotspots = cards.reduce((s, c) => s + c.hotspots, 0);
  const totalDbSizeMb = Math.round(cards.reduce((s, c) => s + c.dbSizeBytes, 0) / (1024 * 1024));
  const totalLlmCalls = cards.reduce((s, c) => s + c.llmCalls, 0);
  const totalLlmCost = cards.reduce((s, c) => s + c.llmCostUsd, 0);
  const totalErrors = cards.reduce((s, c) => s + c.errorCount, 0);
  const staleCount = cards.filter((c) => c.freshness === 'stale').length;
  const failedCount = cards.filter((c) => c.freshness === 'failed').length;
  const updatingCount = cards.filter((c) => c.freshness === 'updating').length;
  const briefPayload = Object.fromEntries(cards
    .filter((c) => c.brief)
    .map((c) => [c.name, {
      brief: c.brief?.brief || '',
      generated_at: c.brief?.generated_at || '',
    }]));
  const primaryBrief = cards.find((c) => c.brief)?.brief || null;

  const cardHtml = cards.length === 0
    ? `<div class="card" style="grid-column:1/-1"><p>${isSpanish ? 'Aún no hay proyectos indexados. Ejecuta primero' : 'No indexed projects yet. Run'} <code>LYNX index /path/to/project</code>${isSpanish ? ' primero.' : '.'}</p></div>`
    : cards
        .map(
          (c) => {
            const health = projectHealth(c, isSpanish);
            return `
    <button class="card project-card" type="button" data-project-card="${escapeHtml(c.name)}" aria-label="Show ${escapeHtml(c.displayName)} graph">
      <span class="card-delete-btn" role="button" tabindex="0" data-delete-project="${escapeHtml(c.name)}" data-delete-name="${escapeHtml(c.displayName)}" aria-label="${isSpanish ? 'Eliminar' : 'Delete'} ${escapeHtml(c.displayName)}" title="${isSpanish ? 'Eliminar proyecto' : 'Delete project'}">&#x2715;</span>
      <div class="project-topline"><div class="card-title">${escapeHtml(c.displayName)}</div><span class="health-pill ${health.className}">${health.label}</span>${c.freshness !== 'ready' ? `<span class="freshness-pill freshness-${c.freshness}">${c.freshness}</span>` : ''}</div>
      <div class="card-stats">
        <div><span class="stat-label">${isSpanish ? 'Nodos' : 'Nodes'}</span><span class="stat-value">${c.nodes.toLocaleString()}</span></div>
        <div><span class="stat-label">${isSpanish ? 'Aristas' : 'Edges'}</span><span class="stat-value">${c.edges.toLocaleString()}</span></div>
        <div><span class="stat-label">${isSpanish ? 'Archivos' : 'Files'}</span><span class="stat-value">${c.filesIndexed.toLocaleString()}</span></div>
      </div>
      <div class="card-stats">
        <div><span class="stat-label">${isSpanish ? 'Críticos' : 'Hotspots'}</span><span class="stat-value">${c.hotspots.toLocaleString()}</span></div>
        <div><span class="stat-label">${isSpanish ? 'Riesgo' : 'Risky'}</span><span class="stat-value">${c.riskyNodes.toLocaleString()}</span></div>
        <div><span class="stat-label">${isSpanish ? 'Entrada' : 'Entry'}</span><span class="stat-value">${c.entryPoints.toLocaleString()}</span></div>
      </div>
      <div class="project-impact">${isSpanish ? 'Tokens ahorrados' : 'Tokens saved'}: <b>${c.tokensSaved.toLocaleString()}</b> · ${isSpanish ? 'Archivos evitados' : 'Files avoided'}: <b>${c.filesAvoided.toLocaleString()}</b></div>
      ${c.semanticEvents > 0 ? `<div class="semantic-note">${isSpanish ? 'Mejora semántica' : 'Semantic lift'}: ${c.semanticTopChanged}/${c.semanticEvents} ${isSpanish ? 'resultados principales mejorados' : 'top-results improved'}</div>` : ''}
      ${c.lastIndexed ? `<div class="muted-text">${isSpanish ? 'Indexado' : 'Indexed'}: ${c.lastIndexed} · ${c.edgeTypes} ${isSpanish ? 'tipos de arista' : 'edge types'}</div>` : ''}
      <div class="ops-row">${c.dbSizeBytes > 0 ? `<span>${(c.dbSizeBytes / (1024 * 1024)).toFixed(1)} MB</span>` : ''}${c.hoursSinceIndex !== null ? `<span>${c.hoursSinceIndex}h</span>` : ''}${c.llmCalls > 0 ? `<span>${c.llmProvider || 'LLM'}: ${c.llmCalls} calls${c.llmCostUsd > 0 ? ' · $' + c.llmCostUsd.toFixed(4) : ''}</span>` : ''}${c.errorCount > 0 ? `<span style="color:#fca5a5">${c.errorCount} ${isSpanish ? 'errores' : 'errors'}</span>` : ''}</div>
      <div class="open-graph">${isSpanish ? 'Abrir grafo' : 'Open graph'}</div>
    </button>`;
          }
        )
        .join('\n');
  const graphProject = cards[0]?.name || '';
  const fullscreenProjects = cards
    .map((c) => {
      const health = projectHealth(c, isSpanish);
      return `
        <button class="fs-project-card" type="button" data-fs-project="${escapeHtml(c.name)}" aria-label="Show ${escapeHtml(c.displayName)} graph">
          <div><b>${escapeHtml(c.displayName)}</b><span class="health-pill ${health.className}">${health.label}</span></div>
          <span>${c.nodes.toLocaleString()} nodes · ${c.hotspots.toLocaleString()} hotspots · ${c.riskyNodes.toLocaleString()} risky</span>
          <span>${c.tokensSaved.toLocaleString()} tokens saved</span>
        </button>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="${isSpanish ? 'es' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self' data:;">
  <title>${isSpanish ? 'Panel de LYNX' : 'LYNX Dashboard'}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    header { background: #1e293b; border-bottom: 1px solid #334155; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
    header h1 { font-size: 20px; font-weight: 700; }
    header .badge { background: #334155; color: #94a3b8; padding: 4px 10px; border-radius: 6px; font-size: 12px; }
    .tab-bar { display: flex; gap: 0; background: #0f172a; border-bottom: 1px solid #334155; padding: 0 24px; }
    .tab-btn { background: none; border: none; color: #64748b; font: inherit; font-size: 14px; font-weight: 500; padding: 14px 20px; cursor: pointer; border-bottom: 2px solid transparent; transition: all .2s; white-space: nowrap; }
    .tab-btn:hover { color: #cbd5e1; }
    .tab-btn.active { color: #38bdf8; border-bottom-color: #38bdf8; }
    .tab-btn .tab-icon { margin-right: 7px; font-size: 16px; }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    main { max-width: 1280px; margin: 0 auto; padding: 24px 20px; }
    .summary-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin-bottom: 28px; }
    .summary-card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 12px; min-width: 0; }
    .summary-card .label { color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
    .summary-card .value { font-size: clamp(20px, 1.8vw, 28px); font-weight: 700; margin-top: 6px; color: #f1f5f9; overflow-wrap: anywhere; }
    .summary-card .value.token-value { color: #4ade80; }
    .token-label-dollar { color:#4ade80; font-size:19px; font-weight:800; line-height:0; vertical-align:-2px; margin-right:5px; }
    .value-strip { margin: -10px 0 26px; padding: 14px 16px; display: flex; gap: 12px; align-items: center; background: #162033; border: 1px solid #334155; border-radius: 10px; color: #cbd5e1; font-size: 13px; }
    .value-strip b { color: #f8fafc; white-space: nowrap; }
    .brief-card { margin: -12px 0 26px; padding: 18px; background: linear-gradient(180deg, #202b3d, #172033); border: 1px solid #334155; border-radius: 10px; overflow: hidden; }
    .brief-card h2 { margin-bottom: 8px; }
    .brief-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
    .brief-carousel { position: relative; overflow: hidden; border-radius: 12px; padding: 0 52px; }
    .brief-track { display: flex; width: 100%; transition: transform 0.55s cubic-bezier(.22,1,.36,1); align-items: stretch; will-change: transform; }
    .brief-section-card {
      flex: 0 0 100%;
      min-width: 0;
      padding: 22px 24px;
      background:
        radial-gradient(circle at 18% 0%, rgba(56, 189, 248, .16), transparent 34%),
        linear-gradient(135deg, rgba(15, 23, 42, .98), rgba(30, 41, 59, .9));
      border: 1px solid rgba(148, 163, 184, .2);
      border-radius: 12px;
      min-height: 190px;
      max-height: 300px;
      overflow: auto;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.03), 0 18px 40px rgba(0,0,0,.24);
      transition: border-color .3s, box-shadow .3s, opacity .35s, filter .35s, transform .35s;
    }
    .brief-section-card:not(.active) {
      opacity: .38;
      filter: blur(2px) grayscale(.6);
      pointer-events: none;
    }
    .brief-section-card.active { border-color: rgba(56, 189, 248, .55); box-shadow: inset 0 1px 0 rgba(255,255,255,.04), 0 22px 48px rgba(0,0,0,.3); }
    .brief-section-card h3 {
      font-size: 18px; font-weight: 800; color: #f8fafc;
      margin-bottom: 10px; padding-bottom: 10px;
      border-bottom: 1px solid rgba(51, 65, 85, 0.5);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .brief-section-card p {
      font-size: 13px; line-height: 1.62; color: #cbd5e1; margin: 0; overflow-wrap: anywhere;
    }
    .brief-dots { display: flex; justify-content: center; gap: 8px; margin-top: 14px; }
    .brief-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #475569; border: none; cursor: pointer; padding: 0;
      transition: background .25s, transform .25s;
    }
    .brief-dot:hover { background: #94a3b8; }
    .brief-dot.active { background: #38bdf8; transform: scale(1.35); }
    .brief-nav {
      position: absolute; top: 50%; transform: translateY(-50%);
      width: 34px; height: 34px; border-radius: 50%;
      background: rgba(15, 23, 42, .72); border: 1px solid rgba(148, 163, 184, .28);
      color: #cbd5e1; cursor: pointer; display: flex;
      align-items: center; justify-content: center;
      font-size: 19px; line-height: 1; transition: border-color .2s, color .2s, background .2s, opacity .2s;
      z-index: 2; padding: 0;
      backdrop-filter: blur(10px);
    }
    .brief-nav:hover { border-color: #67e8f9; color: #fff; background: rgba(30, 41, 59, .95); }
    .brief-nav.prev { left: 12px; }
    .brief-nav.next { right: 12px; }
    .brief-nav:active { transform: translateY(-50%) scale(.94); }
    @media (max-width: 600px) {
      .brief-section-card { flex: 0 0 100%; }
      .brief-carousel { padding: 0 30px; }
    }

    /* Brief loading — indexed data reveal */
    .brief-loading { padding: 20px 18px 16px; }
    .brief-loading-label {
      font-size: 12px; color: #94a3b8; margin-bottom: 16px;
      display: flex; align-items: center; gap: 8px;
    }
    .brief-loading-label b { color: #e2e8f0; font-weight: 700; }
    .brief-loading-dot {
      width: 7px; height: 7px; border-radius: 50%; background: #38bdf8;
      animation: briefPulse 1.2s ease-in-out infinite;
    }
    @keyframes briefPulse {
      0%, 100% { box-shadow: 0 0 5px rgba(56,189,248,.2); }
      50% { box-shadow: 0 0 14px rgba(56,189,248,.45); }
    }
    .brief-data-grid {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
      margin-bottom: 14px;
    }
    .brief-data-tile {
      background: #162033; border: 1px solid #1e293b; border-radius: 8px;
      padding: 10px 8px; text-align: center; transition: all .5s ease;
      opacity: .08; transform: translateY(8px);
    }
    .brief-data-tile.revealed {
      opacity: 1; transform: translateY(0);
      border-color: rgba(56,189,248,.22);
      box-shadow: 0 0 12px rgba(56,189,248,.06);
    }
    .brief-data-tile.revealed:nth-child(odd) { background: #1a2a3d; }
    .bdt-label {
      display: block; font-size: 9px; color: #64748b;
      text-transform: uppercase; letter-spacing: .06em; margin-bottom: 3px;
    }
    .bdt-value {
      display: block; font-size: 17px; font-weight: 700; color: #e2e8f0;
      font-variant-numeric: tabular-nums;
    }
    .bdt-value.counting { color: #38bdf8; }
    .brief-progress-bar {
      height: 3px; background: #1e293b; border-radius: 2px;
      overflow: hidden; margin-bottom: 6px;
    }
    .brief-progress-fill {
      height: 100%; width: 0%; background: linear-gradient(90deg, #38bdf8, #67e8f9);
      border-radius: 2px; transition: width .4s ease;
    }
    .brief-phase-text {
      font-size: 11px; color: #64748b; text-align: center;
      transition: color .5s;
    }
    .brief-phase-text.awaiting {
      color: #67e8f9;
      animation: phaseBlink 1.6s ease-in-out infinite;
    }
    @keyframes phaseBlink {
      0%, 100% { opacity: .4; }
      50% { opacity: 1; }
    }
    @media (max-width: 700px) {
      .brief-data-grid { grid-template-columns: repeat(2, 1fr); }
    }
    h2 { font-size: 16px; color: #cbd5e1; margin-bottom: 12px; }
    .project-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 14px; }
    .project-card { cursor: pointer; text-align: left; width: 100%; font: inherit; color: inherit; transition: border-color .16s ease, transform .16s ease, background .16s ease; position: relative; }
    .project-card:hover { border-color: #38bdf8; background: #243044; transform: translateY(-1px); }
    .project-card.active { border-color: #22d3ee; box-shadow: 0 0 0 1px rgba(34, 211, 238, .25); }
    .project-topline { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 12px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 18px; }
    .card-title { font-size: 17px; font-weight: 700; color: #f8fafc; }
    .health-pill { flex: 0 0 auto; border-radius: 999px; padding: 4px 8px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; border: 1px solid #334155; }
    .health-good { color: #86efac; background: rgba(34, 197, 94, .11); border-color: rgba(34, 197, 94, .35); }
    .health-watch { color: #fde68a; background: rgba(245, 158, 11, .11); border-color: rgba(245, 158, 11, .35); }
    .health-risk { color: #fca5a5; background: rgba(239, 68, 68, .11); border-color: rgba(239, 68, 68, .35); }
    .freshness-pill { font-size: 10px; padding: 2px 8px; border-radius: 4px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
    .freshness-stale { background: rgba(251,191,36,.2); color: #fbbf24; }
    .freshness-updating { background: rgba(56,189,248,.2); color: #38bdf8; }
    .freshness-failed { background: rgba(239,68,68,.25); color: #fca5a5; }
    .freshness-unknown { background: rgba(148,163,184,.15); color: #94a3b8; }
    .ops-row { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11px; color: #64748b; margin-top: 6px; margin-bottom: 2px; }
    .ops-row span { background: #162033; padding: 2px 7px; border-radius: 4px; white-space: nowrap; }
    .card-stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 10px; }
    .card-stats div { text-align: center; }
    .stat-label { display: block; font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: .04em; }
    .stat-value { display: block; font-size: 15px; font-weight: 600; color: #cbd5e1; margin-top: 2px; }
    .semantic-note { font-size: 12px; color: #a78bfa; margin-top: 4px; }
    .project-impact { font-size: 12px; color: #cbd5e1; margin-top: 2px; }
    .open-graph { margin-top: 10px; font-size: 12px; color: #67e8f9; font-weight: 700; }
    .muted-text { font-size: 11px; color: #64748b; margin-top: 6px; }
    .empty-state { color: #64748b; font-size: 14px; }
    .empty-state code { background: #334155; padding: 1px 6px; border-radius: 4px; color: #cbd5e1; }
    .action-graph { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 14px; margin-bottom: 28px; }
    .graph-shell { position: relative; height: 520px; overflow: hidden; background: radial-gradient(circle at 50% 30%, #172554, #020617 64%); }
    .graph-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
    .graph-toolbar button { background: #0f172a; color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; padding: 8px 10px; }
    .graph-toolbar button.active { border-color: #22d3ee; color: #67e8f9; }
    #actionGraph { width: 100%; height: 100%; display: block; }
    .fullscreen-btn { position: absolute; right: 14px; top: 14px; z-index: 2; width: 36px; height: 36px; display: grid; place-items: center; background: rgba(15, 23, 42, .78); color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; cursor: pointer; font-size: 18px; line-height: 1; }
    .fullscreen-btn:hover { border-color: #38bdf8; color: #67e8f9; background: rgba(15, 23, 42, .94); }
    .graph-shell:fullscreen { width: 100vw; height: 100vh; border-radius: 0; border: 0; padding: 0; }
    .fullscreen-left { display: none; }
    .graph-shell:fullscreen .fullscreen-left { position: absolute; left: 18px; top: 18px; z-index: 2; width: min(330px, 28vw); display: grid; gap: 10px; }
    .fs-mode-bar { display: flex; gap: 8px; flex-wrap: wrap; padding: 8px; border: 1px solid rgba(51, 65, 85, .8); border-radius: 10px; background: rgba(15, 23, 42, .78); backdrop-filter: blur(10px); }
    .fs-mode-bar button { background: #0f172a; color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; padding: 8px 10px; cursor: pointer; font: inherit; font-size: 12px; }
    .fs-mode-bar button.active { border-color: #22d3ee; color: #67e8f9; }
    .fs-project-list { display: grid; gap: 8px; max-height: min(42vh, 360px); overflow: auto; }
    .fs-project-card { width: 100%; text-align: left; display: grid; gap: 5px; padding: 10px; border: 1px solid rgba(51, 65, 85, .86); border-radius: 10px; background: rgba(30, 41, 59, .82); color: #cbd5e1; cursor: pointer; font: inherit; backdrop-filter: blur(10px); }
    .fs-project-card:hover { border-color: #38bdf8; background: rgba(36, 48, 68, .92); }
    .fs-project-card.active { border-color: #22d3ee; box-shadow: 0 0 0 1px rgba(34, 211, 238, .25); }
    .fs-project-card div { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .fs-project-card b { color: #f8fafc; font-size: 13px; }
    .fs-project-card span { font-size: 11px; color: #94a3b8; }
    .fullscreen-detail { display: none; }
    .graph-shell:fullscreen .fullscreen-detail { position: absolute; right: 18px; top: 64px; bottom: 18px; width: min(340px, 30vw); display: block; overflow: auto; background: rgba(30, 41, 59, .92); backdrop-filter: blur(10px); }
    .graph-legend { position: absolute; left: 14px; bottom: 12px; display: flex; gap: 10px; flex-wrap: wrap; font-size: 11px; color: #cbd5e1; }
    .legend-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 4px; }
    .detail-panel h3 { font-size: 15px; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
    .node-title-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: 0 0 auto; box-shadow: 0 0 10px currentColor; }
    .detail-panel p { font-size: 12px; color: #94a3b8; margin-bottom: 8px; word-break: break-word; }
    .detail-pill { display: inline-block; padding: 4px 7px; background: #0f172a; border: 1px solid #334155; border-radius: 999px; margin: 0 4px 6px 0; font-size: 11px; }
    .detail-section { margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(51, 65, 85, .72); }
    .detail-section b { display: block; margin-bottom: 5px; font-size: 11px; color: #e2e8f0; text-transform: uppercase; letter-spacing: .04em; }
    .detail-section ul { list-style: none; display: grid; gap: 4px; }
    .detail-section li { font-size: 12px; color: #cbd5e1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    footer { text-align: center; padding: 24px; color: #475569; font-size: 12px; }
    @media (max-width: 1100px) { .summary-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    @media (max-width: 900px) { .action-graph { grid-template-columns: 1fr; } .graph-shell { height: 420px; } .brief-section-card { min-height: 220px; } }
    @media (max-width: 600px) { .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .project-grid { grid-template-columns: 1fr; } .brief-card { padding: 14px; } .brief-section-card { padding: 18px; } .brief-nav { display: none; } }

    /* Savings Lab */
    .savings-lab { margin: -8px 0 28px; }
    .your-savings { margin:-8px 0 28px; }
    .your-savings h2 { font-size:20px; margin-bottom:4px; }
    .live-savings-hero { margin:16px 0 12px; padding:22px; border:1px solid #22c55e55; border-radius:12px; background:linear-gradient(135deg,#173526,#162033 70%); }
    .live-savings-hero .eyebrow { color:#86efac; text-transform:uppercase; letter-spacing:.08em; font-size:11px; }
    .live-savings-hero .big-save { color:#4ade80; font-size:34px; font-weight:800; margin:4px 0; }
    .live-savings-hero p { color:#cbd5e1; font-size:13px; }
    .live-savings-dims { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:10px; }
    .live-savings-dim { padding:13px; border:1px solid #334155; border-radius:10px; background:#1e293b; }
    .live-savings-dim .dim-label { color:#94a3b8; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
    .live-savings-dim .dim-save { color:#f8fafc; font-size:18px; font-weight:750; margin:5px 0; }
    .live-savings-dim p { color:#64748b; font-size:11px; line-height:1.4; }
    .savings-lab h2 { font-size: 18px; margin-bottom: 4px; }
    .savings-subtitle { color: #94a3b8; font-size: 13px; margin-bottom: 16px; }
    .scenario-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px; }
    .scenario-tab { background: #1e293b; border: 1px solid #334155; color: #94a3b8; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; transition: all .2s; }
    .scenario-tab:hover { border-color: #475569; color: #e2e8f0; }
    .scenario-tab.active { background: #1e3a5f; border-color: #38bdf8; color: #38bdf8; font-weight: 600; }
    .scenario-body { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; min-height: 280px; }
    .scenario-loading { color: #64748b; text-align: center; padding: 60px 0; }
    .scenario-header { margin-bottom: 20px; }
    .scenario-header h3 { font-size: 18px; margin-bottom: 4px; color: #f8fafc; }
    .scenario-header .team-badge { display: inline-block; background: #334155; color: #94a3b8; padding: 3px 10px; border-radius: 5px; font-size: 12px; margin-top: 4px; }
    .scenario-header p { color: #94a3b8; font-size: 13px; margin-top: 8px; line-height: 1.5; }
    .compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 20px; }
    .compare-col { background: #162033; border: 1px solid #334155; border-radius: 10px; padding: 16px; }
    .compare-col.without { border-left: 3px solid #ef4444; }
    .compare-col.with { border-left: 3px solid #22c55e; }
    .compare-col h4 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 12px; }
    .without h4 { color: #f87171; }
    .with h4 { color: #4ade80; }
    .compare-stat { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
    .compare-stat .stat-label { color: #94a3b8; }
    .compare-stat .stat-val { color: #e2e8f0; font-weight: 600; font-variant-numeric: tabular-nums; }
    .savings-total { background: linear-gradient(135deg, #1a3a2a, #162033); border: 1px solid #22c55e33; border-radius: 10px; padding: 18px; margin-bottom: 18px; }
    .savings-total .big-save { font-size: 28px; font-weight: 800; color: #4ade80; }
    .savings-total .save-detail { color: #94a3b8; font-size: 13px; margin-top: 4px; }
    .savings-dims { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px; }
    .savings-dim { background: #162033; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
    .savings-dim .dim-label { color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 3px; }
    .savings-dim .dim-save { color: #e2e8f0; font-size: 13px; font-weight: 500; }
    .scenario-footer { margin-top: 18px; padding-top: 14px; border-top: 1px solid #334155; display: flex; gap: 16px; flex-wrap: wrap; }
    .metric-pill { background: #1e293b; border: 1px solid #334155; border-radius: 20px; padding: 6px 14px; font-size: 12px; }
    .metric-pill .pill-label { color: #64748b; }
    .metric-pill .pill-val { color: #f8fafc; font-weight: 700; }
    .metric-pill.green { border-color: #22c55e55; }
    .metric-pill.green .pill-val { color: #4ade80; }
    @media (max-width: 700px) { .compare-grid { grid-template-columns: 1fr; } }

    /* Add project button */
    .add-project-btn {
      width: 32px; height: 32px; border-radius: 50%;
      background: #1e293b; border: 1.5px dashed #475569;
      color: #94a3b8; font-size: 18px; line-height: 1;
      cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
      transition: all .2s; padding: 0; margin-left: 8px;
    }
    .add-project-btn:hover { border-color: #38bdf8; color: #38bdf8; background: #1e3a5f; }
    .add-project-btn-tab {
      background: none; border: none; color: #94a3b8; font: inherit; font-size: 14px; font-weight: 500;
      padding: 14px 20px; cursor: pointer; border-bottom: 2px solid transparent; transition: all .2s;
      white-space: nowrap; display: flex; align-items: center; gap: 8px; margin-left: auto; margin-right: 0;
    }
    .add-project-btn-tab:hover { color: #cbd5e1; }
    .add-project-btn-tab .plus-circle {
      width: 28px; height: 28px; border-radius: 50%;
      background: #1e293b; border: 1.5px dashed #475569;
      color: #94a3b8; font-size: 16px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .add-project-btn-tab:hover .plus-circle { border-color: #38bdf8; color: #38bdf8; background: #1e3a5f; }
    .projects-header { display: flex; align-items: center; margin-bottom: 12px; }
    .projects-header h2 { margin-bottom: 0; }

    /* Delete card */
    .card-delete-btn { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border-radius: 4px; background: transparent; border: none; color: #ef4444; font-size: 14px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all .15s; z-index: 2; padding: 0; opacity: .55; }
    .card-delete-btn:hover { opacity: 1; color: #fff; background: rgba(239,68,68,.25); }
    .delete-modal-overlay { display: none; position: fixed; inset: 0; z-index: 200; background: rgba(2,6,23,.78); backdrop-filter: blur(4px); align-items: center; justify-content: center; }
    .delete-modal-overlay.open { display: flex; }
    .delete-modal-box { background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 28px; width: min(420px, 92vw); box-shadow: 0 28px 60px rgba(0,0,0,.5); text-align: center; }
    .delete-modal-box h3 { font-size: 16px; color: #f8fafc; margin-bottom: 8px; }
    .delete-modal-box .delete-project-name { color: #fca5a5; font-weight: 700; }
    .delete-modal-box p { font-size: 13px; color: #94a3b8; margin-bottom: 20px; line-height: 1.5; }
    .delete-modal-actions { display: flex; gap: 10px; justify-content: center; }
    .btn-delete-cancel { padding: 9px 20px; border-radius: 8px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; background: transparent; color: #94a3b8; border: 1px solid #334155; transition: all .2s; }
    .btn-delete-cancel:hover { color: #e2e8f0; border-color: #475569; }
    .btn-delete-confirm { padding: 9px 20px; border-radius: 8px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; background: rgba(239,68,68,.15); color: #fca5a5; border: 1px solid rgba(239,68,68,.4); transition: all .2s; }
    .btn-delete-confirm:hover { background: #dc2626; color: #fff; border-color: #dc2626; }
    .btn-delete-confirm:disabled { opacity: .45; cursor: not-allowed; }

    /* Metrics tab */
    .metrics-toolbar { display: flex; align-items: center; gap: 4px; padding: 20px 24px 12px; flex-wrap: wrap; }
    .win-btn { background: #1e293b; border: 1px solid #334155; color: #94a3b8; padding: 7px 14px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 13px; transition: all .2s; }
    .win-btn:hover { color: #e2e8f0; border-color: #475569; }
    .win-btn.active { background: #1e3a5f; border-color: #38bdf8; color: #38bdf8; font-weight: 600; }
    .metrics-summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; padding: 0 24px 20px; }
    .metric-card { background: #1e293b; border: 1px solid #1e293b; border-radius: 10px; padding: 16px; text-align: center; transition: border-color .2s; }
    .metric-card:hover { border-color: #334155; }
    .metric-label { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px; }
    .metric-value { color: #e2e8f0; font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .metric-sub { color: #64748b; font-size: 11px; margin-top: 4px; }
    .metrics-bars { padding: 0 24px 20px; }
    .bars-placeholder { color: #64748b; font-style: italic; padding: 40px; text-align: center; }
    .bar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .bar-label { width: 170px; text-align: right; font-size: 13px; color: #94a3b8; flex-shrink: 0; }
    .bar-track { flex: 1; height: 22px; background: #0f172a; border-radius: 6px; overflow: hidden; position: relative; }
    .bar-fill { height: 100%; border-radius: 6px; transition: width .3s ease; min-width: 2px; }
    .bar-value { width: 90px; font-size: 13px; color: #e2e8f0; font-variant-numeric: tabular-nums; flex-shrink: 0; text-align: right; }
    .metrics-coverage { padding: 0 24px 20px; }
    .coverage-text { color: #64748b; font-size: 13px; padding: 12px; background: #0f172a; border-radius: 8px; }
    .metrics-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .prov-measured { background: rgba(34,197,94,.15); color: #4ade80; }
    .prov-estimated { background: rgba(245,158,11,.15); color: #fbbf24; }
    .prov-scenario { background: rgba(139,92,246,.15); color: #a78bfa; }

  </style>
</head>
<body>
  <header>
    <h1>${isSpanish ? 'Panel de LYNX' : 'LYNX Dashboard'}</h1>
    <div style="display:flex;gap:10px;align-items:center"><select id="localeSelect" aria-label="Language" style="background:#0f172a;color:#e2e8f0;border:1px solid #475569;border-radius:6px;padding:4px 7px;font-size:12px"><option value="es"${isSpanish ? ' selected' : ''}>ES</option><option value="en"${!isSpanish ? ' selected' : ''}>EN</option></select><span class="badge">${isSpanish ? 'solo local — sin nube' : 'local only — no cloud'}</span></div>
  </header>
  <nav class="tab-bar">
    <button class="tab-btn active" data-tab="overview"><span class="tab-icon">&#9670;</span>${isSpanish ? 'Resumen' : 'Overview'}</button>
    <button class="tab-btn" data-tab="projects"><span class="tab-icon">&#9776;</span>${isSpanish ? 'Proyectos' : 'Projects'}</button>
    <button class="tab-btn" data-tab="savings"><span class="tab-icon">&#9733;</span>${isSpanish ? 'Ahorros' : 'Savings'}</button>
    <button class="tab-btn" data-tab="metrics"><span class="tab-icon">&#9776;</span>${isSpanish ? 'Métricas' : 'Metrics'}</button>
    <button class="add-project-btn-tab" id="addProjectBtnTab" type="button"><span class="plus-circle">+</span> Proyecto</button>
  </nav>
  <main>
    <!-- Overview tab -->
    <section class="tab-panel active" id="tab-overview">
      <section class="summary-grid">
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><rect x="3" y="2" width="5" height="5" rx="1" stroke="#22d3ee" stroke-width="1.5"/><rect x="12" y="2" width="5" height="5" rx="1" stroke="#22d3ee" stroke-width="1.5"/><rect x="3" y="13" width="5" height="5" rx="1" stroke="#22d3ee" stroke-width="1.5"/><rect x="12" y="13" width="5" height="5" rx="1" stroke="#22d3ee" stroke-width="1.5"/></svg>${isSpanish ? 'Proyectos' : 'Projects'}</div><div class="value">${cards.length}</div></div>
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><circle cx="6" cy="6" r="2.5" stroke="#a78bfa" stroke-width="1.5"/><circle cx="14" cy="6" r="2.5" stroke="#a78bfa" stroke-width="1.5"/><circle cx="10" cy="14" r="2.5" stroke="#a78bfa" stroke-width="1.5"/><line x1="8" y1="7.5" x2="9.5" y2="12" stroke="#a78bfa" stroke-width="1.2"/><line x1="12" y1="7.5" x2="10.5" y2="12" stroke="#a78bfa" stroke-width="1.2"/></svg>${isSpanish ? 'Nodos totales' : 'Total Nodes'}</div><div class="value">${totalNodes.toLocaleString()}</div></div>
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><line x1="3" y1="3" x2="17" y2="17" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round"/><line x1="17" y1="3" x2="3" y2="17" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="4" r="2" stroke="#f59e0b" stroke-width="1.5"/><circle cx="4" cy="10" r="2" stroke="#f59e0b" stroke-width="1.5"/><circle cx="16" cy="10" r="2" stroke="#f59e0b" stroke-width="1.5"/><circle cx="10" cy="16" r="2" stroke="#f59e0b" stroke-width="1.5"/></svg>${isSpanish ? 'Aristas totales' : 'Total Edges'}</div><div class="value">${totalEdges.toLocaleString()}</div></div>
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><path d="M4 3h6l3 3h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" stroke="#38bdf8" stroke-width="1.5" stroke-linejoin="round"/></svg>${isSpanish ? 'Archivos indexados' : 'Indexed Files'}</div><div class="value">${totalIndexedFiles.toLocaleString()}</div></div>
        <div class="summary-card"><div class="label"><span class="token-label-dollar">$</span>${isSpanish ? 'Tokens ahorrados' : 'Tokens Saved'}</div><div class="value token-value">${totalTokens.toLocaleString()}</div></div>
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><path d="M5 3h10a2 2 0 0 1 2 2v5l-7 3-7-3V5a2 2 0 0 1 2-2z" stroke="#f472b6" stroke-width="1.5" stroke-linejoin="round"/><path d="M3 10v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" stroke="#f472b6" stroke-width="1.5" stroke-linejoin="round"/><line x1="10" y1="3" x2="10" y2="13" stroke="#f472b6" stroke-width="1.5"/></svg>${isSpanish ? 'Archivos evitados' : 'Files Avoided'}</div><div class="value">${totalFiles.toLocaleString()}</div></div>${totalDbSizeMb > 0 ? `
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><rect x="3" y="2" width="14" height="16" rx="2" stroke="#22d3ee" stroke-width="1.5"/><line x1="7" y1="8" x2="13" y2="8" stroke="#22d3ee" stroke-width="1.5"/><line x1="7" y1="12" x2="11" y2="12" stroke="#22d3ee" stroke-width="1.5"/></svg>${isSpanish ? 'Tamaño BD' : 'DB Size'}</div><div class="value">${totalDbSizeMb} MB</div></div>` : ''}${totalLlmCalls > 0 ? `
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><circle cx="10" cy="10" r="7" stroke="#a78bfa" stroke-width="1.5"/><path d="M7 10h6M10 7v6" stroke="#a78bfa" stroke-width="1.5" stroke-linecap="round"/></svg>${isSpanish ? 'LLM llamadas' : 'LLM Calls'}</div><div class="value">${totalLlmCalls.toLocaleString()}</div></div>` : ''}${totalErrors > 0 ? `
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><circle cx="10" cy="10" r="7" stroke="#ef4444" stroke-width="1.5"/><line x1="7" y1="7" x2="13" y2="13" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round"/><line x1="13" y1="7" x2="7" y2="13" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round"/></svg>${isSpanish ? 'Errores' : 'Errors'}</div><div class="value" style="color:#ef4444">${totalErrors}</div></div>` : ''}
      </section>

      <section class="value-strip">
        <b>${isSpanish ? 'Por qué LYNX importa' : 'Why LYNX matters'}</b>
        <span>${isSpanish ? `${totalHotspots.toLocaleString()} puntos críticos detectados en ${totalIndexedFiles.toLocaleString()} archivos. La exploración inicial evitó aproximadamente ${totalTokens.toLocaleString()} tokens en local.` : `${totalHotspots.toLocaleString()} hotspots detected across ${totalIndexedFiles.toLocaleString()} files. First-pass exploration avoided roughly ${totalTokens.toLocaleString()} tokens locally.`}</span>
      </section>

      <div class="graph-toolbar">
        <h2 style="margin:0 8px 0 0">${isSpanish ? 'Grafo de acción' : 'Action Graph'}</h2>
        <select id="projectSelect" aria-label="${isSpanish ? 'Seleccionar proyecto' : 'Select project'}" style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:8px 10px;font-size:13px;max-width:220px">
          ${cards.map((c) => `<option value="${escapeHtml(c.name)}"${c.name === graphProject ? ' selected' : ''}>${escapeHtml(c.displayName)}</option>`).join('')}
        </select>
        <span style="color:#475569;margin:0 4px">|</span>
        <button data-layout="force" class="active">${isSpanish ? 'Fuerza' : 'Force'}</button>
        <button data-layout="ring">${isSpanish ? 'Anillo' : 'Ring'}</button>
        <button data-mode="value" class="active">${isSpanish ? 'Valor' : 'Value'}</button>
        <button data-mode="risk">${isSpanish ? 'Riesgo' : 'Risk'}</button>
        <button data-mode="entry">${isSpanish ? 'Entrada' : 'Entry'}</button>
        <button data-mode="hotspot">${isSpanish ? 'Críticos' : 'Hotspots'}</button>
      </div>
      <section class="action-graph">
        <div class="card graph-shell">
          <button class="fullscreen-btn" id="graphFullscreen" type="button" title="Pantalla completa" aria-label="Pantalla completa">⛶</button>
          <div class="fullscreen-left" aria-label="Fullscreen graph controls">
            <div class="fs-mode-bar">
              <button data-fs-layout="force" class="active" type="button">Force</button>
              <button data-fs-layout="ring" type="button">Ring</button>
              <span style="color:#475569;margin:0 2px">|</span>
              <button data-fs-mode="value" class="active" type="button">Value</button>
              <button data-fs-mode="risk" type="button">Risk</button>
              <button data-fs-mode="entry" type="button">Entry</button>
              <button data-fs-mode="hotspot" type="button">Hotspots</button>
            </div>
            <div class="fs-project-list">
              ${fullscreenProjects}
            </div>
          </div>
          <canvas id="actionGraph" width="960" height="520" aria-label="LYNX 3D action graph"></canvas>
          <aside class="card detail-panel fullscreen-detail" id="graphFullscreenDetail"></aside>
          <div class="graph-legend">
            <span><i class="legend-dot" style="background:#22c55e"></i>value</span>
            <span><i class="legend-dot" style="background:#ef4444"></i>risky edit</span>
            <span><i class="legend-dot" style="background:#38bdf8"></i>entry point</span>
            <span><i class="legend-dot" style="background:#f59e0b"></i>hotspot</span>
          </div>
        </div>
        <aside class="card detail-panel" id="graphDetail">
          <h3>${isSpanish ? 'Mapa de arquitectura accionable' : 'Actionable architecture map'}</h3>
          <p>${isSpanish ? 'LYNX muestra el grafo por valor operativo: ahorro de contexto, riesgo, puntos de entrada y puntos críticos. Haz clic en un nodo para inspeccionarlo.' : 'LYNX shows the graph by operational value: context savings, risk, entry points and hotspots. Click a node to inspect it.'}</p>
          <span class="detail-pill">${isSpanish ? 'arrastrar para rotar' : 'drag to rotate'}</span>
          <span class="detail-pill">${isSpanish ? 'rueda para ampliar' : 'wheel to zoom'}</span>
        </aside>
      </section>

      <section class="brief-card" id="projectBriefCard">
        <h2>Architecture Brief</h2>
        <div id="projectBriefLive" ${primaryBrief ? '' : 'style="display:none"'}>
          <div class="brief-meta">
            <span class="detail-pill" id="projectBriefProject">${escapeHtml(cards.find((c) => c.brief)?.displayName || '')}</span>
            <span class="detail-pill" id="projectBriefDate">${primaryBrief ? `generated ${escapeHtml(primaryBrief.generated_at)}` : ''}</span>
            <span class="detail-pill">cached</span>
          </div>
          <div class="brief-carousel" id="projectBriefCarousel">
            <button class="brief-nav prev" id="briefPrev" type="button" aria-label="Previous">&lsaquo;</button>
            <div class="brief-track" id="projectBriefTrack"></div>
            <button class="brief-nav next" id="briefNext" type="button" aria-label="Next">&rsaquo;</button>
          </div>
          <div class="brief-dots" id="projectBriefDots"></div>
        </div>
        <div id="projectBriefLoading" ${primaryBrief ? 'style="display:none"' : ''}>
          <div class="brief-loading">
            <div class="brief-loading-label"><span class="brief-loading-dot"></span>Scanning indexed data for <b id="briefLoadingProjectName">${escapeHtml(graphProject)}</b>...</div>
            <div class="brief-data-grid" id="briefDataGrid">
              <div class="brief-data-tile"><span class="bdt-label">Nodes</span><span class="bdt-value" data-target="${cards[0]?.nodes || 0}">0</span></div>
              <div class="brief-data-tile"><span class="bdt-label">Edges</span><span class="bdt-value" data-target="${cards[0]?.edges || 0}">0</span></div>
              <div class="brief-data-tile"><span class="bdt-label">Files</span><span class="bdt-value" data-target="${cards[0]?.filesIndexed || 0}">0</span></div>
              <div class="brief-data-tile"><span class="bdt-label">Hotspots</span><span class="bdt-value" data-target="${cards[0]?.hotspots || 0}">0</span></div>
              <div class="brief-data-tile"><span class="bdt-label">Risky Nodes</span><span class="bdt-value" data-target="${cards[0]?.riskyNodes || 0}">0</span></div>
              <div class="brief-data-tile"><span class="bdt-label">Entry Points</span><span class="bdt-value" data-target="${cards[0]?.entryPoints || 0}">0</span></div>
              <div class="brief-data-tile"><span class="bdt-label">Edge Types</span><span class="bdt-value" data-target="${cards[0]?.edgeTypes || 0}">0</span></div>
              <div class="brief-data-tile"><span class="bdt-label">Tokens Saved</span><span class="bdt-value" data-target="${cards[0]?.tokensSaved || 0}">0</span></div>
            </div>
            <div class="brief-progress-bar"><div class="brief-progress-fill" id="briefProgressFill"></div></div>
            <div class="brief-phase-text" id="briefPhaseText">Reading graph...</div>
          </div>
        </div>
      </section>
    </section>

    <!-- Savings tab -->
    <section class="tab-panel" id="tab-savings">
      <!-- Measured Impact — real data from persisted events only -->
      <section class="your-savings" id="measuredImpactSection">
        <h2>${isSpanish ? 'Impacto medido' : 'Measured Impact'}</h2>
        <p class="savings-subtitle">${isSpanish ? 'Datos reales acumulados de eventos registrados. Sin estimaciones fijas ni claims no verificables.' : 'Real accumulated data from recorded events. No fixed estimates or unverifiable claims.'}</p>

        <!-- Time window selector -->
        <div class="time-window-selector" id="timeWindowSelector">
          <button class="tw-btn active" data-window="total">${isSpanish ? 'Total' : 'Total'}</button>
          <button class="tw-btn" data-window="30d">30d</button>
          <button class="tw-btn" data-window="7d">7d</button>
          <button class="tw-btn" data-window="24h">24h</button>
        </div>

        <!-- Hero: live totals -->
        <div class="live-savings-hero" id="metricsHero">
          <div class="eyebrow" id="metricsEyebrow">${isSpanish ? 'Cargando métricas...' : 'Loading metrics...'}</div>
          <div class="big-save" id="metricsBigNumber">—</div>
          <p id="metricsSubtitle"></p>
          <div class="metrics-meta" id="metricsMeta" style="display:none">
            <span class="metric-badge measured" title="${isSpanish ? 'Dato medido de eventos reales' : 'Measured from real events'}">${isSpanish ? 'Medido' : 'Measured'}</span>
            <span class="metrics-updated" id="metricsUpdated"></span>
            <span class="metrics-sessions" id="metricsSessions"></span>
          </div>
        </div>

        <!-- Mutually exclusive category cards (populated by JS) -->
        <div class="live-savings-dims" id="measuredCategories"></div>

        <!-- Coverage indicator -->
        <div class="coverage-bar" id="coverageBar" style="display:none">
          <span class="coverage-indicator" id="coverageIndicator"></span>
          <span class="coverage-text" id="coverageText"></span>
        </div>
      </section>

      <!-- Scenarios Lab — clearly labeled as editable simulations -->
      <section class="savings-lab" id="savingsLab">
        <h2>${isSpanish ? 'Laboratorio de escenarios' : 'Scenarios Lab'}</h2>
        <p class="savings-subtitle" style="color:#f59e0b">${isSpanish ? 'SIMULACIONES EDITABLES — Estas cifras son escenarios hipotéticos, no datos reales acumulados. Separados del impacto medido.' : 'EDITABLE SIMULATIONS — These are hypothetical scenarios, not real accumulated data. Separate from measured impact.'}</p>
        <div class="scenario-tabs" id="scenarioTabs">
          <button class="scenario-tab active" data-scenario="daily-search">${isSpanish ? 'Descubrimiento diario' : 'Daily Discovery'}</button>
          <button class="scenario-tab" data-scenario="impact-analysis">${isSpanish ? 'Análisis de impacto' : 'Impact Analysis'}</button>
          <button class="scenario-tab" data-scenario="onboarding">${isSpanish ? 'Incorporación' : 'Onboarding'}</button>
          <button class="scenario-tab" data-scenario="multi-agent">${isSpanish ? 'Multiagente' : 'Multi-Agent'}</button>
          <button class="scenario-tab" data-scenario="monthly-team">${isSpanish ? 'Equipo de 5 / mes' : 'Team of 5 / Month'}</button>
        </div>
        <div class="scenario-body" id="scenarioBody">
          <div class="scenario-loading">${isSpanish ? 'Cargando escenarios...' : 'Loading scenarios...'}</div>
        </div>
      </section>
      <script id="savingsLabScript" type="text/javascript">${savingsLabScript(isSpanish)}</script>
      ${isSpanish ? `<script>(function(){var m={"Your LYNX savings":"Impacto medido","Measured Impact":"Impacto medido","Real accumulated data from recorded events. No fixed estimates or unverifiable claims.":"Datos reales acumulados de eventos registrados. Sin estimaciones fijas ni claims no verificables.","Scenarios Lab":"Laboratorio de escenarios","EDITABLE SIMULATIONS — These are hypothetical scenarios, not real accumulated data. Separate from measured impact.":"SIMULACIONES EDITABLES — Estas cifras son escenarios hipotéticos, no datos reales acumulados. Separados del impacto medido.","Daily Discovery":"Descubrimiento diario","Impact Analysis":"Análisis de impacto","Onboarding":"Incorporación","Multi-Agent":"Multiagente","Team of 5 / Month":"Equipo de 5 / mes","Without LYNX":"Sin LYNX","With LYNX":"Con LYNX","Discovery tokens":"Tokens de descubrimiento","Time spent":"Tiempo empleado","Tool calls":"Llamadas a herramientas","Hallucinated symbols":"Símbolos alucinados","Avg iterations/task":"Iteraciones medias/tarea","Rework time":"Tiempo de retrabajo","tokens saved":"tokens ahorrados","time saved":"tiempo ahorrado","operations avoided":"operaciones evitadas","Search ops avoided":"Operaciones de búsqueda evitadas","Wrong reads eliminated":"Lecturas erróneas eliminadas","Iterations saved":"Iteraciones ahorradas","Context contamination":"Contaminación de contexto","Projects":"Proyectos","Total Nodes":"Nodos totales","Total Edges":"Aristas totales","Indexed Files":"Archivos indexados","Tokens Saved":"Tokens ahorrados","Files Avoided":"Archivos evitados","Why LYNX matters":"Por qué LYNX importa","Action Graph":"Grafo de acción","Architecture Brief":"Resumen de arquitectura","Recent LYNX wins":"Victorias recientes de LYNX","View Savings breakdown →":"Ver desglose de ahorros →","Open graph":"Abrir grafo","Add project":"Añadir proyecto","local only — no cloud":"solo local — sin nube","Measured":"Medido","Estimated":"Estimado","Simulated":"Simulado","Not available":"No disponible"};function t(n){if(n.nodeType===3){var k=n.nodeValue.trim();if(m[k])n.nodeValue=n.nodeValue.replace(k,m[k]);}}function run(){var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);var a=[];while(w.nextNode())a.push(w.currentNode);a.forEach(t);}run();new MutationObserver(run).observe(document.body,{childList:true,subtree:true});})();</script>` : ''}
      <script id="measuredImpactScript" type="text/javascript">${measuredImpactScript(isSpanish)}</script>
    </section>

    <!-- Projects tab -->
    <section class="tab-panel" id="tab-projects">
      <div class="projects-header">
        <h2>${isSpanish ? 'Proyectos' : 'Projects'}</h2>
        <button class="add-project-btn" id="addProjectBtn" type="button" title="${isSpanish ? 'Añadir proyecto' : 'Add project'}" aria-label="${isSpanish ? 'Añadir proyecto' : 'Add project'}">+</button>
      </div>
      <div class="project-grid">
        ${cardHtml}
      </div>
    </section>

    <!-- Metrics tab -->
    <section class="tab-panel" id="tab-metrics">
      <section class="metrics-toolbar">
        <h2 style="margin:0 16px 0 0">${isSpanish ? 'Métricas' : 'Metrics'}</h2>
        <select id="metricsProject" aria-label="${isSpanish ? 'Proyecto' : 'Project'}" style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:8px 10px;font-size:13px">
          <option value="">${isSpanish ? 'Todos los proyectos' : 'All projects'}</option>
          ${cards.map((c) => `<option value="${escapeHtml(c.name)}"${c.name === graphProject ? ' selected' : ''}>${escapeHtml(c.displayName)}</option>`).join('')}
        </select>
        <span style="color:#475569;margin:0 6px">|</span>
        <button class="win-btn" data-win="24h">24h</button>
        <button class="win-btn" data-win="7d">7d</button>
        <button class="win-btn" data-win="30d">30d</button>
        <button class="win-btn active" data-win="total">${isSpanish ? 'Total' : 'Total'}</button>
        <span class="metrics-badge" id="metricsProvenance" style="margin-left:auto;color:#64748b;font-size:12px"></span>
      </section>
      <section class="metrics-summary" id="metricsSummary">
        <div class="metric-card"><div class="metric-label">${isSpanish ? 'Tokens ahorrados' : 'Tokens Saved'}</div><div class="metric-value" id="mtTokens">${totalTokens.toLocaleString()}</div><div class="metric-sub" id="mtTokensProv">${isSpanish ? 'Estimado' : 'Estimated'}</div></div>
        <div class="metric-card"><div class="metric-label">${isSpanish ? 'Archivos evitados' : 'Files Avoided'}</div><div class="metric-value" id="mtFiles">${totalFiles.toLocaleString()}</div><div class="metric-sub" id="mtFilesProv">${isSpanish ? 'Estimado' : 'Estimated'}</div></div>
        <div class="metric-card"><div class="metric-label">${isSpanish ? 'Eventos' : 'Events'}</div><div class="metric-value" id="mtEvents">—</div><div class="metric-sub" id="mtEventsProv">${isSpanish ? 'Medido' : 'Measured'}</div></div>
        <div class="metric-card"><div class="metric-label">${isSpanish ? 'Sesiones' : 'Sessions'}</div><div class="metric-value" id="mtSessions">—</div><div class="metric-sub" id="mtSessionsProv">${isSpanish ? 'Medido' : 'Measured'}</div></div>
        <div class="metric-card"><div class="metric-label">${isSpanish ? 'Tareas' : 'Tasks'}</div><div class="metric-value" id="mtTasks">—</div><div class="metric-sub" id="mtTasksProv">${isSpanish ? 'Medido' : 'Measured'}</div></div>
      </section>
      <section class="metrics-bars" id="metricsBars">
        <div class="bars-placeholder">${isSpanish ? 'Selecciona un proyecto y ventana para ver el desglose por categoría.' : 'Select a project and window to see category breakdown.'}</div>
      </section>
      <section class="metrics-coverage" id="metricsCoverage">
        <div class="coverage-text" id="mtCoverageText">${isSpanish ? 'Cargando métricas...' : 'Loading metrics...'}</div>
      </section>
    </section>
  </main>
  <div class="delete-modal-overlay" id="deleteProjectModal">
    <div class="delete-modal-box">
      <h3>${isSpanish ? '¿Eliminar' : 'Delete'} <span class="delete-project-name" id="deleteProjectName"></span>?</h3>
      <p>${isSpanish ? 'Se eliminarán el proyecto y todos sus datos indexados. Esta acción no se puede deshacer.' : 'This will remove the project and all its indexed data. This action cannot be undone.'}</p>
      <div class="delete-modal-actions">
        <button class="btn-delete-cancel" id="deleteProjectCancel" type="button">${isSpanish ? 'Cancelar' : 'Cancel'}</button>
        <button class="btn-delete-confirm" id="deleteProjectConfirm" type="button">${isSpanish ? 'Eliminar' : 'Delete'}</button>
      </div>
    </div>
  </div>
  <footer>
    LYNX Code Intelligence · ${isSpanish ? 'Todas las métricas son locales y privadas' : 'All metrics are local and private'}
  </footer>
  <script id="metricsTabScript" type="text/javascript">
(function(){
  var metricEls = {
    tokens: document.getElementById('mtTokens'),
    files: document.getElementById('mtFiles'),
    events: document.getElementById('mtEvents'),
    sessions: document.getElementById('mtSessions'),
    tasks: document.getElementById('mtTasks'),
    tokensProv: document.getElementById('mtTokensProv'),
    filesProv: document.getElementById('mtFilesProv'),
    eventsProv: document.getElementById('mtEventsProv'),
    sessionsProv: document.getElementById('mtSessionsProv'),
    tasksProv: document.getElementById('mtTasksProv'),
    bars: document.getElementById('metricsBars'),
    coverage: document.getElementById('mtCoverageText'),
  };
  var isSpanish = ${isSpanish};
  var CAT_COLORS = ['#38bdf8','#22d3ee','#a78bfa','#f59e0b','#f472b6','#4ade80','#94a3b8'];

  function provBadge(kind) {
    if (kind === 'measured') return '<span class="metrics-badge prov-measured">' + (isSpanish ? 'Medido' : 'Measured') + '</span>';
    if (kind === 'estimated') return '<span class="metrics-badge prov-estimated">' + (isSpanish ? 'Estimado' : 'Estimated') + '</span>';
    return '<span class="metrics-badge prov-scenario">' + (isSpanish ? 'Simulado' : 'Simulated') + '</span>';
  }

  function fmt(n) { return n != null ? Number(n).toLocaleString() : '—'; }

  function loadMetrics() {
    var project = document.getElementById('metricsProject').value;
    var win = document.querySelector('.win-btn.active') ? document.querySelector('.win-btn.active').dataset.win : 'total';
    var url = '/api/metrics?window=' + win;
    if (project) url += '&project=' + encodeURIComponent(project);

    // Show loading state
    if (metricEls.events) metricEls.events.textContent = '...';

    fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var t = d.totals;
        // Update summary cards
        if (metricEls.tokens) metricEls.tokens.textContent = fmt(t.tokens_saved);
        if (metricEls.files) metricEls.files.textContent = fmt(t.files_avoided);
        if (metricEls.events) metricEls.events.textContent = fmt(t.events);
        if (metricEls.sessions) metricEls.sessions.textContent = fmt(t.sessions);
        if (metricEls.tasks) metricEls.tasks.textContent = fmt(t.tasks);

        // Provenance badges from first matching metrics
        var metaByKey = {};
        (d.metrics || []).forEach(function(m) { metaByKey[m.key] = m.provenance; });

        if (metricEls.tokensProv && metaByKey.tokens_saved)
          metricEls.tokensProv.innerHTML = provBadge(metaByKey.tokens_saved.kind);
        if (metricEls.filesProv && metaByKey.files_avoided)
          metricEls.filesProv.innerHTML = provBadge(metaByKey.files_avoided.kind);
        if (metricEls.eventsProv && metaByKey.events)
          metricEls.eventsProv.innerHTML = provBadge(metaByKey.events.kind);
        if (metricEls.sessionsProv && metaByKey.sessions)
          metricEls.sessionsProv.innerHTML = provBadge(metaByKey.sessions.kind);
        if (metricEls.tasksProv && metaByKey.tasks)
          metricEls.tasksProv.innerHTML = provBadge(metaByKey.tasks.kind);

        // Category bars
        var cats = d.categories || [];
        if (cats.length === 0) {
          if (metricEls.bars)
            metricEls.bars.innerHTML = '<div class="bars-placeholder">' + (isSpanish ? 'Sin datos de categoría para esta ventana.' : 'No category data for this window.') + '</div>';
        } else {
          var maxTokens = Math.max.apply(null, cats.map(function(c) { return c.tokens_saved; })) || 1;
          var html = '';
          cats.forEach(function(c, i) {
            var pct = Math.round((c.tokens_saved / maxTokens) * 100);
            var color = CAT_COLORS[i % CAT_COLORS.length];
            html += '<div class="bar-row">' +
              '<div class="bar-label">' + c.label + '</div>' +
              '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '" title="' + fmt(c.tokens_saved) + ' tokens, ' + c.events + ' events"></div></div>' +
              '<div class="bar-value">' + fmt(c.tokens_saved) + ' <span style="color:#64748b;font-size:11px">' + c.events + ' ev</span></div>' +
              '</div>';
          });
          if (metricEls.bars) metricEls.bars.innerHTML = html;
        }

        // Coverage
        if (metricEls.coverage) metricEls.coverage.textContent = d.coverage ? d.coverage.summary : '';

        // Historical unclassified warning
        if (d.historical_unclassified && d.historical_unclassified.tokens_saved > 0) {
          if (metricEls.bars) {
            var w = document.createElement('div');
            w.className = 'bars-placeholder';
            w.style.color = '#fbbf24';
            w.textContent = (isSpanish ? '⚠️ ' : '⚠️ ') + fmt(d.historical_unclassified.tokens_saved) + ' tokens ' + (isSpanish ? 'no clasificables (datos legacy sin eventos detallados).' : 'unclassified (legacy data without detailed events).');
            metricEls.bars.appendChild(w);
          }
        }
      })
      .catch(function() {
        if (metricEls.events) metricEls.events.textContent = 'err';
      });
  }

  // Window buttons
  document.querySelectorAll('.win-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.win-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      loadMetrics();
    });
  });

  // Project selector
  var projSelect = document.getElementById('metricsProject');
  if (projSelect) {
    projSelect.addEventListener('change', loadMetrics);
  }

  // Load on tab switch
  var metricsTabBtn = document.querySelector('[data-tab="metrics"]');
  if (metricsTabBtn) {
    metricsTabBtn.addEventListener('click', function() { setTimeout(loadMetrics, 50); });
  }

  // Initial load if metrics tab is active
  if (window.location.hash === '#metrics') {
    setTimeout(loadMetrics, 100);
  }
})();
</script>
  <script>
    window.LYNX_INITIAL_PROJECT = ${JSON.stringify(graphProject)};
    window.LYNX_PROJECT_BRIEFS = ${JSON.stringify(briefPayload)};
${actionGraphScript()}
${webSocketScript()}
${tabScript()}
(function(){
  function addProject(){
    var btn=document.getElementById('addProjectBtn');
    if(btn){btn.disabled=true;btn.textContent='...';}
    var btnTab=document.getElementById('addProjectBtnTab');
    if(btnTab){btnTab.disabled=true;btnTab.innerHTML='<span class="plus-circle">...</span> Indexando...';}
    fetch('/api/pick-folder')
      .then(function(r){return r.json();})
      .then(function(d){
        if(!d.path){resetButtons();return;}
        var name=d.path.split('/').filter(Boolean).pop()||'project';
        return fetch('/api/projects/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_name:name,project_path:d.path})});
      })
      .then(function(r){
        if(r&&r.ok){setTimeout(function(){location.reload();},1200);}
        else{resetButtons();}
      })
      .catch(function(){resetButtons();});
    function resetButtons(){
      if(btn){btn.disabled=false;btn.textContent='+';}
      if(btnTab){btnTab.disabled=false;btnTab.innerHTML='<span class="plus-circle">+</span> Proyecto';}
    }
  }
  var projectsBtn=document.getElementById('addProjectBtn');
  var tabBtn=document.getElementById('addProjectBtnTab');
  if(projectsBtn)projectsBtn.addEventListener('click',addProject);
  if(tabBtn)tabBtn.addEventListener('click',addProject);

  // Delete project
  var deleteModal=document.getElementById('deleteProjectModal');
  var deleteNameEl=document.getElementById('deleteProjectName');
  var deleteCancel=document.getElementById('deleteProjectCancel');
  var deleteConfirm=document.getElementById('deleteProjectConfirm');
  var pendingDeleteProject='';
  function openDeleteModal(projectName, displayName, e){
    e.stopPropagation();e.preventDefault();
    pendingDeleteProject=projectName;
    deleteNameEl.textContent=displayName;
    deleteModal.classList.add('open');
  }
  function closeDeleteModal(){
    deleteModal.classList.remove('open');
    pendingDeleteProject='';
  }
  deleteCancel.addEventListener('click',closeDeleteModal);
  deleteModal.addEventListener('click',function(e){if(e.target===deleteModal)closeDeleteModal();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&deleteModal.classList.contains('open'))closeDeleteModal();});
  deleteConfirm.addEventListener('click',function(){
    if(!pendingDeleteProject)return;
    deleteConfirm.disabled=true;deleteConfirm.textContent='Deleting...';
    fetch('/api/projects/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_name:pendingDeleteProject})})
      .then(function(r){return r.json();})
      .then(function(){closeDeleteModal();setTimeout(function(){location.reload();},800);})
      .catch(function(){deleteConfirm.disabled=false;deleteConfirm.textContent='Delete';});
  });

  // Wire X buttons (delegated on document since cards update via WebSocket)
  document.addEventListener('click',function(e){
    var deleteBtn=e.target.closest('.card-delete-btn');
    if(!deleteBtn)return;
    openDeleteModal(deleteBtn.dataset.deleteProject, deleteBtn.dataset.deleteName, e);
  });

  // Brief data reveal — slow counter animation (named fn so it can restart on project switch)
  var briefIntroTimer = null;
  var briefIntroRunning = false;

  function setTileTargets(counts) {
    var labelToProp = {
      'Nodes': 'nodes',
      'Edges': 'edges',
      'Files': 'files',
      'Hotspots': 'hotspots',
      'Risky Nodes': 'risky',
      'Entry Points': 'entry',
      'Edge Types': 'edgeTypes',
      'Tokens Saved': 'tokens',
    };
    var tiles = document.querySelectorAll('#briefDataGrid .brief-data-tile');
    tiles.forEach(function(t) {
      var label = t.querySelector('.bdt-label');
      var value = t.querySelector('.bdt-value');
      if (!label || !value) return;
      var prop = labelToProp[label.textContent];
      if (!prop || counts[prop] === undefined) return;
      value.setAttribute('data-target', String(counts[prop]));
    });
  }

  function startBriefIntro(countsFromActionGraph) {
    var grid = document.getElementById('briefDataGrid');
    var bar = document.getElementById('briefProgressFill');
    var phase = document.getElementById('briefPhaseText');
    var loading = document.getElementById('projectBriefLoading');
    if (!grid || !bar || !phase || !loading) return;
    if (loading.style.display === 'none') return;

    // If action graph data arrived, update targets to actionable counts
    if (countsFromActionGraph) setTileTargets(countsFromActionGraph);

    // Cancel any running intro
    if (briefIntroTimer) clearTimeout(briefIntroTimer);
    briefIntroRunning = true;
    window.briefIntroDone = false;
    window.pendingBriefProject = null;

    var tiles = grid.querySelectorAll('.brief-data-tile');
    if (!tiles.length) return;

    // Reset all tiles
    tiles.forEach(function(tile) {
      tile.classList.remove('revealed');
      var v = tile.querySelector('.bdt-value');
      if (v) { v.textContent = '0'; v.classList.remove('counting'); }
    });
    if (bar) bar.style.width = '0%';
    if (phase) { phase.textContent = 'Reading graph...'; phase.classList.remove('awaiting'); }

    var phases = ['Reading graph...', 'Computing risk scores...', 'Detecting hotspots...', 'Mapping entry points...', 'Calculating value metrics...', 'Structuring analysis...', 'Synthesizing architecture brief...'];
    var total = tiles.length;
    var i = 0;

    function animateCounter(valueEl, target) {
      return new Promise(function(resolve) {
        if (target === 0) {
          valueEl.textContent = '0';
          valueEl.classList.remove('counting');
          resolve();
          return;
        }
        valueEl.classList.add('counting');
        var duration = 2600 + Math.random() * 500;
        var start = performance.now();
        function tick(now) {
          var elapsed = now - start;
          var t = Math.min(elapsed / duration, 1);
          var eased = 1 - Math.pow(1 - t, 3);
          var current = Math.round(eased * target);
          valueEl.textContent = current.toLocaleString();
          if (t < 1) {
            requestAnimationFrame(tick);
          } else {
            valueEl.textContent = target.toLocaleString();
            valueEl.classList.remove('counting');
            resolve();
          }
        }
        requestAnimationFrame(tick);
      });
    }

    function revealNext() {
      if (i >= total) {
        if (bar) bar.style.width = '100%';
        if (phase) { phase.textContent = 'Awaiting deep analysis...'; phase.classList.add('awaiting'); }
        briefIntroRunning = false;
        window.briefIntroDone = true;
        if (window.pendingBriefProject && window.LYNX_PROJECT_BRIEFS && window.LYNX_PROJECT_BRIEFS[window.pendingBriefProject]) {
          if (typeof renderProjectBrief === 'function') renderProjectBrief(window.pendingBriefProject);
        }
        return;
      }
      var tile = tiles[i];
      tile.classList.add('revealed');
      if (bar) bar.style.width = Math.round((i + 1) / total * 100) + '%';
      var phaseIdx = Math.min(Math.floor(i / Math.max(1, total / phases.length)), phases.length - 1);
      if (phase) phase.textContent = phases[phaseIdx];

      var valueEl = tile.querySelector('.bdt-value');
      var raw = valueEl ? valueEl.getAttribute('data-target') : '0';
      var target = parseInt(raw, 10) || 0;
      animateCounter(valueEl, target).then(function() {
        i++;
        briefIntroTimer = setTimeout(revealNext, 1000 + Math.random() * 500);
      });
    }

    briefIntroTimer = setTimeout(revealNext, 500);
  }

  // Helper: fetch action graph counts for a project, then start intro
  function startBriefIntroWithGraph(project) {
    if (!project) { startBriefIntro(); return; }
    var fallbackTimer = setTimeout(function() { startBriefIntro(); }, 2000);
    var resolved = false;
    fetch('/api/action-graph?project=' + encodeURIComponent(project) + '&mode=value')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (resolved) return;
        resolved = true;
        clearTimeout(fallbackTimer);
        if (!data || !data.role_counts) { startBriefIntro(); return; }
        startBriefIntro({
          nodes: data.total_nodes || 0,
          edges: data.total_edges || 0,
          hotspots: data.role_counts.hotspot || 0,
          risky: data.role_counts.risk || 0,
          entry: data.role_counts.entry || 0,
        });
      })
      .catch(function() {
        if (resolved) return;
        resolved = true;
        clearTimeout(fallbackTimer);
        startBriefIntro();
      });
  }

  // Kick off on page load
  (function initBriefIntro() {
    var project = typeof activeProject !== 'undefined' ? activeProject : (window.LYNX_INITIAL_PROJECT || '');
    startBriefIntroWithGraph(project);
  })();
})();
  </script>
</body>
</html>`;
}
