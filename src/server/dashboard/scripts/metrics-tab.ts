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
            html += '<div class="bar-row">' +
              '<div class="bar-label">' + c.label + '</div>' +
              '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '" title="' + fmt(c.tokens_saved) + ' tokens, ' + c.events + ' events"></div></div>' +
              '<div class="bar-value">' + fmt(c.tokens_saved) + ' <span style="color:#64748b;font-size:11px">' + c.events + ' ev</span></div>' +
              '</div>';
          });
          if (metricEls.bars) metricEls.bars.innerHTML = html;
        }

        if (metricEls.coverage) metricEls.coverage.textContent = d.coverage ? d.coverage.summary : '';

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

  if (window.location.hash === '#metrics') {
    setTimeout(loadMetrics, 100);
  }
})();`;
}
