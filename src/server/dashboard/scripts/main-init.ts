/*
 * dashboard/scripts/main-init.ts — Main initialization JavaScript for the dashboard.
 */

import { escapeHtml } from '../utils.js';
import { actionGraphScript } from './action-graph.js';
import { webSocketScript } from './websocket.js';
import { tabScript } from './tabs.js';
import type { ProjectCard } from '../data.js';

export function mainInitScript(
  isSpanish: boolean,
  cards: ProjectCard[],
  graphProject: string,
  briefPayload: Record<string, { brief: string; generated_at: string }>,
  primaryBrief: { brief: string; generated_at: string } | null,
): string {
  return `
    window.LYNX_INITIAL_PROJECT = ${JSON.stringify(graphProject)};
    window.LYNX_PROJECT_BRIEFS = ${JSON.stringify(briefPayload)};
${actionGraphScript()}
${webSocketScript()}
${tabScript()}
(function(){
  var addProjectLabel = ${JSON.stringify(isSpanish ? 'Añadir proyecto' : 'Add project')};
  var indexingLabel = ${JSON.stringify(isSpanish ? 'Indexando...' : 'Indexing...')};
  function addProject(){
    var btn=document.getElementById('addProjectBtn');
    if(btn){btn.disabled=true;btn.textContent='...';}
    var btnTab=document.getElementById('addProjectBtnTab');
    if(btnTab){btnTab.disabled=true;btnTab.innerHTML='<span class="plus-circle">...</span> '+indexingLabel;}
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
      if(btnTab){btnTab.disabled=false;btnTab.innerHTML='<span class="plus-circle">+</span> '+addProjectLabel;}
    }
  }
  var projectsBtn=document.getElementById('addProjectBtn');
  var tabBtn=document.getElementById('addProjectBtnTab');
  if(projectsBtn)projectsBtn.addEventListener('click',addProject);
  if(tabBtn)tabBtn.addEventListener('click',addProject);

  var localeSelect = document.getElementById('localeSelect');
  if (localeSelect) localeSelect.addEventListener('change', function() {
    var locale = localeSelect.value;
    localeSelect.disabled = true;
    fetch('/api/locale?locale=' + encodeURIComponent(locale), { method: 'POST' })
      .then(function(response) {
        if (!response.ok) throw new Error('locale update failed');
        location.reload();
      })
      .catch(function() { localeSelect.disabled = false; });
  });

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

    if (countsFromActionGraph) setTileTargets(countsFromActionGraph);

    if (briefIntroTimer) clearTimeout(briefIntroTimer);
    briefIntroRunning = true;
    window.briefIntroDone = false;
    window.pendingBriefProject = null;

    var tiles = grid.querySelectorAll('.brief-data-tile');
    if (!tiles.length) return;

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

  (function initBriefIntro() {
    var project = typeof activeProject !== 'undefined' ? activeProject : (window.LYNX_INITIAL_PROJECT || '');
    startBriefIntroWithGraph(project);
  })();
})();`;
}
