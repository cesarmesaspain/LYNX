/*
 * dashboard/scripts/websocket.ts — WebSocket real-time update client script.
 */

export function webSocketScript(): string {
  return String.raw`
;(() => {
  var isSpanish = document.documentElement.lang === 'es';
  var wsReconnectDelay = 1000;
  var wsMaxDelay = 30000;
  var wsTimer = null;
  var ws = null;

  function connectWs() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try {
      ws = new WebSocket('ws://' + location.host + '/ws');
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.onopen = function () {
      wsReconnectDelay = 1000;
    };
    ws.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg.type === 'cards_updated') {
          updateDashboardUI(msg.cards, msg.briefs);
        }
      } catch (e) {}
    };
    ws.onclose = function () { scheduleReconnect(); };
    ws.onerror = function () { ws.close(); };
  }

  function scheduleReconnect() {
    if (wsTimer) return;
    wsTimer = setTimeout(function () {
      wsTimer = null;
      connectWs();
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, wsMaxDelay);
    }, wsReconnectDelay);
  }

  function projectHealth(c) {
    if (c.riskyNodes > 500 || c.hotspots > 500) return { label: isSpanish ? 'Superficie alta' : 'High Surface', className: 'health-watch' };
    if (c.edges < c.nodes) return { label: isSpanish ? 'Disperso' : 'Sparse', className: 'health-risk' };
    return { label: isSpanish ? 'Saludable' : 'Healthy', className: 'health-good' };
  }

  function esc(s) {
    var span = document.createElement('span');
    span.textContent = String(s);
    return span.innerHTML;
  }

  function renderCardHtml(c) {
    var h = projectHealth(c);
    var html = '<button class="card project-card" type="button" data-project-card="' + esc(c.name) + '" aria-label="Show ' + esc(c.displayName) + ' graph">';
    html += '<span class="card-delete-btn" role="button" tabindex="0" data-delete-project="' + esc(c.name) + '" data-delete-name="' + esc(c.displayName) + '" aria-label="' + (isSpanish ? 'Eliminar ' : 'Delete ') + esc(c.displayName) + '" title="' + (isSpanish ? 'Eliminar proyecto' : 'Delete project') + '">&#x2715;</span>';
    html += '<div class="project-topline"><div class="card-title">' + esc(c.displayName) + '</div><span class="health-pill ' + h.className + '">' + h.label + '</span></div>';
    html += '<div class="card-stats">';
    html += '<div><span class="stat-label">' + (isSpanish ? 'Nodos' : 'Nodes') + '</span><span class="stat-value">' + c.nodes.toLocaleString() + '</span></div>';
    html += '<div><span class="stat-label">' + (isSpanish ? 'Aristas' : 'Edges') + '</span><span class="stat-value">' + c.edges.toLocaleString() + '</span></div>';
    html += '<div><span class="stat-label">' + (isSpanish ? 'Archivos' : 'Files') + '</span><span class="stat-value">' + c.filesIndexed.toLocaleString() + '</span></div>';
    html += '</div><div class="card-stats">';
    html += '<div><span class="stat-label">' + (isSpanish ? 'Críticos' : 'Hotspots') + '</span><span class="stat-value">' + c.hotspots.toLocaleString() + '</span></div>';
    html += '<div><span class="stat-label">' + (isSpanish ? 'Riesgo' : 'Risky') + '</span><span class="stat-value">' + c.riskyNodes.toLocaleString() + '</span></div>';
    html += '<div><span class="stat-label">' + (isSpanish ? 'Entrada' : 'Entry') + '</span><span class="stat-value">' + c.entryPoints.toLocaleString() + '</span></div>';
    html += '</div>';
    html += '<div class="project-impact">' + (isSpanish ? 'Tokens ahorrados' : 'Tokens saved') + ': <b>' + c.tokensSaved.toLocaleString() + '</b> · ' + (isSpanish ? 'Archivos evitados' : 'Files avoided') + ': <b>' + c.filesAvoided.toLocaleString() + '</b></div>';
    if (c.semanticEvents > 0) {
      html += '<div class="semantic-note">' + (isSpanish ? 'Mejora semántica' : 'Semantic lift') + ': ' + c.semanticTopChanged + '/' + c.semanticEvents + ' ' + (isSpanish ? 'resultados principales mejorados' : 'top-results improved') + '</div>';
    }
    if (c.lastIndexed) {
      html += '<div class="muted-text">' + (isSpanish ? 'Indexado' : 'Indexed') + ': ' + esc(c.lastIndexed) + ' · ' + c.edgeTypes + ' ' + (isSpanish ? 'tipos de arista' : 'edge types') + '</div>';
    }
    html += '<div class="open-graph">' + (isSpanish ? 'Abrir grafo' : 'Open graph') + '</div></button>';
    return html;
  }

  function updateDashboardUI(cards, briefs) {
    // Update project cards grid
    var grid = document.querySelector('.project-grid');
    if (grid && cards.length > 0) {
      grid.innerHTML = cards.map(function(c) { return renderCardHtml(c); }).join('');
    } else if (grid && cards.length === 0) {
      grid.innerHTML = '<div class="card" style="grid-column:1/-1"><p class="empty-state">No indexed projects yet. Run <code>LYNX index /path/to/project</code> first.</p></div>';
    }

    // Update summary stats
    var totalTokens = cards.reduce(function(s, c) { return s + c.tokensSaved; }, 0);
    var totalFiles = cards.reduce(function(s, c) { return s + c.filesAvoided; }, 0);
    var totalNodes = cards.reduce(function(s, c) { return s + c.nodes; }, 0);
    var totalEdges = cards.reduce(function(s, c) { return s + c.edges; }, 0);
    var totalIndexedFiles = cards.reduce(function(s, c) { return s + c.filesIndexed; }, 0);

    // Rebuild project select options
    var sel = document.getElementById('projectSelect');
    if (sel && cards.length > 0) {
      var currentVal = sel.value;
      sel.innerHTML = cards.map(function(c) {
        return '<option value="' + esc(c.name) + '"' + (c.name === currentVal ? ' selected' : '') + '>' + esc(c.displayName) + '</option>';
      }).join('');
      // If current project no longer exists, reset
      if (!cards.some(function(c) { return c.name === currentVal; })) {
        sel.value = cards[0].name;
      }
    }

    var summaryCards = document.querySelectorAll('.summary-card .value');
    var vals = [String(cards.length), totalNodes.toLocaleString(), totalEdges.toLocaleString(), totalIndexedFiles.toLocaleString(), totalTokens.toLocaleString(), totalFiles.toLocaleString()];
    for (var i = 0; i < summaryCards.length && i < vals.length; i++) {
      summaryCards[i].innerHTML = vals[i];
    }

    // Refresh loading animation tile targets to match active project
    var activeCard = cards[0];
    if (typeof activeProject !== 'undefined' && activeProject) {
      var found = cards.find(function(c) { return c.name === activeProject; });
      if (found) activeCard = found;
    }
    if (activeCard) {
      var loadingName = document.getElementById('briefLoadingProjectName');
      if (loadingName) loadingName.textContent = activeCard.displayName || activeCard.name;
      var tileMap = {
        'Nodes': activeCard.nodes || 0,
        'Edges': activeCard.edges || 0,
        'Files': activeCard.filesIndexed || 0,
        'Hotspots': activeCard.hotspots || 0,
        'Risky Nodes': activeCard.riskyNodes || 0,
        'Entry Points': activeCard.entryPoints || 0,
        'Edge Types': activeCard.edgeTypes || 0,
        'Tokens Saved': activeCard.tokensSaved || 0,
      };
      var tiles = document.querySelectorAll('#briefDataGrid .brief-data-tile');
      tiles.forEach(function(tile) {
        var label = tile.querySelector('.bdt-label');
        var value = tile.querySelector('.bdt-value');
        if (label && value && tileMap.hasOwnProperty(label.textContent)) {
          value.setAttribute('data-target', String(tileMap[label.textContent]));
        }
      });
      // Restart intro animation with fresh data if loading screen is visible
      var loadingEl = document.getElementById('projectBriefLoading');
      if (loadingEl && loadingEl.style.display !== 'none' && typeof startBriefIntroWithGraph === 'function') {
        startBriefIntroWithGraph(activeCard.name);
      }
    }

    // Update brief payload
    if (briefs) {
      window.LYNX_PROJECT_BRIEFS = briefs;
      if (typeof activeProject !== 'undefined' && activeProject) {
        renderProjectBrief(activeProject);
      }
    }

    // Refresh action graph for active project
    if (typeof activeProject !== 'undefined' && activeProject) {
      var stillExists = cards.some(function(c) { return c.name === activeProject; });
      if (!stillExists) {
        activeProject = cards.length > 0 ? cards[0].name : '';
        window.LYNX_INITIAL_PROJECT = activeProject;
      }
    }
    if (typeof load === 'function' && activeProject) {
      load({ preserveCamera: true, preserveSelection: true });
    }
  }

  // Event delegation for dynamically added project cards
  document.addEventListener('click', function(e) {
    var card = e.target.closest('[data-project-card]');
    if (!card) return;
    var project = card.getAttribute('data-project-card');
    if (typeof activeProject !== 'undefined') {
      activeProject = project;
      window.LYNX_INITIAL_PROJECT = project;
    }
    var sel = document.getElementById('projectSelect');
    if (sel && sel.value !== project) sel.value = project;
    // Restart intro animation for the newly selected project if no brief yet
    var briefs = window.LYNX_PROJECT_BRIEFS || {};
    if (!briefs[project] || !briefs[project].brief) {
      if (typeof startBriefIntroWithGraph === 'function') startBriefIntroWithGraph(project);
    }
  });

  connectWs();
})();
`;
}
