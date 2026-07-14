/*
 * dashboard/scripts/metrics-tab.ts — Metrics tab JavaScript.
 */

import type { ProjectCard } from '../data.js';

export function metricsTabScript(isSpanish: boolean, cards: ProjectCard[], totalTokens: number, totalFiles: number): string {
  return `
(function(){
  var metricEls = {
    tokens: document.getElementById('mtTokens'),
    files: document.getElementById('mtFiles'),
    events: document.getElementById('mtEvents'),
    sessions: document.getElementById('mtSessions'),
    tasks: document.getElementById('mtTasks'),
    llmSpend: document.getElementById('mtLlmSpend'),
    llmCalls: document.getElementById('mtLlmCalls'),
    llmEfficiency: document.getElementById('mtLlmEfficiency'),
    netSavings: document.getElementById('mtNetSavings'),
    netSavingsSub: document.getElementById('mtNetSavingsSub'),
    tokensProv: document.getElementById('mtTokensProv'),
    filesProv: document.getElementById('mtFilesProv'),
    eventsProv: document.getElementById('mtEventsProv'),
    sessionsProv: document.getElementById('mtSessionsProv'),
    tasksProv: document.getElementById('mtTasksProv'),
    bars: document.getElementById('metricsBars'),
    coverage: document.getElementById('mtCoverageText'),
    llmBreakdown: document.getElementById('llmBreakdown'),
  };
  var isSpanish = ${isSpanish};
  var CAT_COLORS = ['#38bdf8','#22d3ee','#a78bfa','#f59e0b','#f472b6','#4ade80','#94a3b8'];

  function escapeHtml(value) {
    var span = document.createElement('span');
    span.textContent = String(value == null ? '' : value);
    return span.innerHTML;
  }

  function categoryLabel(category, fallback) {
    var labels = isSpanish ? {
      architecture_overview: 'Orientación de arquitectura',
      direct_discovery: 'Descubrimiento directo', smart_navigation: 'Navegación inteligente',
      context_packing: 'Empaquetado de contexto', impact_analysis: 'Análisis de impacto',
      project_operations: 'Operaciones de proyecto', llm_rerank: 'Reordenamiento semántico',
    } : {
      architecture_overview: 'Architecture overview',
      direct_discovery: 'Direct discovery', smart_navigation: 'Smart navigation',
      context_packing: 'Context packing', impact_analysis: 'Impact analysis',
      project_operations: 'Project operations', llm_rerank: 'Semantic reranking',
    };
    return labels[category] || fallback;
  }

  function coverageSummary(coverage) {
    if (!coverage) return '';
    if (isSpanish) return coverage.summary || '';
    var sessions = coverage.sessions_tracked ? coverage.sessions_tracked + ' sessions' : 'sessions: unavailable';
    var tasks = coverage.tasks_tracked ? coverage.tasks_tracked + ' tasks' : 'tasks: unavailable';
    if (coverage.deterministic_mode) return 'Deterministic mode active (' + sessions + ').';
    if (!coverage.llm_tracking_active) {
      if (coverage.has_llm_key) {
        return 'Events recorded without LLM (' + sessions + ', ' + tasks + '). API key is configured but enable_llm was off — semantic reranking was not requested.';
      }
      return 'Events recorded without LLM (' + sessions + ', ' + tasks + '). Configure LYNX_DEEPSEEK_KEY or LYNX_API_KEY to enable semantic reranking.';
    }
    return 'Telemetry active (' + sessions + ', ' + tasks + ').';
  }

  function provBadge(kind) {
    if (kind === 'measured') return '<span class="metrics-badge prov-measured">' + (isSpanish ? 'Medido' : 'Measured') + '</span>';
    if (kind === 'estimated') return '<span class="metrics-badge prov-estimated">' + (isSpanish ? 'Estimado' : 'Estimated') + '</span>';
    return '<span class="metrics-badge prov-scenario">' + (isSpanish ? 'Simulado' : 'Simulated') + '</span>';
  }

  function fmt(n) { return n != null ? Number(n).toLocaleString() : '—'; }
  function fmtUsd(n) {
    var value = Number(n || 0);
    if (value > 0 && value < 0.000001) return '< $0.000001';
    return new Intl.NumberFormat(isSpanish ? 'es-ES' : 'en-US', {
      style: 'currency', currency: 'USD', minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
      maximumFractionDigits: value > 0 && value < 0.01 ? 6 : 2,
    }).format(value);
  }

  function llmInsight(t, monetary) {
    var tokens = Number(t.tokens_saved || 0);
    var calls = Number(t.llm_events || 0);
    var spend = Number(t.llm_cost_usd || 0);
    if (calls === 0) return isSpanish
      ? 'Aún no hay llamadas LLM en esta ventana; LYNX sigue funcionando en modo determinista.'
      : 'No LLM calls in this window; LYNX is still operating deterministically.';
    if (tokens === 0) return isSpanish
      ? 'Se registraron ' + fmt(calls) + ' llamadas LLM por ' + fmtUsd(spend) + '. No hay todavía ahorro de contexto atribuible en esta ventana.'
      : fmt(calls) + ' LLM calls cost ' + fmtUsd(spend) + '. No attributable context savings are recorded in this window yet.';
    var base = isSpanish
      ? 'En este flujo, LYNX registró ' + fmt(tokens) + ' tokens de contexto evitados; ' + fmt(calls) + ' decisión(es) LLM costaron ' + fmtUsd(spend) + '.'
      : 'In this flow, LYNX recorded ' + fmt(tokens) + ' context tokens avoided; ' + fmt(calls) + ' LLM decision(s) cost ' + fmtUsd(spend) + '.';
    if (!monetary || !Number(monetary.avoided_input_usd_per_1m || 0)) return base;
    return base + (isSpanish
      ? ' Con ' + fmtUsd(monetary.avoided_input_usd_per_1m) + ' / 1 M configurado, el ahorro neto estimado es ' + fmtUsd(monetary.net_savings_usd) + '.'
      : ' At ' + fmtUsd(monetary.avoided_input_usd_per_1m) + ' / 1M configured, estimated net savings are ' + fmtUsd(monetary.net_savings_usd) + '.');
  }

  function renderLlmBreakdown(rows) {
    if (!metricEls.llmBreakdown) return;
    if (!rows || rows.length === 0) {
      metricEls.llmBreakdown.style.display = 'none';
      metricEls.llmBreakdown.innerHTML = '';
      return;
    }
    var heading = isSpanish ? 'Uso por modelo LLM' : 'LLM usage by model';
    var calls = isSpanish ? 'llamadas' : 'calls';
    var latency = isSpanish ? 'latencia' : 'latency';
    var legacy = isSpanish ? 'Modelo no registrado' : 'Model not recorded';
    metricEls.llmBreakdown.style.display = '';
    metricEls.llmBreakdown.innerHTML = '<div class="llm-model-heading"><div><span>' + heading + '</span><small>' + (isSpanish ? 'Llamadas reales y coste estimado' : 'Real calls and estimated cost') + '</small></div></div><div class="llm-model-list">' + rows.map(function(row) {
      var name = escapeHtml(row.provider + ' · ' + (row.model || legacy));
      return '<div class="llm-model-row"><div class="llm-model-name"><span class="llm-model-dot"></span><strong>' + name + '</strong></div><div class="llm-model-stat"><b>' + fmt(row.calls) + '</b><span>' + calls + '</span></div><div class="llm-model-stat"><b>' + fmtUsd(row.estimated_cost_usd) + '</b><span>' + (isSpanish ? 'coste estimado' : 'estimated cost') + '</span></div><div class="llm-model-stat"><b>' + fmt(row.latency_ms) + ' ms</b><span>' + latency + '</span></div></div>';
    }).join('') + '</div>';
  }

  function savingsInsight(t, attribution, monetary) {
    var tokens = Number(t.tokens_saved || 0);
    if (tokens === 0) return llmInsight(t, monetary);

    var source = attribution && attribution.by_tool && attribution.by_tool[0];
    var savingEvents = Number(attribution && attribution.saving_events || 0);
    var operationalEvents = Number(attribution && attribution.operational_events || 0);
    var confidence = attribution && attribution.confidence || 'medium';
    var toolLabels = isSpanish ? {
      architecture_overview: 'resumen de arquitectura',
      search_graph: 'consulta de descubrimiento', search_code: 'consulta de código',
      semantic_search: 'búsqueda semántica', trace_path: 'trazado de flujo',
      get_code_snippet: 'fragmento dirigido', batch_get_code: 'lectura dirigida',
      pack_context: 'empaquetado de contexto', find_tests: 'búsqueda de pruebas',
      index_repository: 'indexación', index_status: 'comprobación del índice',
      detect_changes: 'detección de cambios', assess_impact: 'análisis de impacto',
      analyze_hotspots: 'análisis de zonas críticas', find_dead_code: 'detección de código sin uso',
      pack_memory: 'memoria del proyecto', get_graph_schema: 'esquema del grafo',
      compare_runs: 'comparación de indexaciones', ingest_traces: 'integración de trazas',
      watch_project: 'seguimiento del proyecto', manage_adr: 'gestión de decisiones técnicas',
    } : {
      architecture_overview: 'architecture overview',
      search_graph: 'discovery query', search_code: 'code query',
      semantic_search: 'semantic search', trace_path: 'flow trace',
      get_code_snippet: 'targeted snippet', batch_get_code: 'targeted read',
      pack_context: 'context pack', find_tests: 'test lookup',
      index_repository: 'indexing', index_status: 'index check', detect_changes: 'change detection',
      assess_impact: 'impact assessment', analyze_hotspots: 'hotspot analysis',
      find_dead_code: 'dead-code detection', pack_memory: 'project memory',
      get_graph_schema: 'graph schema', compare_runs: 'index comparison',
      ingest_traces: 'trace ingestion', watch_project: 'project monitoring', manage_adr: 'architecture decision management',
    };
    var sourceLabel = source ? (toolLabels[source.type] || source.type) : (isSpanish ? 'operación LYNX' : 'LYNX operation');
    var confidenceLabel = isSpanish
      ? ({ low: 'baja', medium: 'media', high: 'alta' }[confidence] || 'media')
      : confidence;
    var text = isSpanish
      ? fmt(tokens) + ' tokens estimados proceden de ' + fmt(savingEvents) + ' ' + sourceLabel + (savingEvents === 1 ? '' : 's') + ' (confianza ' + confidenceLabel + ').'
      : fmt(tokens) + ' estimated tokens come from ' + fmt(savingEvents) + ' ' + (savingEvents === 1 ? sourceLabel : (sourceLabel.endsWith('query') ? sourceLabel.slice(0, -1) + 'ies' : sourceLabel + 's')) + ' (' + confidenceLabel + ' confidence).';
    if (operationalEvents > 0) text += isSpanish
      ? ' ' + fmt(operationalEvents) + ' eventos sin resultado atribuible se registran solo como actividad.'
      : ' ' + fmt(operationalEvents) + ' events without attributable results are recorded as activity only.';
    if (Number(t.llm_events || 0) > 0) text += ' ' + llmInsight(t, monetary);
    else if (monetary && Number(monetary.avoided_input_usd_per_1m || 0)) {
      text += isSpanish
        ? ' Con ' + fmtUsd(monetary.avoided_input_usd_per_1m) + ' / 1 M configurado, el ahorro neto estimado es ' + fmtUsd(monetary.net_savings_usd) + '.'
        : ' At ' + fmtUsd(monetary.avoided_input_usd_per_1m) + ' / 1M configured, estimated net savings are ' + fmtUsd(monetary.net_savings_usd) + '.';
    }
    return text;
  }

  function loadMetrics() {
    var project = document.getElementById('metricsProject').value;
    var win = document.querySelector('.win-btn.active') ? document.querySelector('.win-btn.active').dataset.win : 'total';
    var url = '/api/metrics?window=' + win;
    if (project) url += '&project=' + encodeURIComponent(project);

    if (metricEls.events) metricEls.events.textContent = '...';

    fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var t = d.totals;
        if (metricEls.tokens) metricEls.tokens.textContent = fmt(t.tokens_saved);
        if (metricEls.files) metricEls.files.textContent = fmt(t.files_avoided);
        if (metricEls.events) metricEls.events.textContent = fmt(t.events);
        if (metricEls.sessions) metricEls.sessions.textContent = fmt(t.sessions);
        if (metricEls.tasks) metricEls.tasks.textContent = fmt(t.tasks);
        if (metricEls.llmSpend) metricEls.llmSpend.textContent = fmtUsd(t.llm_cost_usd);
        if (metricEls.llmCalls) metricEls.llmCalls.textContent = fmt(t.llm_events);
        if (metricEls.llmEfficiency) {
          metricEls.llmEfficiency.textContent = t.tokens_saved > 0
            ? fmtUsd((Number(t.llm_cost_usd || 0) / Number(t.tokens_saved)) * 1000)
            : '—';
        }
        var monetary = d.monetary || null;
        if (metricEls.netSavings) metricEls.netSavings.textContent = monetary ? fmtUsd(monetary.net_savings_usd) : '—';
        if (metricEls.netSavingsSub && monetary) metricEls.netSavingsSub.textContent = isSpanish
          ? 'Evita ' + fmtUsd(monetary.avoided_cost_usd) + ' · a ' + fmtUsd(monetary.avoided_input_usd_per_1m) + ' / 1 M'
          : 'Avoids ' + fmtUsd(monetary.avoided_cost_usd) + ' · at ' + fmtUsd(monetary.avoided_input_usd_per_1m) + ' / 1M';
        var insight = document.getElementById('mtLlmInsight');
        if (insight) insight.textContent = savingsInsight(t, d.savings_attribution, monetary);

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
            var label = categoryLabel(c.category, c.label);
            var eventLabel = isSpanish ? 'eventos' : 'events';
            html += '<div class="bar-row">' +
              '<div class="bar-label">' + escapeHtml(label) + '</div>' +
              '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '" title="' + fmt(c.tokens_saved) + ' tokens, ' + c.events + ' ' + eventLabel + '"></div></div>' +
              '<div class="bar-value">' + fmt(c.tokens_saved) + ' <span style="color:#64748b;font-size:11px">' + c.events + ' ev</span></div>' +
              '</div>';
          });
          if (metricEls.bars) metricEls.bars.innerHTML = html;
        }

        if (metricEls.coverage) metricEls.coverage.textContent = coverageSummary(d.coverage);
        renderLlmBreakdown(d.llm_breakdown || []);

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

  document.querySelectorAll('.win-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.win-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      loadMetrics();
    });
  });

  var projSelect = document.getElementById('metricsProject');
  if (projSelect) {
    projSelect.addEventListener('change', loadMetrics);
  }

  var clearBtn = document.getElementById('clearMetricsBtn');
  var clearModal = document.getElementById('clearMetricsModal');
  var clearTitle = document.getElementById('clearMetricsTitle');
  var clearBody = document.getElementById('clearMetricsBody');
  var clearCancel = document.getElementById('clearMetricsCancel');
  var clearConfirm = document.getElementById('clearMetricsConfirm');

  if (clearBtn && clearModal) {
    clearBtn.addEventListener('click', function() {
      var project = projSelect ? projSelect.value : '';
      var projectLabel = project || (isSpanish ? 'TODOS los proyectos' : 'ALL projects');
      if (clearTitle) clearTitle.innerHTML = isSpanish
        ? '¿Borrar métricas de <span class="delete-project-name">' + escapeHtml(projectLabel) + '</span>?'
        : 'Clear metrics for <span class="delete-project-name">' + escapeHtml(projectLabel) + '</span>?';
      if (clearBody) clearBody.textContent = isSpanish
        ? 'Se eliminarán todos los eventos registrados y snapshots diarios. Esta acción no se puede deshacer. Los datos de uso empezarán desde cero.'
        : 'This will remove all recorded events and daily snapshots. This action cannot be undone. Usage data will start from zero.';
      clearModal.classList.add('open');
    });

    var closeClearModal = function() { clearModal.classList.remove('open'); };
    if (clearCancel) clearCancel.addEventListener('click', closeClearModal);
    clearModal.addEventListener('click', function(e) { if (e.target === clearModal) closeClearModal(); });

    if (clearConfirm) {
      clearConfirm.addEventListener('click', function() {
        var project = projSelect ? projSelect.value : '';
        clearConfirm.disabled = true;
        clearConfirm.textContent = isSpanish ? 'Borrando...' : 'Clearing...';
        fetch('/api/metrics/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(project ? { project: project } : {}),
        })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            clearConfirm.disabled = false;
            clearConfirm.textContent = isSpanish ? 'Borrar' : 'Clear';
            clearModal.classList.remove('open');
            if (data.ok) loadMetrics();
          })
          .catch(function() {
            clearConfirm.disabled = false;
            clearConfirm.textContent = isSpanish ? 'Borrar' : 'Clear';
            clearModal.classList.remove('open');
          });
      });
    }
  }

  var metricsTabBtn = document.querySelector('[data-tab="metrics"]');
  if (metricsTabBtn) {
    metricsTabBtn.addEventListener('click', function() { setTimeout(loadMetrics, 50); });
  }

  // Tab restoration runs in mainInitScript after this script. Load unconditionally
  // so a refreshed page cannot leave the active Metrics tab with placeholders.
  setTimeout(loadMetrics, 100);

  // Usage may be written by an MCP process outside this dashboard process. Keep
  // the Metrics view live even on platforms where filesystem watch events are
  // coalesced or not delivered to the WebSocket broadcaster.
  setInterval(function() {
    var panel = document.getElementById('tab-metrics');
    if (panel && panel.classList.contains('active') && !document.hidden) loadMetrics();
  }, 2000);
})();`;
}
