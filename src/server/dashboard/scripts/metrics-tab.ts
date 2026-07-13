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
      direct_discovery: 'Descubrimiento directo', smart_navigation: 'Navegación inteligente',
      context_packing: 'Empaquetado de contexto', llm_rerank: 'Reordenamiento semántico',
    } : {
      direct_discovery: 'Direct discovery', smart_navigation: 'Smart navigation',
      context_packing: 'Context packing', llm_rerank: 'Semantic reranking',
    };
    return labels[category] || fallback;
  }

  function coverageSummary(coverage) {
    if (!coverage) return '';
    if (isSpanish) return coverage.summary || '';
    var sessions = coverage.sessions_tracked ? coverage.sessions_tracked + ' sessions' : 'sessions: unavailable';
    var tasks = coverage.tasks_tracked ? coverage.tasks_tracked + ' tasks' : 'tasks: unavailable';
    if (coverage.deterministic_mode) return 'Deterministic mode active (' + sessions + ').';
    if (!coverage.llm_tracking_active) return 'Events recorded without LLM (' + sessions + ', ' + tasks + '). Configure LYNX_DEEPSEEK_KEY or LYNX_API_KEY to enable semantic reranking.';
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
        if (insight) insight.textContent = llmInsight(t, monetary);

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
