/*
 * dashboard/html.ts — Dashboard HTML template (orchestrator).
 */

import { readLynxConfig } from '../../config/runtime.js';
import { escapeHtml, savingsLabScript, measuredImpactScript } from './utils.js';
import { renderStyles } from './styles.js';
import { metricsTabScript } from './scripts/metrics-tab.js';
import { mainInitScript } from './scripts/main-init.js';
import { settingsTabScript } from './scripts/settings-tab.js';
import { projectHealth, type ProjectCard } from './data.js';

function renderProjectCard(c: ProjectCard, isSpanish: boolean): string {
  const health = projectHealth(c, isSpanish);
  return `
    <div class="project-card-wrap">
    <button class="card project-card" type="button" data-project-card="${escapeHtml(c.name)}" aria-label="Show ${escapeHtml(c.displayName)} graph">
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
      <div class="ops-row">${c.hoursSinceIndex !== null ? `<span>${c.hoursSinceIndex}h</span>` : ''}${c.llmCalls > 0 ? `<span>${c.llmProvider || 'LLM'}: ${c.llmCalls} calls${c.llmCostUsd > 0 ? ' · $' + c.llmCostUsd.toFixed(4) : ''}</span>` : ''}${c.errorCount > 0 ? `<span style="color:#fca5a5">${c.errorCount} ${isSpanish ? 'errores' : 'errors'}</span>` : ''}</div>
      <div class="open-graph">${isSpanish ? 'Abrir grafo' : 'Open graph'}</div>
    </button>
    <button class="card-delete-btn" type="button" data-delete-project="${escapeHtml(c.name)}" data-delete-name="${escapeHtml(c.displayName)}" aria-label="${isSpanish ? 'Eliminar' : 'Delete'} ${escapeHtml(c.displayName)}" title="${isSpanish ? 'Eliminar proyecto' : 'Delete project'}">&#x2715;</button>
    </div>`;
}

function renderFullscreenProject(c: ProjectCard, isSpanish: boolean): string {
  const health = projectHealth(c, isSpanish);
  return `
    <button class="fs-project-card" type="button" data-fs-project="${escapeHtml(c.name)}" aria-label="Show ${escapeHtml(c.displayName)} graph">
      <div><b>${escapeHtml(c.displayName)}</b><span class="health-pill ${health.className}">${health.label}</span></div>
      <span>${c.nodes.toLocaleString()} nodes · ${c.hotspots.toLocaleString()} hotspots · ${c.riskyNodes.toLocaleString()} risky</span>
      <span>${c.tokensSaved.toLocaleString()} tokens saved</span>
    </button>`;
}

