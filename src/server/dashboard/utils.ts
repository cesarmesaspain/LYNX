/*
 * dashboard/utils.ts — Utility functions for the LYNX dashboard.
 */

import * as http from 'node:http';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { readLynxConfig } from '../../config/runtime.js';

export const MAX_REQUEST_BODY_BYTES = 1_048_576;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
    this.name = 'RequestBodyTooLargeError';
  }
}

function readRequestBody(req: http.IncomingMessage, maxBytes = MAX_REQUEST_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function pickFolderNative(): string | null {
  const platform = os.platform();
  try {
    if (platform === 'darwin') {
      const script = `
        tell application "System Events"
          activate
          set folderPath to choose folder with prompt "Select project folder to index:"
          POSIX path of folderPath
        end tell
      `;
      const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf-8',
        timeout: 30000,
      });
      return result.trim() || null;
    }
    if (platform === 'linux') {
      // Try zenity if available
      const result = execSync(
        'zenity --file-selection --directory --title="Select project folder to index" 2>/dev/null',
        { encoding: 'utf-8', timeout: 30000 }
      );
      return result.trim() || null;
    }
    // Windows: could use PowerShell, but not needed yet
    return null;
  } catch {
    return null; // User cancelled or Unsupported platform
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function savingsLabScript(isSpanish = false): string {
  const copy = isSpanish ? {
    unavailable: 'Los datos de ahorro no están disponibles. Inicia el dashboard con un proyecto activo.',
    monthly: '$/mes ahorrados ', hours: 'horas de desarrollo/mes ', tokens: 'tokens ahorrados ', time: 'tiempo ahorrado ', operations: 'operaciones evitadas ',
    iterations: 'Iteraciones medias/tarea', rework: 'Tiempo de retrabajo', without: 'Sin LYNX', with: 'Con LYNX', discovery: 'Tokens de descubrimiento', spent: 'Tiempo empleado', calls: 'Llamadas a herramientas', hallucinated: 'Símbolos alucinados',
    simulated: 'Simulado',
    methodology: 'SIMULACIONES — Estas cifras son escenarios hipotéticos editables, no datos reales acumulados. Los valores en dólares dependen del precio configurado por el usuario. Las estimaciones de tiempo usan latencias medias por herramienta. Los conteos de símbolos alucinados son ilustrativos.',
  } : {
    unavailable: 'Savings data unavailable. Start the dashboard with an active project.',
    monthly: '$/mo saved ', hours: 'dev hrs/mo ', tokens: 'tokens saved ', time: 'time saved ', operations: 'operations avoided ',
    iterations: 'Avg iterations/task', rework: 'Rework time', without: 'Without LYNX', with: 'With LYNX', discovery: 'Discovery tokens', spent: 'Time spent', calls: 'Tool calls', hallucinated: 'Hallucinated symbols',
    simulated: 'Simulated',
    methodology: 'SIMULATIONS — These are editable hypothetical scenarios, not real accumulated data. Dollar values depend on user-configured pricing. Time estimates use median tool latencies. Hallucinated symbol counts are illustrative.',
  };
  return [
    '(function(){',
    '"use strict";',
    `var L=${JSON.stringify(copy)};`,
    'var LAB_DATA=null;',
    'var activeScenario="daily-search";',
    '',
    'fetch("/api/savings-lab").then(function(r){return r.json();}).then(function(data){',
    '  LAB_DATA=data;',
    '  renderScenario(activeScenario);',
    '  document.getElementById("scenarioTabs").addEventListener("click",function(e){',
    '    var btn=e.target.closest(".scenario-tab");',
    '    if(!btn)return;',
    '    document.querySelectorAll(".scenario-tab").forEach(function(t){t.classList.remove("active");});',
    '    btn.classList.add("active");',
    '    activeScenario=btn.dataset.scenario;',
    '    renderScenario(activeScenario);',
    '  });',
    '}).catch(function(){',
    '  document.getElementById("scenarioBody").innerHTML="<div class=scenario-loading>"+L.unavailable+"</div>";',
    '});',
    '',
    'function renderScenario(id){',
    '  if(!LAB_DATA)return;',
    '  var s=LAB_DATA.find(function(x){return x.id===id;});',
    '  if(!s)return;',
    '',
    '  var fmt=function(n){return typeof n==="number"?n.toLocaleString():n;};',
    '  var fmtSec=function(sec){return sec>=3600?(sec/3600).toFixed(1)+"h":sec>=60?Math.round(sec/60)+"min":sec+"s";};',
    '  var fmtDollar=function(d){return "$"+d.toLocaleString();};',
    '',
    '  var dimsHtml=s.dimensions.map(function(d){return "<div class=savings-dim><div class=dim-label>"+esc(d.label)+"</div><div class=dim-save>"+esc(d.saving)+"</div></div>";}).join("");',
    '',
    '  var pills=[];',
    '  if(s.savings.dollarsPerMonth>0)pills.push("<div class=\\"metric-pill green\\"><span class=pill-label>"+L.monthly+"</span><span class=pill-val>"+fmtDollar(s.savings.dollarsPerMonth)+"</span></div>");',
    '  if(s.savings.hoursPerMonth>0)pills.push("<div class=\\"metric-pill green\\"><span class=pill-label>"+L.hours+"</span><span class=pill-val>"+s.savings.hoursPerMonth.toFixed(1)+"h</span></div>");',
    '  pills.push("<div class=metric-pill><span class=pill-label>"+L.tokens+"</span><span class=pill-val>"+fmt(s.savings.tokens)+"</span></div>");',
    '  pills.push("<div class=metric-pill><span class=pill-label>"+L.time+"</span><span class=pill-val>"+fmtSec(s.savings.timeSeconds)+"</span></div>");',
    '  pills.push("<div class=metric-pill><span class=pill-label>"+L.operations+"</span><span class=pill-val>"+fmt(s.savings.operations)+"</span></div>");',
    '',
    '  var iterWC=s.withoutLynx.iterations>0?"<div class=compare-stat><span class=stat-label>"+L.iterations+"</span><span class=stat-val>"+s.withoutLynx.iterations+"x</span></div>":"";',
    '  var reworkWC=s.withoutLynx.reworkMinutes>0?"<div class=compare-stat><span class=stat-label>"+L.rework+"</span><span class=stat-val>"+s.withoutLynx.reworkMinutes+" min</span></div>":"";',
    '  var iterC=s.withLynx.iterations>0?"<div class=compare-stat><span class=stat-label>"+L.iterations+"</span><span class=stat-val>"+s.withLynx.iterations+"x</span></div>":"";',
    '  var reworkC=s.withLynx.reworkMinutes>0?"<div class=compare-stat><span class=stat-label>"+L.rework+"</span><span class=stat-val>"+s.withLynx.reworkMinutes+" min</span></div>":"";',
    '',
    '  document.getElementById("scenarioBody").innerHTML=',
    '    "<div class=scenario-header>"+',
    '      "<h3>"+esc(s.title)+" <span class=\\"metric-badge simulated\\" style=\\"margin-left:4px;font-size:10px\\">"+L.simulated+"</span></h3>"+',
    '      "<span class=team-badge>"+esc(s.team)+"</span>"+',
    '      "<p>"+esc(s.description)+"</p>"+',
    '    "</div>"+',
    '    "<div class=compare-grid>"+',
    '      "<div class=\\"compare-col without\\">"+"<h4>"+L.without+"</h4>"+',
    '        "<div class=compare-stat><span class=stat-label>"+L.discovery+"</span><span class=stat-val>"+fmt(s.withoutLynx.discoveryTokens)+"</span></div>"+',
    '        "<div class=compare-stat><span class=stat-label>"+L.spent+"</span><span class=stat-val>"+fmtSec(s.withoutLynx.timeSeconds)+"</span></div>"+',
    '        "<div class=compare-stat><span class=stat-label>"+L.calls+"</span><span class=stat-val>"+fmt(s.withoutLynx.operations)+"</span></div>"+',
    '        "<div class=compare-stat><span class=stat-label>"+L.hallucinated+"</span><span class=stat-val>"+fmt(s.withoutLynx.hallucinations)+"</span></div>"+',
    '        iterWC+reworkWC+',
    '      "</div>"+',
    '      "<div class=\\"compare-col with\\">"+"<h4>"+L.with+"</h4>"+',
    '        "<div class=compare-stat><span class=stat-label>"+L.discovery+"</span><span class=stat-val>"+fmt(s.withLynx.discoveryTokens)+"</span></div>"+',
    '        "<div class=compare-stat><span class=stat-label>"+L.spent+"</span><span class=stat-val>"+fmtSec(s.withLynx.timeSeconds)+"</span></div>"+',
    '        "<div class=compare-stat><span class=stat-label>"+L.calls+"</span><span class=stat-val>"+fmt(s.withLynx.operations)+"</span></div>"+',
    '        "<div class=compare-stat><span class=stat-label>"+L.hallucinated+"</span><span class=stat-val>"+fmt(s.withLynx.hallucinations)+"</span></div>"+',
    '        iterC+reworkC+',
    '      "</div>"+',
    '    "</div>"+',
    '    "<div class=savings-total>"+',
    '      "<div class=big-save>"+fmt(s.savings.tokens)+" "+L.tokens+"</div>"+',
    '      "<div class=save-detail>"+esc(s.savings.mainWin)+"</div>"+',
    '    "</div>"+',
    '    "<div class=savings-dims>"+dimsHtml+"</div>"+',
    '    "<div class=scenario-footer>"+pills.join("")+"</div>"+',
    '    "<p style=\\"margin-top:16px;color:#64748b;font-size:11px;line-height:1.5\\">"+L.methodology+"</p>";',
    '}',
    '',
    'function esc(s){',
    '  var span=document.createElement("span");',
    '  span.textContent=String(s);',
    '  return span.innerHTML;',
    '}',
    '})();',
  ].join('\n');
}

function measuredImpactScript(isSpanish = false): string {
  const L = isSpanish ? {
    loading: 'Cargando métricas...',
    noData: 'Sin datos — usa LYNX con un proyecto indexado',
    tokens: 'tokens',
    files: 'archivos',
    events: 'eventos',
    sessions: 'sesiones',
    tasks: 'tareas',
    measured: 'Medido',
    estimated: 'Estimado',
    simulated: 'Simulado',
    notAvailable: 'No disponible',
    updated: 'Actualizado',
    coverage: 'Cobertura',
    total: 'Total',
    tokensSaved: 'Tokens ahorrados',
    filesAvoided: 'Archivos evitados',
    eventsRecorded: 'Eventos',
    sessionsLabel: 'Sesiones',
    tasksLabel: 'Tareas',
    llmCost: 'Coste LLM',
    categories: 'Categorías (mutuamente excluyentes)',
    lastEvent: 'Último evento',
    noCategoryData: 'Sin datos categorizados todavía.',
  } : {
    loading: 'Loading metrics...',
    noData: 'No data — use LYNX with an indexed project',
    tokens: 'tokens',
    files: 'files',
    events: 'events',
    sessions: 'sessions',
    tasks: 'tasks',
    measured: 'Measured',
    estimated: 'Estimated',
    simulated: 'Simulated',
    notAvailable: 'N/A',
    updated: 'Updated',
    coverage: 'Coverage',
    total: 'Total',
    tokensSaved: 'Tokens saved',
    filesAvoided: 'Files avoided',
    eventsRecorded: 'Events',
    sessionsLabel: 'Sessions',
    tasksLabel: 'Tasks',
    llmCost: 'LLM cost',
    categories: 'Categories (mutually exclusive)',
    lastEvent: 'Last event',
    noCategoryData: 'No category data yet.',
  };

  return [
    '(function(){',
    '"use strict";',
    `var L=${JSON.stringify(L)};`,
    'var currentWindow="total";',
    'var currentProject="";',
    '',
    'function initMeasuredImpact(){',
    '  currentProject=window.LYNX_INITIAL_PROJECT||"";',
    '  document.getElementById("timeWindowSelector").addEventListener("click",function(e){',
    '    var btn=e.target.closest(".tw-btn");',
    '    if(!btn)return;',
    '    document.querySelectorAll(".tw-btn").forEach(function(t){t.classList.remove("active");});',
    '    btn.classList.add("active");',
    '    currentWindow=btn.dataset.window;',
    '    loadMetrics();',
    '  });',
    '  loadMetrics();',
    '}',
    '',
    'function loadMetrics(){',
    '  var hero=document.getElementById("metricsHero");',
    '  var eyebrow=document.getElementById("metricsEyebrow");',
    '  var big=document.getElementById("metricsBigNumber");',
    '  var sub=document.getElementById("metricsSubtitle");',
    '  var meta=document.getElementById("metricsMeta");',
    '  var updated=document.getElementById("metricsUpdated");',
    '  var sessions=document.getElementById("metricsSessions");',
    '  var cats=document.getElementById("measuredCategories");',
    '  var covBar=document.getElementById("coverageBar");',
    '  var covText=document.getElementById("coverageText");',
    '',
    '  eyebrow.textContent=L.loading;',
    '  big.textContent="...";',
    '',
    '  var url="/api/metrics?window="+encodeURIComponent(currentWindow);',
    '  if(currentProject)url+="&project="+encodeURIComponent(currentProject);',
    '',
    '  fetch(url).then(function(r){return r.json();}).then(function(d){',
    '    if(d.error){big.textContent=L.noData;sub.textContent=d.error;return;}',
    '',
    '    var fmt=function(n){return typeof n==="number"?n.toLocaleString():String(n);};',
    '    var badge=function(kind){',
    '      if(kind==="measured")return "<span class=\\"metric-badge measured\\" title=\\"'+L.measured+'\\">'+L.measured+'</span>";',
    '      if(kind==="estimated")return "<span class=\\"metric-badge estimated\\" title=\\"'+L.estimated+'\\">'+L.estimated+'</span>";',
    '      return "<span class=\\"metric-badge simulated\\" title=\\"'+L.simulated+'\\">'+L.simulated+'</span>";',
    '    };',
    '',
    '    // Hero',
    '    big.innerHTML=fmt(d.totals.tokens_saved)+" <small>'+L.tokens+'</small>";',
    '    sub.innerHTML=fmt(d.totals.files_avoided)+" "+L.filesAvoided+" &middot; "+fmt(d.totals.events)+" "+L.eventsRecorded;',
    '    eyebrow.textContent=d.coverage.summary;',
    '',
    '    // Meta',
    '    meta.style.display="flex";',
    '    updated.textContent=L.updated+": "+new Date(d.computed_at).toLocaleString();',
    '    sessions.textContent=fmt(d.totals.sessions)+" "+L.sessionsLabel+" &middot; "+fmt(d.totals.tasks)+" "+L.tasksLabel;',
    '',
    '    // Category cards',
    '    if(d.categories&&d.categories.length>0){',
    '      cats.innerHTML="<h3 style=\\"margin-bottom:12px;color:#94a3b8;font-size:13px;text-transform:uppercase;letter-spacing:.05em\\">"+L.categories+"</h3>"+',
    '        d.categories.map(function(c){',
    '          return "<div class=\\"live-savings-dim\\"><div class=\\"dim-label\\">"+esc(c.label)+"</div><div class=\\"dim-save\\">"+fmt(c.tokens_saved)+" '+L.tokens+'</div><p>"+fmt(c.files_avoided)+" '+L.files+' &middot; "+fmt(c.events)+" '+L.events+'</p></div>";',
    '        }).join("");',
    '    }else{',
    '      cats.innerHTML="<p style=\\"color:#64748b;grid-column:1/-1\\">"+L.noCategoryData+"</p>";',
    '    }',
    '',
    '    // Coverage bar',
    '    if(d.coverage){',
    '      covBar.style.display="flex";',
    '      covText.textContent=d.coverage.summary;',
    '    }',
    '  }).catch(function(err){',
    '    big.textContent=L.noData;',
    '    sub.textContent=String(err);',
    '  });',
    '}',
    '',
    'function esc(s){',
    '  var span=document.createElement("span");',
    '  span.textContent=String(s);',
    '  return span.innerHTML;',
    '}',
    '',
    'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",initMeasuredImpact);}else{initMeasuredImpact();}',
    '})();',
  ].join('\n');
}

export { readRequestBody, pickFolderNative, escapeHtml, savingsLabScript, measuredImpactScript };
