/*
 * dashboard/html.ts — Dashboard HTML template (orchestrator).
 */

import { readLynxConfig } from '../../config/runtime.js';
import { escapeHtml, savingsLabScript, measuredImpactScript } from './utils.js';
import { renderStyles } from './styles.js';
import { metricsTabScript } from './scripts/metrics-tab.js';
import { mainInitScript } from './scripts/main-init.js';
import { projectHealth, type ProjectCard } from './data.js';

function renderProjectCard(c: ProjectCard, isSpanish: boolean): string {
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
  const graphProject = cards[0]?.name || '';

  const cardHtml = cards.length === 0
    ? `<div class="card" style="grid-column:1/-1"><p>${isSpanish ? 'Aún no hay proyectos indexados. Ejecuta primero' : 'No indexed projects yet. Run'} <code>LYNX index /path/to/project</code>${isSpanish ? ' primero.' : '.'}</p></div>`
    : cards.map((c) => renderProjectCard(c, isSpanish)).join('\n');

  const fullscreenProjects = cards.map((c) => renderFullscreenProject(c, isSpanish)).join('\n');

  const labels = isSpanish ? {
    projects: 'Proyectos', totalNodes: 'Nodos totales', totalEdges: 'Aristas totales',
    indexedFiles: 'Archivos indexados', tokensSaved: 'Tokens ahorrados', filesAvoided: 'Archivos evitados',
    dbSize: 'Tamaño BD', llmCalls: 'LLM llamadas', errors: 'Errores',
    whyTitle: 'Por qué LYNX importa', whyBody: `${totalHotspots.toLocaleString()} puntos críticos detectados en ${totalIndexedFiles.toLocaleString()} archivos. La exploración inicial evitó aproximadamente ${totalTokens.toLocaleString()} tokens en local.`,
    actionGraph: 'Grafo de acción', force: 'Fuerza', ring: 'Anillo', value: 'Valor', risk: 'Riesgo',
    entry: 'Entrada', hotspots: 'Críticos', graphTitle: 'Mapa de arquitectura accionable',
    graphDesc: 'LYNX muestra el grafo por valor operativo: ahorro de contexto, riesgo, puntos de entrada y puntos críticos. Haz clic en un nodo para inspeccionarlo.',
    dragToRotate: 'arrastrar para rotar', wheelToZoom: 'rueda para ampliar',
    overview: 'Resumen', projectsTab: 'Proyectos', savings: 'Ahorros', metrics: 'Métricas',
    localOnly: 'solo local — sin nube', briefLoad: 'Scanning indexed data',
    savedProjects: 'Proyectos', addProject: 'Añadir proyecto',
    deleteTitle: '¿Eliminar', deleteBody: 'Se eliminarán el proyecto y todos sus datos indexados. Esta acción no se puede deshacer.',
    cancel: 'Cancelar', delete: 'Eliminar', footer: 'LYNX Code Intelligence · Todas las métricas son locales y privadas',
    panelTitle: 'Panel de LYNX',
  } : {
    projects: 'Projects', totalNodes: 'Total Nodes', totalEdges: 'Total Edges',
    indexedFiles: 'Indexed Files', tokensSaved: 'Tokens Saved', filesAvoided: 'Files Avoided',
    dbSize: 'DB Size', llmCalls: 'LLM Calls', errors: 'Errors',
    whyTitle: 'Why LYNX matters', whyBody: `${totalHotspots.toLocaleString()} hotspots detected across ${totalIndexedFiles.toLocaleString()} files. First-pass exploration avoided roughly ${totalTokens.toLocaleString()} tokens locally.`,
    actionGraph: 'Action Graph', force: 'Force', ring: 'Ring', value: 'Value', risk: 'Risk',
    entry: 'Entry', hotspots: 'Hotspots', graphTitle: 'Actionable architecture map',
    graphDesc: 'LYNX shows the graph by operational value: context savings, risk, entry points and hotspots. Click a node to inspect it.',
    dragToRotate: 'drag to rotate', wheelToZoom: 'wheel to zoom',
    overview: 'Overview', projectsTab: 'Projects', savings: 'Savings', metrics: 'Metrics',
    localOnly: 'local only — no cloud', briefLoad: 'Scanning indexed data',
    savedProjects: 'Projects', addProject: 'Add project',
    deleteTitle: 'Delete', deleteBody: 'This will remove the project and all its indexed data. This action cannot be undone.',
    cancel: 'Cancel', delete: 'Delete', footer: 'LYNX Code Intelligence · All metrics are local and private',
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
    <div style="display:flex;gap:10px;align-items:center"><select id="localeSelect" aria-label="Language" style="background:#0f172a;color:#e2e8f0;border:1px solid #475569;border-radius:6px;padding:4px 7px;font-size:12px"><option value="es"${isSpanish ? ' selected' : ''}>ES</option><option value="en"${!isSpanish ? ' selected' : ''}>EN</option></select><span class="badge">${labels.localOnly}</span></div>
  </header>
  <nav class="tab-bar">
    <button class="tab-btn active" data-tab="overview"><span class="tab-icon">&#9670;</span>${labels.overview}</button>
    <button class="tab-btn" data-tab="projects"><span class="tab-icon">&#9776;</span>${labels.projectsTab}</button>
    <button class="tab-btn" data-tab="savings"><span class="tab-icon">&#9733;</span>${labels.savings}</button>
    <button class="tab-btn" data-tab="metrics"><span class="tab-icon">&#9776;</span>${labels.metrics}</button>
    <button class="add-project-btn-tab" id="addProjectBtnTab" type="button"><span class="plus-circle">+</span> Proyecto</button>
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
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><path d="M5 3h10a2 2 0 0 1 2 2v5l-7 3-7-3V5a2 2 0 0 1 2-2z" stroke="#f472b6" stroke-width="1.5" stroke-linejoin="round"/><path d="M3 10v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" stroke="#f472b6" stroke-width="1.5" stroke-linejoin="round"/><line x1="10" y1="3" x2="10" y2="13" stroke="#f472b6" stroke-width="1.5"/></svg>${labels.filesAvoided}</div><div class="value">${totalFiles.toLocaleString()}</div></div>${totalDbSizeMb > 0 ? `
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><rect x="3" y="2" width="14" height="16" rx="2" stroke="#22d3ee" stroke-width="1.5"/><line x1="7" y1="8" x2="13" y2="8" stroke="#22d3ee" stroke-width="1.5"/><line x1="7" y1="12" x2="11" y2="12" stroke="#22d3ee" stroke-width="1.5"/></svg>${labels.dbSize}</div><div class="value">${totalDbSizeMb} MB</div></div>` : ''}${totalLlmCalls > 0 ? `
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><circle cx="10" cy="10" r="7" stroke="#a78bfa" stroke-width="1.5"/><path d="M7 10h6M10 7v6" stroke="#a78bfa" stroke-width="1.5" stroke-linecap="round"/></svg>${labels.llmCalls}</div><div class="value">${totalLlmCalls.toLocaleString()}</div></div>` : ''}${totalErrors > 0 ? `
        <div class="summary-card"><div class="label"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-2px;margin-right:5px"><circle cx="10" cy="10" r="7" stroke="#ef4444" stroke-width="1.5"/><line x1="7" y1="7" x2="13" y2="13" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round"/><line x1="13" y1="7" x2="7" y2="13" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round"/></svg>${labels.errors}</div><div class="value" style="color:#ef4444">${totalErrors}</div></div>` : ''}
      </section>

      <section class="value-strip">
        <b>${labels.whyTitle}</b>
        <span>${labels.whyBody}</span>
      </section>

      <div class="graph-toolbar">
        <h2 style="margin:0 8px 0 0">${labels.actionGraph}</h2>
        <select id="projectSelect" aria-label="${isSpanish ? 'Seleccionar proyecto' : 'Select project'}" style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:8px 10px;font-size:13px;max-width:220px">
          ${cards.map((c) => `<option value="${escapeHtml(c.name)}"${c.name === graphProject ? ' selected' : ''}>${escapeHtml(c.displayName)}</option>`).join('')}
        </select>
        <span style="color:#475569;margin:0 4px">|</span>
        <button data-layout="force" class="active">${labels.force}</button>
        <button data-layout="ring">${labels.ring}</button>
        <button data-mode="value" class="active">${labels.value}</button>
        <button data-mode="risk">${labels.risk}</button>
        <button data-mode="entry">${labels.entry}</button>
        <button data-mode="hotspot">${labels.hotspots}</button>
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
          <h3>${labels.graphTitle}</h3>
          <p>${labels.graphDesc}</p>
          <span class="detail-pill">${labels.dragToRotate}</span>
          <span class="detail-pill">${labels.wheelToZoom}</span>
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
        <h2 style="margin:0 16px 0 0">${labels.metrics}</h2>
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
        <div class="metric-card"><div class="metric-label">${labels.tokensSaved}</div><div class="metric-value" id="mtTokens">${totalTokens.toLocaleString()}</div><div class="metric-sub" id="mtTokensProv">${isSpanish ? 'Estimado' : 'Estimated'}</div></div>
        <div class="metric-card"><div class="metric-label">${labels.filesAvoided}</div><div class="metric-value" id="mtFiles">${totalFiles.toLocaleString()}</div><div class="metric-sub" id="mtFilesProv">${isSpanish ? 'Estimado' : 'Estimated'}</div></div>
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
      <h3>${labels.deleteTitle} <span class="delete-project-name" id="deleteProjectName"></span>?</h3>
      <p>${labels.deleteBody}</p>
      <div class="delete-modal-actions">
        <button class="btn-delete-cancel" id="deleteProjectCancel" type="button">${labels.cancel}</button>
        <button class="btn-delete-confirm" id="deleteProjectConfirm" type="button">${labels.delete}</button>
      </div>
    </div>
  </div>
  <footer>${labels.footer}</footer>
  <script id="metricsTabScript" type="text/javascript">${metricsTabScript(isSpanish, cards, totalTokens, totalFiles)}</script>
  <script>${mainInitScript(isSpanish, cards, graphProject, briefPayload, primaryBrief)}</script>
</body>
</html>`;
}