export function renderDashboard(cards: ProjectCard[]): string {
  const runtimeConfig = readLynxConfig();
  const isSpanish = runtimeConfig.locale === 'es';
  const lynxEnabled = runtimeConfig.enabled;
  const totalTokens = cards.reduce((s, c) => s + c.tokensSaved, 0);
  const totalFiles = cards.reduce((s, c) => s + c.filesAvoided, 0);
  const totalNodes = cards.reduce((s, c) => s + c.nodes, 0);
  const totalEdges = cards.reduce((s, c) => s + c.edges, 0);
  const totalIndexedFiles = cards.reduce((s, c) => s + c.filesIndexed, 0);
  const totalHotspots = cards.reduce((s, c) => s + c.hotspots, 0);
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
  const graphProject = cards[0]?.name || '';

  const cardHtml = cards.length === 0
    ? `<div class="card" style="grid-column:1/-1"><p>${isSpanish ? 'Aún no hay proyectos indexados. Ejecuta primero' : 'No indexed projects yet. Run'} <code>LYNX index /path/to/project</code>${isSpanish ? ' primero.' : '.'}</p></div>`
    : cards.map((c) => renderProjectCard(c, isSpanish)).join('\n');

  const fullscreenProjects = cards.map((c) => renderFullscreenProject(c, isSpanish)).join('\n');

  const labels = isSpanish ? {
    projects: 'Proyectos', totalNodes: 'Nodos totales', totalEdges: 'Aristas totales',
    indexedFiles: 'Archivos indexados', tokensSaved: 'Tokens ahorrados', filesAvoided: 'Archivos evitados',
    llmCalls: 'LLM llamadas', errors: 'Errores',
    actionGraph: 'Grafo de acción', force: 'Fuerza', ring: 'Anillo', value: 'Valor', risk: 'Riesgo',
    entry: 'Entrada', hotspots: 'Críticos', graphTitle: 'Mapa de arquitectura accionable',
    graphDesc: 'LYNX muestra el grafo por valor operativo: ahorro de contexto, riesgo, puntos de entrada y puntos críticos. Haz clic en un nodo para inspeccionarlo.',
    dragToRotate: 'arrastrar para rotar', wheelToZoom: 'rueda para ampliar',
    overview: 'Resumen', projectsTab: 'Proyectos', savings: 'Ahorros', metrics: 'Métricas', settings: 'Configuración',
    localOnly: 'solo local — sin nube', briefLoad: 'Analizando datos indexados',
    savedProjects: 'Proyectos', addProject: 'Añadir proyecto',
    fullscreen: 'Pantalla completa', fullscreenControls: 'Controles del grafo a pantalla completa',
    briefTitle: 'Resumen de arquitectura', briefCached: 'en caché',
    legendValue: 'valor', legendRisk: 'edición arriesgada', legendEntry: 'punto de entrada', legendHotspot: 'punto crítico',
    deleteTitle: '¿Eliminar', deleteBody: 'Se eliminarán el proyecto y todos sus datos indexados. Esta acción no se puede deshacer.',
    apiKeysSection: 'Claves API', preferencesSection: 'Preferencias',
    agentResponseSection: 'Respuestas de agentes',
    agentResponseHelp: 'Indica a Codex, Claude y otros clientes MCP cómo de concisas deben ser sus respuestas tras usar LYNX. No recorta el código ni pierde evidencia.',
    agentResponseEnable: 'Optimizar respuestas', agentResponseLength: 'Extensión', agentResponseStyle: 'Estilo', agentResponseBudget: 'Presupuesto', agentResponseInterval: 'Recordatorio',
    agentResponseMaxSavings: 'Máximo ahorro', agentResponseBalancedBudget: 'Equilibrado', agentResponseThorough: 'Completo',
    agentResponseShort: 'Corta', agentResponseMedium: 'Media', agentResponseLong: 'Detallada',
    agentResponseConcise: 'Directo', agentResponseBalanced: 'Equilibrado', agentResponseDetailed: 'Explicativo',
    agentResponseEvery: 'Cada', agentResponseMinutes: 'minutos', agentResponseSaved: 'Preferencia guardada',
    deepseekKey: 'DeepSeek API Key', vpsUrl: 'URL VPS', vpsKey: 'VPS API Key',
    save: 'Guardar', saved: 'Guardado', saving: 'Guardando...', loaded: '(configurada)',
    autoIndex: 'Auto-index', autoWatch: 'Auto-watch',
    autoDashboard: 'Dashboard automático', indexLimit: 'Límite de indexación', staleHours: 'Índice desactualizado', lockMinutes: 'Bloqueo caducado',
    cancel: 'Cancelar', delete: 'Eliminar',
    panelTitle: 'Panel de LYNX',
  } : {
    projects: 'Projects', totalNodes: 'Total Nodes', totalEdges: 'Total Edges',
    indexedFiles: 'Indexed Files', tokensSaved: 'Tokens Saved', filesAvoided: 'Files Avoided',
    llmCalls: 'LLM Calls', errors: 'Errors',
    actionGraph: 'Action Graph', force: 'Force', ring: 'Ring', value: 'Value', risk: 'Risk',
    entry: 'Entry', hotspots: 'Hotspots', graphTitle: 'Actionable architecture map',
    graphDesc: 'LYNX shows the graph by operational value: context savings, risk, entry points and hotspots. Click a node to inspect it.',
    dragToRotate: 'drag to rotate', wheelToZoom: 'wheel to zoom',
    overview: 'Overview', projectsTab: 'Projects', savings: 'Savings', metrics: 'Metrics', settings: 'Settings',
    localOnly: 'local only — no cloud', briefLoad: 'Scanning indexed data',
    savedProjects: 'Projects', addProject: 'Add project',
    fullscreen: 'Fullscreen', fullscreenControls: 'Fullscreen graph controls',
    briefTitle: 'Architecture Brief', briefCached: 'cached',
    legendValue: 'value', legendRisk: 'risky edit', legendEntry: 'entry point', legendHotspot: 'hotspot',
    deleteTitle: 'Delete', deleteBody: 'This will remove the project and all its indexed data. This action cannot be undone.',
    apiKeysSection: 'API Keys', preferencesSection: 'Preferences',
    agentResponseSection: 'Agent responses',
    agentResponseHelp: 'Tells Codex, Claude, and other MCP clients how concise their responses should be after using LYNX. It never trims code or removes evidence.',
    agentResponseEnable: 'Optimize responses', agentResponseLength: 'Length', agentResponseStyle: 'Style', agentResponseBudget: 'Budget', agentResponseInterval: 'Reminder',
    agentResponseMaxSavings: 'Maximum savings', agentResponseBalancedBudget: 'Balanced', agentResponseThorough: 'Thorough',
    agentResponseShort: 'Short', agentResponseMedium: 'Medium', agentResponseLong: 'Detailed',
    agentResponseConcise: 'Direct', agentResponseBalanced: 'Balanced', agentResponseDetailed: 'Explanatory',
    agentResponseEvery: 'Every', agentResponseMinutes: 'minutes', agentResponseSaved: 'Preference saved',
    deepseekKey: 'DeepSeek API Key', vpsUrl: 'VPS URL', vpsKey: 'VPS API Key',
    save: 'Save', saved: 'Saved', saving: 'Saving...', loaded: '(configured)',
    autoIndex: 'Auto-index', autoWatch: 'Auto-watch',
    autoDashboard: 'Auto dashboard', indexLimit: 'Indexing limit', staleHours: 'Stale index', lockMinutes: 'Expired lock',
    cancel: 'Cancel', delete: 'Delete',
    panelTitle: 'LYNX Dashboard',
  };

  return `<!doctype html>
<html lang="${isSpanish ? 'es' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self' data:;">
  <title>${labels.panelTitle}</title>
  <style>${renderStyles()}</style>
</head>
<body>
  <header>
    <h1>${labels.panelTitle}</h1>
    <div class="header-controls"><button id="lynxEnabledToggle" class="lynx-enabled-toggle ${lynxEnabled ? 'is-enabled' : 'is-disabled'}" type="button" aria-pressed="${lynxEnabled}" title="${isSpanish ? 'Activar o desactivar LYNX globalmente' : 'Enable or disable LYNX globally'}"><span class="lynx-enabled-dot"></span><span id="lynxEnabledLabel">${lynxEnabled ? (isSpanish ? 'LYNX activo' : 'LYNX active') : (isSpanish ? 'LYNX desactivado' : 'LYNX disabled')}</span></button><select id="localeSelect" aria-label="Language"><option value="es"${isSpanish ? ' selected' : ''}>ES</option><option value="en"${!isSpanish ? ' selected' : ''}>EN</option></select><span class="badge">${labels.localOnly}</span></div>
  </header>
  <nav class="tab-bar">
    <button class="tab-btn active" data-tab="overview"><span class="tab-icon">&#9670;</span>${labels.overview}</button>
    <button class="tab-btn" data-tab="projects"><span class="tab-icon">&#9776;</span>${labels.projectsTab}</button>
    <button class="tab-btn" data-tab="savings"><span class="tab-icon">&#9733;</span>${labels.savings}</button>
    <button class="tab-btn" data-tab="metrics"><span class="tab-icon">&#9776;</span>${labels.metrics}</button>
    <button class="tab-btn" data-tab="settings"><span class="tab-icon">&#9881;</span>${labels.settings}</button>
    <button class="add-project-btn-tab" id="addProjectBtnTab" type="button"><span class="plus-circle">+</span> ${labels.addProject}</button>
  </nav>
  <main>
    <!-- Overview tab -->
    <section class="tab-panel active" id="tab-overview">
      <section class="summary-grid">
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><rect x="3" y="2" width="5" height="5" rx="1" stroke="#22d3ee" stroke-width="1.5"/><rect x="12" y="2" width="5" height="5" rx="1" stroke="#22d3ee" stroke-width="1.5"/><rect x="3" y="13" width="5" height="5" rx="1" stroke="#22d3ee" stroke-width="1.5"/><rect x="12" y="13" width="5" height="5" rx="1" stroke="#22d3ee" stroke-width="1.5"/></svg>${labels.projects}</div><div class="value">${cards.length}</div></div>
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><circle cx="6" cy="6" r="2.5" stroke="#a78bfa" stroke-width="1.5"/><circle cx="14" cy="6" r="2.5" stroke="#a78bfa" stroke-width="1.5"/><circle cx="10" cy="14" r="2.5" stroke="#a78bfa" stroke-width="1.5"/><line x1="8" y1="7.5" x2="9.5" y2="12" stroke="#a78bfa" stroke-width="1.2"/><line x1="12" y1="7.5" x2="10.5" y2="12" stroke="#a78bfa" stroke-width="1.2"/></svg>${labels.totalNodes}</div><div class="value">${totalNodes.toLocaleString()}</div></div>
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><line x1="3" y1="3" x2="17" y2="17" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round"/><line x1="17" y1="3" x2="3" y2="17" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="4" r="2" stroke="#f59e0b" stroke-width="1.5"/><circle cx="4" cy="10" r="2" stroke="#f59e0b" stroke-width="1.5"/><circle cx="16" cy="10" r="2" stroke="#f59e0b" stroke-width="1.5"/><circle cx="10" cy="16" r="2" stroke="#f59e0b" stroke-width="1.5"/></svg>${labels.totalEdges}</div><div class="value">${totalEdges.toLocaleString()}</div></div>
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><path d="M4 3h6l3 3h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" stroke="#38bdf8" stroke-width="1.5" stroke-linejoin="round"/></svg>${labels.indexedFiles}</div><div class="value">${totalIndexedFiles.toLocaleString()}</div></div>
        <div class="summary-card"><div class="label"><span class="token-label-dollar">$</span>${labels.tokensSaved}</div><div class="value token-value">${totalTokens.toLocaleString()}</div></div>
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><path d="M5 3h10a2 2 0 0 1 2 2v5l-7 3-7-3V5a2 2 0 0 1 2-2z" stroke="#f472b6" stroke-width="1.5" stroke-linejoin="round"/><path d="M3 10v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" stroke="#f472b6" stroke-width="1.5" stroke-linejoin="round"/><line x1="10" y1="3" x2="10" y2="13" stroke="#f472b6" stroke-width="1.5"/></svg>${labels.filesAvoided}</div><div class="value">${totalFiles.toLocaleString()}</div></div>
${totalLlmCalls > 0 ? `
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><circle cx="10" cy="10" r="7" stroke="#a78bfa" stroke-width="1.5"/><path d="M7 10h6M10 7v6" stroke="#a78bfa" stroke-width="1.5" stroke-linecap="round"/></svg>${labels.llmCalls}</div><div class="value">${totalLlmCalls.toLocaleString()}</div></div>` : ''}${totalErrors > 0 ? `
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><circle cx="10" cy="10" r="7" stroke="#ef4444" stroke-width="1.5"/><line x1="7" y1="7" x2="13" y2="13" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round"/><line x1="13" y1="7" x2="7" y2="13" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round"/></svg>${labels.errors}</div><div class="value" style="color:#ef4444">${totalErrors}</div></div>` : ''}
      </section>


      <div class="graph-toolbar">
        <h2 style="margin:0 8px 0 0">${labels.actionGraph}</h2>
        <select id="projectSelect" aria-label="${isSpanish ? 'Seleccionar proyecto' : 'Select project'}" style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:8px 10px;font-size:13px;max-width:220px">
          ${cards.map((c) => `<option value="${escapeHtml(c.name)}"${c.name === graphProject ? ' selected' : ''}>${escapeHtml(c.displayName)}</option>`).join('')}
        </select>
        <span style="color:#475569;margin:0 4px">|</span>
        <button data-mode="value" class="active">${labels.value}</button>
        <button data-mode="risk">${labels.risk}</button>
        <button data-mode="entry">${labels.entry}</button>
        <button data-mode="hotspot">${labels.hotspots}</button>
      </div>
      <section class="action-graph">
        <div class="card graph-shell">
          <button class="fullscreen-btn" id="graphFullscreen" type="button" title="${labels.fullscreen}" aria-label="${labels.fullscreen}">⛶</button>
          <div class="fullscreen-left" aria-label="${labels.fullscreenControls}">
            <div class="fs-mode-bar">
              <button data-fs-layout="force" class="active" type="button">${labels.force}</button>
              <button data-fs-layout="ring" type="button">${labels.ring}</button>
              <span style="color:#475569;margin:0 2px">|</span>
              <button data-fs-mode="value" class="active" type="button">${labels.value}</button>
              <button data-fs-mode="risk" type="button">${labels.risk}</button>
              <button data-fs-mode="entry" type="button">${labels.entry}</button>
              <button data-fs-mode="hotspot" type="button">${labels.hotspots}</button>
            </div>
            <div class="fs-project-list">
              ${fullscreenProjects}
            </div>
          </div>
          <canvas id="actionGraph" width="960" height="520" aria-label="LYNX 3D action graph"></canvas>
          <aside class="card detail-panel fullscreen-detail" id="graphFullscreenDetail"></aside>
          <div class="graph-layout-controls">
            <button data-layout="force" class="active" type="button">${labels.force}</button>
            <button data-layout="ring" type="button">${labels.ring}</button>
          </div>
          <div class="graph-legend">
            <span><i class="legend-dot" style="background:#22c55e"></i>${labels.legendValue}</span>
            <span><i class="legend-dot" style="background:#ef4444"></i>${labels.legendRisk}</span>
            <span><i class="legend-dot" style="background:#38bdf8"></i>${labels.legendEntry}</span>
            <span><i class="legend-dot" style="background:#f59e0b"></i>${labels.legendHotspot}</span>
          </div>
        </div>
        <aside class="card detail-panel" id="graphDetail">
          <h3>${labels.graphTitle}</h3>
          <p>${labels.graphDesc}</p>
          <span class="detail-pill">${labels.dragToRotate}</span>
          <span class="detail-pill">${labels.wheelToZoom}</span>
        </aside>
      </section>

      <section class="brief-card" id="projectBriefCard">
        <h2>${labels.briefTitle}</h2>
        <div id="projectBriefLive" ${primaryBrief ? '' : 'style="display:none"'}>
          <div class="brief-meta">
            <span class="detail-pill" id="projectBriefProject">${escapeHtml(cards.find((c) => c.brief)?.displayName || '')}</span>
            <span class="detail-pill" id="projectBriefDate">${primaryBrief ? `generated ${escapeHtml(primaryBrief.generated_at)}` : ''}</span>
            <span class="detail-pill">${labels.briefCached}</span>
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
            <div class="brief-loading-label"><span class="brief-loading-dot"></span>${labels.briefLoad} <b id="briefLoadingProjectName">${escapeHtml(graphProject)}</b>...</div>
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
      <section class="your-savings" id="measuredImpactSection">
        <h2>${isSpanish ? 'Impacto medido' : 'Measured Impact'}</h2>
        <p class="savings-subtitle">${isSpanish ? 'Datos reales acumulados de eventos registrados. Sin estimaciones fijas ni claims no verificables.' : 'Real accumulated data from recorded events. No fixed estimates or unverifiable claims.'}</p>
        <div class="time-window-selector" id="timeWindowSelector">
          <button class="tw-btn active" data-window="total">${isSpanish ? 'Total' : 'Total'}</button>
          <button class="tw-btn" data-window="30d">30d</button>
          <button class="tw-btn" data-window="7d">7d</button>
          <button class="tw-btn" data-window="24h">24h</button>
        </div>
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
        <div class="live-savings-dims" id="measuredCategories"></div>
        <div class="coverage-bar" id="coverageBar" style="display:none">
          <span class="coverage-indicator" id="coverageIndicator"></span>
          <span class="coverage-text" id="coverageText"></span>
        </div>
      </section>

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
        <h2>${labels.projectsTab}</h2>
        <button class="add-project-btn" id="addProjectBtn" type="button" title="${isSpanish ? 'Añadir proyecto' : 'Add project'}" aria-label="${isSpanish ? 'Añadir proyecto' : 'Add project'}">+</button>
      </div>
      <div class="project-grid">
        ${cardHtml}
      </div>
    </section>

    <!-- Metrics tab -->
    <section class="tab-panel" id="tab-metrics">
      <section class="metrics-toolbar">
        <div class="metrics-heading"><h2>${labels.metrics}</h2><span>${isSpanish ? 'Impacto y eficiencia medidos' : 'Measured impact and efficiency'}</span></div>
        <div class="metrics-controls">
          <label class="metrics-project-control"><span>${isSpanish ? 'Proyecto' : 'Project'}</span><select id="metricsProject" aria-label="${isSpanish ? 'Proyecto' : 'Project'}">
            <option value="">${isSpanish ? 'Todos los proyectos' : 'All projects'}</option>
            ${cards.map((c) => `<option value="${escapeHtml(c.name)}"${c.name === graphProject ? ' selected' : ''}>${escapeHtml(c.displayName)}</option>`).join('')}
          </select></label>
          <div class="metrics-window" aria-label="${isSpanish ? 'Periodo' : 'Time window'}">
            <button class="win-btn" data-win="24h">24h</button>
            <button class="win-btn" data-win="7d">7d</button>
            <button class="win-btn" data-win="30d">30d</button>
            <button class="win-btn active" data-win="total">${isSpanish ? 'Total' : 'Total'}</button>
          </div>
        </div>
        <span class="metrics-badge" id="metricsProvenance"></span>
      </section>
      <section class="metrics-summary" id="metricsSummary">
        <div class="metric-card metric-card-primary"><div class="metric-label">${labels.tokensSaved}</div><div class="metric-value" id="mtTokens">${totalTokens.toLocaleString()}</div><div class="metric-sub" id="mtTokensProv">${isSpanish ? 'Estimado' : 'Estimated'}</div></div>
        <div class="metric-card metric-card-primary"><div class="metric-label">${labels.filesAvoided}</div><div class="metric-value" id="mtFiles">${totalFiles.toLocaleString()}</div><div class="metric-sub" id="mtFilesProv">${isSpanish ? 'Estimado' : 'Estimated'}</div></div>
        <div class="metric-card"><div class="metric-label">${isSpanish ? 'Gasto LLM' : 'LLM spend'}</div><div class="metric-value" id="mtLlmSpend">—</div><div class="metric-sub">${isSpanish ? 'Coste LLM estimado' : 'Estimated LLM cost'}</div></div>
        <div class="metric-card"><div class="metric-label">${isSpanish ? 'Llamadas LLM' : 'LLM calls'}</div><div class="metric-value" id="mtLlmCalls">—</div><div class="metric-sub">${isSpanish ? 'Llamadas reales al proveedor' : 'Real provider calls'}</div></div>
        <div class="metric-card"><div class="metric-label">${isSpanish ? 'Coste LLM / 1.000 tokens LYNX' : 'LLM cost / 1,000 LYNX tokens'}</div><div class="metric-value" id="mtLlmEfficiency">—</div><div class="metric-sub">${isSpanish ? 'Eficiencia del flujo' : 'Flow efficiency'}</div></div>
        <div class="metric-card"><div class="metric-label">${isSpanish ? 'Ahorro neto estimado' : 'Estimated net savings'}</div><div class="metric-value" id="mtNetSavings">—</div><div class="metric-sub" id="mtNetSavingsSub">${isSpanish ? 'Configura el precio evitado' : 'Configure avoided price'}</div></div>
        <div class="metric-card"><div class="metric-label">${isSpanish ? 'Eventos' : 'Events'}</div><div class="metric-value" id="mtEvents">—</div><div class="metric-sub" id="mtEventsProv">${isSpanish ? 'Medido' : 'Measured'}</div></div>
        <div class="metric-card"><div class="metric-label">${isSpanish ? 'Sesiones' : 'Sessions'}</div><div class="metric-value" id="mtSessions">—</div><div class="metric-sub" id="mtSessionsProv">${isSpanish ? 'Medido' : 'Measured'}</div></div>
        <div class="metric-card"><div class="metric-label">${isSpanish ? 'Tareas' : 'Tasks'}</div><div class="metric-value" id="mtTasks">—</div><div class="metric-sub" id="mtTasksProv">${isSpanish ? 'Medido' : 'Measured'}</div></div>
      </section>
      <section class="metrics-coverage metrics-insight">
        <div class="coverage-text" id="mtLlmInsight">${isSpanish ? 'Calculando eficiencia LLM…' : 'Calculating LLM efficiency…'}</div>
      </section>
      <section class="metrics-coverage llm-breakdown" id="llmBreakdown" style="display:none"></section>
      <section class="metrics-bars">
        <div class="metrics-section-heading"><div><span>${isSpanish ? 'Desglose de actividad' : 'Activity breakdown'}</span><small>${isSpanish ? 'Ahorro estimado por tipo de operación' : 'Estimated savings by operation type'}</small></div></div>
        <div id="metricsBars"><div class="bars-placeholder">${isSpanish ? 'Selecciona un proyecto y ventana para ver el desglose por categoría.' : 'Select a project and window to see category breakdown.'}</div></div>
      </section>
      <section class="metrics-coverage metrics-status" id="metricsCoverage">
        <div class="coverage-text" id="mtCoverageText">${isSpanish ? 'Cargando métricas...' : 'Loading metrics...'}</div>
      </section>
    </section>

    <!-- Settings tab -->
    <section class="tab-panel" id="tab-settings">
      <div class="settings-section settings-agent-response">
        <h3><span class="tab-icon">&#10022;</span>${labels.agentResponseSection}</h3>
        <p class="settings-help">${labels.agentResponseHelp}</p>
        <div class="settings-toggle-row"><label>${labels.agentResponseEnable}</label><label class="settings-toggle"><input type="checkbox" id="cfgAgentResponseEnabled"><span class="toggle-slider"></span></label></div>
        <div class="settings-field"><label>${labels.agentResponseLength}</label><select class="settings-input" id="cfgAgentResponseLength" style="max-width:220px"><option value="short">${labels.agentResponseShort}</option><option value="medium">${labels.agentResponseMedium}</option><option value="long">${labels.agentResponseLong}</option></select></div>
        <div class="settings-field"><label>${labels.agentResponseStyle}</label><select class="settings-input" id="cfgAgentResponseStyle" style="max-width:220px"><option value="concise">${labels.agentResponseConcise}</option><option value="balanced">${labels.agentResponseBalanced}</option><option value="detailed">${labels.agentResponseDetailed}</option></select></div>
        <div class="settings-field"><label>${labels.agentResponseBudget}</label><select class="settings-input" id="cfgAgentResponseBudget" style="max-width:220px"><option value="max_savings">${labels.agentResponseMaxSavings}</option><option value="balanced">${labels.agentResponseBalancedBudget}</option><option value="thorough">${labels.agentResponseThorough}</option></select></div>
        <div class="settings-field"><label>${labels.agentResponseInterval}</label><div class="settings-inline"><span>${labels.agentResponseEvery}</span><select class="settings-input" id="cfgAgentResponseInterval" style="max-width:110px"><option value="5">5</option><option value="15">15</option><option value="30">30</option><option value="60">60</option></select><span>${labels.agentResponseMinutes}</span></div></div>
        <button class="settings-save-btn" id="saveAgentResponseBtn" type="button">${labels.save}</button><span class="settings-flash" id="flashAgentResponse" style="display:none"></span>
      </div>
      <div class="settings-grid">
      <div class="settings-section">
        <h3><span class="tab-icon">&#9881;</span>${labels.apiKeysSection}</h3>
        <form onsubmit="return false;">
        <div class="settings-field"><label>${labels.deepseekKey}</label><input type="password" class="settings-input" id="cfgDeepseekKey" placeholder="sk-..." autocomplete="off"><span class="settings-flash" id="flashDeepseek" style="display:none"></span></div>
        <button class="settings-save-btn" id="saveDeepseekBtn" type="button">${labels.save}</button>
        </form>
        <hr class="settings-separator">
        <form onsubmit="return false;">
        <div class="settings-field"><label>${labels.vpsUrl}</label><input type="text" class="settings-input" id="cfgVpsUrl" placeholder="https://..." autocomplete="off"><span class="settings-flash" id="flashVpsUrl" style="display:none"></span></div>
        <div class="settings-field"><label>${labels.vpsKey}</label><input type="password" class="settings-input" id="cfgVpsKey" placeholder="sk-..." autocomplete="off"><span class="settings-flash" id="flashVpsKey" style="display:none"></span></div>
        <button class="settings-save-btn" id="saveVpsBtn" type="button">${labels.save}</button>
        </form>
      <div class="settings-section">
        <h3><span class="tab-icon">&#9881;</span>${labels.preferencesSection}</h3>
        <div class="settings-field"><label>${isSpanish ? 'Idioma' : 'Language'}</label><select class="settings-input" id="cfgLocale" style="max-width:200px"><option value="es"${isSpanish ? ' selected' : ''}>Español</option><option value="en"${!isSpanish ? ' selected' : ''}>English</option></select><span class="settings-flash" id="flashLocale" style="display:none"></span></div>
        <div class="settings-toggle-row"><label>${labels.autoIndex}</label><label class="settings-toggle"><input type="checkbox" id="cfgAutoIndex"><span class="toggle-slider"></span></label><span class="settings-flash" id="flashAutoIndex" style="display:none"></span></div>
        <div class="settings-toggle-row"><label>${labels.autoWatch}</label><label class="settings-toggle"><input type="checkbox" id="cfgAutoWatch"><span class="toggle-slider"></span></label><span class="settings-flash" id="flashAutoWatch" style="display:none"></span></div>
        <div class="settings-toggle-row"><label>${labels.autoDashboard}</label><label class="settings-toggle"><input type="checkbox" id="cfgAutoDashboard"><span class="toggle-slider"></span></label></div>
        <div class="settings-toggle-row"><label>${isSpanish ? 'Resumen con LLM' : 'LLM architecture brief'}</label><label class="settings-toggle"><input type="checkbox" id="cfgBriefLlm"><span class="toggle-slider"></span></label></div>
        <p class="settings-help" style="margin:0 0 14px">${isSpanish ? 'Desactivado por defecto: el resumen se genera localmente tras indexar. Actívalo solo si quieres enriquecer las nuevas versiones con LLM.' : 'Off by default: the brief is generated locally after indexing. Enable only to enrich new versions with an LLM.'}</p>
        <div class="settings-field"><label>${isSpanish ? 'Decisiones LLM' : 'LLM decisions'}</label><select class="settings-input" id="cfgDecisionLlm" style="max-width:220px"><option value="off">${isSpanish ? 'Desactivado' : 'Off'}</option><option value="conservative">${isSpanish ? 'Conservador' : 'Conservative'}</option><option value="adaptive">${isSpanish ? 'Adaptativo' : 'Adaptive'}</option></select></div>
        <div class="settings-field"><label>${isSpanish ? 'Límite LLM por hora' : 'LLM limit per hour'}</label><input type="number" class="settings-input" id="cfgDecisionLlmCap" min="0" max="1000" step="1" style="max-width:180px"></div>
        <p class="settings-help" style="margin:0 0 14px">${isSpanish ? 'Solo resuelve búsquedas ambiguas; lo claro sigue siendo local. Si no hay clave o presupuesto, LYNX usa el orden determinista.' : 'Only resolves ambiguous searches; clear cases stay local. Without a key or budget, LYNX keeps deterministic ordering.'}</p>
        <div class="settings-field"><label>${isSpanish ? 'Precio del modelo evitado (US$ / 1 M tokens de entrada)' : 'Avoided model price (USD / 1M input tokens)'}</label><input type="number" class="settings-input" id="cfgAvoidedInputPrice" min="0" max="1000" step="0.01" style="max-width:180px"></div>
        <p class="settings-help" style="margin:0 0 14px">${isSpanish ? 'Se usa solo para estimar dinero ahorrado: tokens evitados × este precio − gasto LLM real. Ajusta el valor a tu precio efectivo de Codex, Claude u otro modelo.' : 'Used only to estimate money saved: avoided tokens × this price − real LLM spend. Set it to your effective Codex, Claude, or other model price.'}</p>
        <div class="settings-field"><label>${isSpanish ? 'Catálogo MCP' : 'MCP catalog'}</label><select class="settings-input" id="cfgMcpToolProfile" style="max-width:260px"><option value="full">${isSpanish ? 'Completo (todas las herramientas)' : 'Full (all tools)'}</option><option value="core">${isSpanish ? 'Esencial (ahorro máximo)' : 'Core (maximum savings)'}</option></select></div>
        <p class="settings-help" style="margin:0 0 14px">${isSpanish ? 'El perfil esencial reduce el contexto inicial del cliente. Requiere reiniciar el cliente MCP y oculta herramientas avanzadas hasta volver al perfil completo.' : 'Core reduces the client startup context. Restart the MCP client to apply it; advanced tools stay hidden until you switch back to Full.'}</p>
        <div class="settings-field"><label>${labels.indexLimit}</label><input type="number" class="settings-input" id="cfgAutoIndexLimit" min="0" step="1000" style="max-width:180px"></div>
        <div class="settings-field"><label>${labels.staleHours}</label><input type="number" class="settings-input" id="cfgStaleHours" min="1" max="720" style="max-width:180px"></div>
        <div class="settings-field"><label>${labels.lockMinutes}</label><input type="number" class="settings-input" id="cfgLockMinutes" min="1" max="120" style="max-width:180px"></div>
        <p style="color:#64748b;font-size:12px;margin-bottom:14px">${isSpanish ? 'Los cambios aplican en nuevas operaciones; reinicia el servidor MCP si un cliente conserva la configuración.' : 'Changes apply to new operations; restart the MCP server if a client keeps cached configuration.'}</p>
        <button class="settings-save-btn" id="savePrefsBtn" type="button">${labels.save}</button>
      </div>
      </div>
    </section>
  </main>
  <div class="delete-modal-overlay" id="deleteProjectModal">
    <div class="delete-modal-box">
      <h3>${labels.deleteTitle} <span class="delete-project-name" id="deleteProjectName"></span>?</h3>
      <p>${labels.deleteBody}</p>
      <div class="delete-modal-actions">
        <button class="btn-delete-cancel" id="deleteProjectCancel" type="button">${labels.cancel}</button>
        <button class="btn-delete-confirm" id="deleteProjectConfirm" type="button">${labels.delete}</button>
      </div>
    </div>
  </div>
  <script id="metricsTabScript" type="text/javascript">${metricsTabScript(isSpanish, cards, totalTokens, totalFiles)}</script>
  <script>${mainInitScript(isSpanish, cards, graphProject, briefPayload, primaryBrief)}</script>
  <script>${settingsTabScript(isSpanish, labels)}</script>
  <script>
  (function(){
    var toggle=document.getElementById('lynxEnabledToggle');
    if(!toggle)return;
    toggle.addEventListener('click',function(){
      var enabled=toggle.getAttribute('aria-pressed')!=='true';
      var question=enabled ? ${JSON.stringify(isSpanish ? '¿Activar LYNX? Sus herramientas volverán a estar disponibles tras reiniciar el cliente MCP.' : 'Enable LYNX? Its tools will be available again after restarting the MCP client.')} : ${JSON.stringify(isSpanish ? '¿Desactivar LYNX? Se detendrán el autoindexado, la vigilancia y las nuevas operaciones MCP.' : 'Disable LYNX? Auto-indexing, watching, and new MCP operations will stop.')};
      if(!window.confirm(question))return;
      toggle.disabled=true;
      fetch('/api/lynx-enabled',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:enabled})})
        .then(function(r){if(!r.ok)throw new Error('toggle failed');return r.json();})
        .then(function(){location.reload();})
        .catch(function(){toggle.disabled=false;});
    });
  })();
  </script>
</body>
</html>`;
}
