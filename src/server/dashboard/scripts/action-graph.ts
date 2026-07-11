/*
 * dashboard/scripts/action-graph.ts — 3D Action Graph client-side script.
 */

export function actionGraphScript(): string {
  return String.raw`
(() => {
  const isSpanish = document.documentElement.lang === 'es';
  const canvas = document.getElementById('actionGraph');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.insertAdjacentHTML('afterend',
      '<div style="text-align:center;padding:60px 20px;color:#94a3b8;font-size:14px">' +
      (isSpanish ? 'Canvas 2D no disponible. Usa un navegador moderno para ver el grafo de accion.' : 'Canvas 2D is not available. Use a modern browser to view the action graph.') +
      '</div>');
    canvas.style.display = 'none';
    return;
  }
  const graphShell = canvas.closest('.graph-shell');
  const fullscreenBtn = document.getElementById('graphFullscreen');
  const detail = document.getElementById('graphDetail');
  const fullscreenDetail = document.getElementById('graphFullscreenDetail');
  const projectBriefCard = document.getElementById('projectBriefCard');
  const projectBriefLive = document.getElementById('projectBriefLive');
  const projectBriefLoading = document.getElementById('projectBriefLoading');
  const projectBriefProject = document.getElementById('projectBriefProject');
  const projectBriefDate = document.getElementById('projectBriefDate');
  const projectBriefTrack = document.getElementById('projectBriefTrack');
  const projectBriefDots = document.getElementById('projectBriefDots');
  const briefPrev = document.getElementById('briefPrev');
  const briefNext = document.getElementById('briefNext');
  let briefCurrent = 0;
  let briefTimer = null;
  let briefPaused = false;
  let graph = { nodes: [], edges: [] };
  let activeProject = window.LYNX_INITIAL_PROJECT || '';
  let mode = 'value';
  let layout = 'force';
  let velocities = null; // Map<id, {vx,vy,vz}> for force layout
  let forceSettled = false;
  let rotX = -0.28, rotY = 0.48, zoom = 1;
  let dragging = false, lastX = 0, lastY = 0, projected = [];
  let selectedId = null;
  let lastFrame = performance.now();
  let drawQueued = false;
  let loading = false;
  let cameraFit = null;
  let lastCanvasWidth = 0;
  let lastCanvasHeight = 0;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const nextWidth = Math.max(640, Math.floor(rect.width * dpr));
    const nextHeight = Math.max(360, Math.floor(rect.height * dpr));
    if (canvas.width !== nextWidth) canvas.width = nextWidth;
    if (canvas.height !== nextHeight) canvas.height = nextHeight;
    if (lastCanvasWidth !== canvas.width || lastCanvasHeight !== canvas.height) {
      lastCanvasWidth = canvas.width;
      lastCanvasHeight = canvas.height;
      cameraFit = null;
    }
  }

  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  }

  async function load(options = {}) {
    if (loading) return;
    loading = true;
    const preserveCamera = options.preserveCamera === true;
    const preserveSelection = options.preserveSelection === true;
    const project = activeProject || window.LYNX_INITIAL_PROJECT || '';
    if (!project) {
      loading = false;
      return;
    }
    setActiveProjectCard(project);
    try {
      const res = await fetch('/api/action-graph?project=' + encodeURIComponent(project) + '&mode=' + encodeURIComponent(mode));
      graph = await res.json();
      if (!preserveCamera) {
        zoom = 1;
        cameraFit = null;
      }
      // Initialize force layout only on fresh loads
      if (layout === 'force' && !preserveCamera) {
        initForceLayout();
      } else if (layout !== 'force') {
        velocities = null;
        forceSettled = false;
      }
      if (!preserveSelection || !graph.nodes.some(n => n.id === selectedId)) {
        selectedId = null;
        renderDetail(null);
      } else {
        const selected = graph.nodes.find(n => n.id === selectedId);
        if (selected) renderDetail({ id: selected.id, node: selected });
      }
      requestDraw();
    } finally {
      loading = false;
    }
  }

  function setActiveProjectCard(project) {
    for (const card of document.querySelectorAll('[data-project-card]')) {
      card.classList.toggle('active', card.getAttribute('data-project-card') === project);
    }
    for (const card of document.querySelectorAll('[data-fs-project]')) {
      card.classList.toggle('active', card.getAttribute('data-fs-project') === project);
    }
    const sel = document.getElementById('projectSelect');
    if (sel && sel.value !== project) sel.value = project;
    renderProjectBrief(project);
  }

  function setActiveModeButtons() {
    document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.getAttribute('data-mode') === mode));
    document.querySelectorAll('[data-fs-mode]').forEach(b => b.classList.toggle('active', b.getAttribute('data-fs-mode') === mode));
  }

  function escHtml(str) {
    const span = document.createElement('span');
    span.textContent = str;
    return span.innerHTML;
  }

  function renderProjectBrief(project) {
    const briefs = window.LYNX_PROJECT_BRIEFS || {};
    const item = briefs[project];
    if (!projectBriefCard || !projectBriefTrack || !projectBriefDots || !projectBriefProject || !projectBriefDate) return;
    if (!item || !item.brief) {
      if (projectBriefLoading) projectBriefLoading.style.display = '';
      if (projectBriefLive) projectBriefLive.style.display = 'none';
      projectBriefCard.style.display = '';
      if (typeof startBriefIntroWithGraph === 'function' && !briefIntroRunning) startBriefIntroWithGraph(project);
      return;
    }
    // If counter animation is still running, defer until it finishes
    if (window.briefIntroDone === false) {
      window.pendingBriefProject = project;
      return;
    }
    if (projectBriefLoading) projectBriefLoading.style.display = 'none';
    if (projectBriefLive) projectBriefLive.style.display = '';
    projectBriefCard.style.display = '';
    projectBriefProject.textContent = project === 'lynx' ? 'LYNX' : project;
    projectBriefDate.textContent = item.generated_at ? 'generated ' + item.generated_at : 'cached';

    // Normalize brand name in brief text (LLM output varies casing)
    function normBrand(text) {
      return String(text || '').replace(/\blynx\b/gi, 'LYNX');
    }

    let sections = [];
    try {
      const parsed = JSON.parse(item.brief);
      sections = parsed.sections || [];
      // Normalize brief text in-place
      sections = sections.map(function(s) {
        return { title: normBrand(s.title), content: normBrand(s.content) };
      });
    } catch {}

    // Fallback: parse old markdown brief into sections
    if (!sections.length) {
      var parts = item.brief.split(/\n## /);
      for (var p = 0; p < parts.length; p++) {
        var lines = parts[p].trim().split('\n');
        var title = lines[0].replace(/^#+ /, '').trim();
        var content = lines.slice(1).join('\n').trim();
        if (title && content) sections.push({ title: title, content: content });
      }
      if (sections.length < 3) {
        sections = [{ title: 'Resumen', content: item.brief.slice(0, 800) || 'Sin contenido.' }];
      }
      // Normalize fallback sections too
      sections = sections.map(function(s) {
        return { title: normBrand(s.title), content: normBrand(s.content) };
      });
    }

    if (!sections.length) {
      projectBriefCard.style.display = 'none';
      return;
    }

    // Apple SF Symbol-style icons for brief section titles
    function iconForTitle(title) {
      var t = title.toLowerCase();
      // Question / overview / what-is
      if (/qué\s+es|what\s+is|resumen|overview|summary|intro/i.test(t)) {
        return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="vertical-align:-4px;margin-right:6px;flex-shrink:0"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M9.5 13.5a.75.75 0 0 1 1.5 0 .75.75 0 0 1-1.5 0ZM10 11.5V8.5A2.5 2.5 0 0 0 7.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      }
      // Architecture / structure
      if (/arquitectura|architecture|estructura|structure|diseño|design|componentes|components/i.test(t)) {
        return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="vertical-align:-4px;margin-right:6px;flex-shrink:0"><rect x="3" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="12" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="13" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="12" y="13" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><line x1="5.5" y1="7" x2="7" y2="12.5" stroke="currentColor" stroke-width="1.2"/><line x1="14.5" y1="7" x2="13" y2="12.5" stroke="currentColor" stroke-width="1.2"/></svg>';
      }
      // Technology / stack / languages
      if (/tecnolog|tech|stack|lenguajes|languages|herramientas|tools|framework/i.test(t)) {
        return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="vertical-align:-4px;margin-right:6px;flex-shrink:0"><path d="M6.5 5.5l-3 3 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.5 5.5l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="11" y1="3.5" x2="9" y2="16.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      }
      // Risks / hotspots / warnings
      if (/riesgos|risks|hotspots|problemas|issues|peligros|warnings|vulnerab/i.test(t)) {
        return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="vertical-align:-4px;margin-right:6px;flex-shrink:0"><path d="M10 3L2.5 17h15L10 3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><line x1="10" y1="8.5" x2="10" y2="12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="14.5" r="0.75" fill="currentColor"/></svg>';
      }
      // Entry points / routes / endpoints
      if (/entry|rutas|routes|endpoints|puntos\s+de\s+entrada|api/i.test(t)) {
        return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="vertical-align:-4px;margin-right:6px;flex-shrink:0"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M10 6v8M10 6L7 9M10 6l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      }
      // Dependencies / connections / graph / network
      if (/dependenc|connections|graph|network|relaciones|relations|conexiones/i.test(t)) {
        return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="vertical-align:-4px;margin-right:6px;flex-shrink:0"><circle cx="5" cy="5" r="2.5" stroke="currentColor" stroke-width="1.5"/><circle cx="15" cy="5" r="2.5" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="15" r="2.5" stroke="currentColor" stroke-width="1.5"/><line x1="7" y1="6.5" x2="8.5" y2="13" stroke="currentColor" stroke-width="1.2"/><line x1="13" y1="6.5" x2="11.5" y2="13" stroke="currentColor" stroke-width="1.2"/></svg>';
      }
      // Tests / quality
      if (/pruebas|tests|testing|calidad|quality|QA|verificac/i.test(t)) {
        return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="vertical-align:-4px;margin-right:6px;flex-shrink:0"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M6.5 10.5L9 13l4.5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      }
      // Performance / speed
      if (/rendimiento|performance|velocidad|speed|optimizac|optimization|latencia/i.test(t)) {
        return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="vertical-align:-4px;margin-right:6px;flex-shrink:0"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M10 3v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M10 10l3-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M3 10h1.5M15.5 10H17" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.4"/></svg>';
      }
      // Security
      if (/seguridad|security|auth|protección|proteccion|protec/i.test(t)) {
        return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="vertical-align:-4px;margin-right:6px;flex-shrink:0"><path d="M10 2.5l-6 4v5c0 4 2.5 6.5 6 7 3.5-.5 6-3 6-7v-5l-6-4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M7 10l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      }
      // Deploy / CI/CD / release
      if (/despliegue|deploy|release|CI\/CD|pipeline|build/i.test(t)) {
        return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="vertical-align:-4px;margin-right:6px;flex-shrink:0"><path d="M10 2.5L3 7l7 4.5L17 7l-7-4.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M3 13l7 4.5L17 13" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M3 10l7 4.5L17 10" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" opacity="0.5"/></svg>';
      }
      // Team / collaboration
      if (/equipo|team|colaborac|collaboration|personas|people|contrib/i.test(t)) {
        return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="vertical-align:-4px;margin-right:6px;flex-shrink:0"><circle cx="7" cy="6" r="2.5" stroke="currentColor" stroke-width="1.5"/><circle cx="13" cy="6" r="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M2 17c0-3 2-5 5-5h1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M18 17c0-3-2-5-5-5h-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      }
      // Data / database / storage
      if (/datos|data|database|base\s+de\s+datos|almacen/i.test(t)) {
        return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="vertical-align:-4px;margin-right:6px;flex-shrink:0"><ellipse cx="10" cy="4.5" rx="7" ry="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M3 4.5v11c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5v-11" stroke="currentColor" stroke-width="1.5"/><path d="M3 10c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5" stroke="currentColor" stroke-width="1.5" opacity="0.5"/></svg>';
      }
      // Recomendaciones / recommendations / next steps / future
      if (/recomendac|recommend|next\s+steps|pr.ximos\s+pasos|futuro|future|plan/i.test(t)) {
        return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="vertical-align:-4px;margin-right:6px;flex-shrink:0"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M10 6v4l2.5 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      }
      // Default: informational dot
      return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="vertical-align:-4px;margin-right:6px;flex-shrink:0"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><line x1="10" y1="6.5" x2="10" y2="10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="13.5" r="0.75" fill="currentColor"/></svg>';
    }

    projectBriefTrack.innerHTML = sections.map(function(s) {
      return '<article class="brief-section-card" tabindex="0"><h3>' + iconForTitle(s.title) + escHtml(s.title) + '</h3><p>' + escHtml(s.content) + '</p></article>';
    }).join('');

    projectBriefDots.innerHTML = sections.map(function(_, i) {
      return '<button class="brief-dot' + (i === 0 ? ' active' : '') + '" data-index="' + i + '" type="button" aria-label="Section ' + (i + 1) + '"></button>';
    }).join('');

    briefCurrent = 0;
    projectBriefTrack.style.transform = 'translateX(0)';

    // Mark first card as active
    var cards = projectBriefTrack.querySelectorAll('.brief-section-card');
    if (cards.length > 0) cards[0].classList.add('active');

    function goTo(i) {
      if (i < 0) i = sections.length - 1;
      if (i >= sections.length) i = 0;
      briefCurrent = i;
      projectBriefTrack.style.transform = 'translateX(-' + (briefCurrent * 100) + '%)';
      Array.from(projectBriefDots.querySelectorAll('.brief-dot')).forEach(function(d, j) {
        d.classList.toggle('active', j === briefCurrent);
      });
      Array.from(projectBriefTrack.querySelectorAll('.brief-section-card')).forEach(function(c, j) {
        c.classList.toggle('active', j === briefCurrent);
      });
    }

    briefPrev.onclick = function() { goTo(briefCurrent - 1); };
    briefNext.onclick = function() { goTo(briefCurrent + 1); };
    Array.from(projectBriefDots.querySelectorAll('.brief-dot')).forEach(function(d) {
      d.onclick = function() { goTo(parseInt(d.getAttribute('data-index'))); };
    });
    projectBriefCard.onmouseenter = function() { briefPaused = true; };
    projectBriefCard.onmouseleave = function() { briefPaused = false; };
    projectBriefCard.onkeydown = function(e) {
      if (e.key === 'ArrowLeft') goTo(briefCurrent - 1);
      if (e.key === 'ArrowRight') goTo(briefCurrent + 1);
    };
    if (briefTimer) clearInterval(briefTimer);
    briefTimer = setInterval(function() {
      if (!briefPaused && document.visibilityState === 'visible' && sections.length > 1) {
        goTo(briefCurrent + 1);
      }
    }, 7000);
  }

  function projectNode(n) {
    let x = n.x, y = n.y, z = n.z;
    const cy = Math.cos(rotY), sy = Math.sin(rotY);
    const cx = Math.cos(rotX), sx = Math.sin(rotX);
    const x1 = x * cy - z * sy;
    const z1 = x * sy + z * cy;
    const y1 = y * cx - z1 * sx;
    const z2 = y * sx + z1 * cx;
    const scale = 520 / (900 + z2);
    return {
      id: n.id,
      node: n,
      x: x1 * scale,
      y: y1 * scale,
      z: z2,
      r: Math.max(3, n.size * scale * 0.9),
      scale
    };
  }

  function setActiveLayoutButtons() {
    document.querySelectorAll('[data-layout]').forEach(b => b.classList.toggle('active', b.getAttribute('data-layout') === layout));
    document.querySelectorAll('[data-fs-layout]').forEach(b => b.classList.toggle('active', b.getAttribute('data-fs-layout') === layout));
  }

  function initForceLayout() {
    velocities = new Map();
    forceSettled = false;
    for (const n of graph.nodes) {
      // Random small initial velocity for symmetry breaking
      velocities.set(n.id, { vx: (Math.random() - 0.5) * 8, vy: (Math.random() - 0.5) * 8, vz: (Math.random() - 0.5) * 4 });
    }
  }

  function runForceStep(dt) {
    if (!velocities || forceSettled) return;
    const nodes = graph.nodes;
    const n = nodes.length;
    if (n === 0) return;

    // Clamp dt to avoid explosion on tab switch
    const step = Math.min(dt, 40) * 0.06;

    // Build edge adjacency for spring forces
    const neighbors = new Map();
    for (const e of graph.edges) {
      if (!neighbors.has(e.source)) neighbors.set(e.source, []);
      if (!neighbors.has(e.target)) neighbors.set(e.target, []);
      neighbors.get(e.source).push(e.target);
      neighbors.get(e.target).push(e.source);
    }

    // Compute forces
    const forces = new Map();
    for (let i = 0; i < n; i++) {
      forces.set(nodes[i].id, { fx: 0, fy: 0, fz: 0 });
    }

    // Repulsion: O(n^2) — all pairs
    const kRep = 9500;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const force = kRep / (dist * dist);
        const fx = (dx / dist) * force, fy = (dy / dist) * force, fz = (dz / dist) * force;
        forces.get(a.id).fx += fx; forces.get(a.id).fy += fy; forces.get(a.id).fz += fz;
        forces.get(b.id).fx -= fx; forces.get(b.id).fy -= fy; forces.get(b.id).fz -= fz;
      }
    }

    // Spring attraction along edges
    const kSpring = 0.004;
    const restLen = 95;
    for (const e of graph.edges) {
      const a = nodes.find(nd => nd.id === e.source), b = nodes.find(nd => nd.id === e.target);
      if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const displacement = dist - restLen;
      const force = kSpring * displacement;
      const fx = (dx / dist) * force, fy = (dy / dist) * force, fz = (dz / dist) * force;
      forces.get(a.id).fx += fx; forces.get(a.id).fy += fy; forces.get(a.id).fz += fz;
      forces.get(b.id).fx -= fx; forces.get(b.id).fy -= fy; forces.get(b.id).fz -= fz;
    }

    // Centering force + damping + velocity update
    const damping = 0.82;
    const centerPull = 0.002;
    let maxSpeed = 0;
    for (const node of nodes) {
      const v = velocities.get(node.id);
      const f = forces.get(node.id);
      // Pull toward origin
      f.fx -= node.x * centerPull;
      f.fy -= node.y * centerPull;
      f.fz -= node.z * centerPull;
      // Semi-implicit Euler
      v.vx = (v.vx + f.fx * step) * damping;
      v.vy = (v.vy + f.fy * step) * damping;
      v.vz = (v.vz + f.fz * step) * damping;
      // Clamp
      const speed = Math.sqrt(v.vx * v.vx + v.vy * v.vy + v.vz * v.vz);
      if (speed > maxSpeed) maxSpeed = speed;
      const maxV = 10;
      if (speed > maxV) { const s = maxV / speed; v.vx *= s; v.vy *= s; v.vz *= s; }
      node.x += v.vx * step;
      node.y += v.vy * step;
      node.z += v.vz * step;
    }

    // Consider settled when max speed is very low
    if (maxSpeed < 0.08) forceSettled = true;
  }

  function computeCameraFit(points) {
    if (!points.length) return { fit: 1, centerX: 0, centerY: 0, targetX: canvas.width / 2, targetY: canvas.height / 2 };
    const sortedX = points.map(p => p.x).sort((a, b) => a - b);
    const sortedY = points.map(p => p.y).sort((a, b) => a - b);
    const trim = points.length >= 40 ? Math.floor(points.length * 0.04) : 0;
    const lowX = sortedX[trim] ?? sortedX[0];
    const highX = sortedX[sortedX.length - 1 - trim] ?? sortedX[sortedX.length - 1];
    const lowY = sortedY[trim] ?? sortedY[0];
    const highY = sortedY[sortedY.length - 1 - trim] ?? sortedY[sortedY.length - 1];
    const core = points.filter(p => {
      return p.x >= lowX && p.x <= highX && p.y >= lowY && p.y <= highY;
    });
    const fitSource = core.length >= 12 ? core : points;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of fitSource) {
      const glow = p.r * 2.3;
      minX = Math.min(minX, p.x - glow);
      maxX = Math.max(maxX, p.x + glow);
      minY = Math.min(minY, p.y - glow);
      maxY = Math.max(maxY, p.y + glow);
    }
    const pad = Math.max(28, Math.min(canvas.width, canvas.height) * 0.07);
    const labelReserve = 72;
    const sidePanelReserve = document.fullscreenElement === graphShell ? Math.min(380, canvas.width * 0.34) : 0;
    const leftPanelReserve = document.fullscreenElement === graphShell ? Math.min(360, canvas.width * 0.31) : 0;
    const availableWidth = Math.max(1, canvas.width - pad * 2 - sidePanelReserve - leftPanelReserve);
    const availableHeight = Math.max(1, canvas.height - pad * 2 - labelReserve);
    const fit = Math.min(availableWidth / Math.max(1, maxX - minX), availableHeight / Math.max(1, maxY - minY));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const targetX = leftPanelReserve + (canvas.width - leftPanelReserve - sidePanelReserve) / 2;
    const targetY = labelReserve + availableHeight / 2;
    return { fit, centerX, centerY, targetX, targetY };
  }

  function applyCameraFit(points) {
    if (!points.length) return points;
    if (!cameraFit) cameraFit = computeCameraFit(points);
    const fit = cameraFit.fit * zoom;
    return points.map(p => ({
      ...p,
      x: cameraFit.targetX + (p.x - cameraFit.centerX) * fit,
      y: cameraFit.targetY + (p.y - cameraFit.centerY) * fit,
      r: Math.max(3, Math.min(22, p.r * fit))
    }));
  }

  function draw() {
    resize();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    projected = applyCameraFit(graph.nodes.map(projectNode)).sort((a, b) => a.z - b.z);
    const byId = new Map(projected.map(p => [p.id, p]));

    ctx.globalAlpha = 0.24;
    ctx.lineWidth = Math.max(0.75, canvas.width / 1600);
    for (const e of graph.edges) {
      const a = byId.get(e.source), b = byId.get(e.target);
      if (!a || !b) continue;
      ctx.strokeStyle = edgeColor(e.type);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const p of projected) {
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 2.15);
      g.addColorStop(0, p.node.color);
      g.addColorStop(0.32, p.node.color + '66');
      g.addColorStop(1, '#00000000');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 2.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = p.node.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      if (p.id === selectedId) {
        ctx.strokeStyle = '#f8fafc';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + 6, 0, Math.PI * 2);
        ctx.stroke();
        drawNodeLabel(p);
      }
    }

  }

  function drawNodeLabel(p) {
    const label = String(p.node.name || p.node.qn || '').slice(0, 42);
    if (!label) return;
    const fontSize = Math.max(11, Math.min(14, canvas.width / 95));
    ctx.font = '600 ' + fontSize + 'px Inter, sans-serif';
    const textWidth = ctx.measureText(label).width;
    const padX = 7;
    const labelW = textWidth + padX * 2;
    const labelH = fontSize + 9;
    let x = p.x + p.r + 10;
    let y = p.y - labelH / 2;
    if (x + labelW > canvas.width - 12) x = p.x - p.r - labelW - 10;
    if (y < 12) y = 12;
    if (y + labelH > canvas.height - 12) y = canvas.height - labelH - 12;
    ctx.fillStyle = 'rgba(15, 23, 42, .86)';
    ctx.strokeStyle = 'rgba(148, 163, 184, .42)';
    ctx.lineWidth = 1;
    roundRect(x, y, labelW, labelH, 7);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(label, x + padX, y + fontSize + 4);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function animate(now) {
    const dt = Math.min(50, now - lastFrame);
    lastFrame = now;
    if (layout === 'force' && !dragging && !forceSettled) {
      runForceStep(dt);
      requestDraw();
    }
    if (!dragging) {
      rotY += dt * 0.000035;
      rotX += Math.sin(now * 0.00018) * 0.000018;
      requestDraw();
    }
    requestAnimationFrame(animate);
  }

  function edgeColor(type) {
    if (type === 'CALLS') return '#38bdf8';
    if (type === 'IMPORTS') return '#64748b';
    if (type.includes('ROUTE')) return '#22c55e';
    return '#475569';
  }

  function nearest(x, y) {
    let best = null, dist = Infinity;
    for (const p of projected) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < Math.max(18, p.r * 2) && d < dist) { best = p; dist = d; }
    }
    return best;
  }

  function renderDetail(p) {
    let html = '';
    if (!p) {
      const counts = graph.role_counts || {};
      html =
        '<h3>' + (isSpanish ? 'Mapa de arquitectura accionable' : 'Actionable architecture map') + '</h3>' +
        '<p>' + escapeHtml(graph.narrative || (isSpanish ? 'Cargando grafo...' : 'Loading graph...')) + '</p>' +
        '<span class="detail-pill">' + graph.nodes.length + ' ' + (isSpanish ? 'nodos' : 'nodes') + '</span>' +
        '<span class="detail-pill">' + graph.edges.length + ' ' + (isSpanish ? 'aristas' : 'edges') + '</span>' +
        '<span class="detail-pill">' + (isSpanish ? 'modo ' : 'mode ') + escapeHtml(isSpanish && mode === 'value' ? 'valor' : isSpanish && mode === 'risk' ? 'riesgo' : isSpanish && mode === 'entry' ? 'entrada' : isSpanish && mode === 'hotspot' ? 'críticos' : mode) + '</span>' +
        '<div class="detail-section"><b>' + (isSpanish ? 'MEZCLA VISIBLE' : 'Visible mix') + '</b>' +
        '<p><span style="color:#22c55e">●</span> ' + (counts.value || 0) + ' ' + (isSpanish ? 'valor' : 'value') + ' · ' +
        '<span style="color:#ef4444">●</span> ' + (counts.risk || 0) + ' ' + (isSpanish ? 'riesgo' : 'risk') + ' · ' +
        '<span style="color:#38bdf8">●</span> ' + (counts.entry || 0) + ' ' + (isSpanish ? 'entrada' : 'entry') + ' · ' +
        '<span style="color:#f59e0b">●</span> ' + (counts.hotspot || 0) + ' ' + (isSpanish ? 'crítico' : 'hotspot') + '</p></div>' +
        '<p style="margin-top:10px">' + (isSpanish ? 'Haz clic en un nodo para inspeccionar riesgo, llamadores, llamados y la siguiente acción.' : 'Click a node to inspect risk, callers, callees and next action.') + '</p>' +
        '<span class="detail-pill">' + (isSpanish ? 'arrastrar para rotar' : 'drag to rotate') + '</span><span class="detail-pill">' + (isSpanish ? 'rueda para ampliar' : 'wheel to zoom') + '</span>';
      detail.innerHTML = html;
      if (fullscreenDetail) fullscreenDetail.innerHTML = html;
      return;
    }
    const n = p.node;
    html =
      '<h3><span class="node-title-dot" style="background:' + escapeHtml(n.color) + '"></span>' + escapeHtml(n.name) + '</h3>' +
      '<p>' + escapeHtml(n.qn) + '</p>' +
      '<p>' + escapeHtml(n.file) + '</p>' +
      '<span class="detail-pill">' + escapeHtml(n.kind) + '</span>' +
      '<span class="detail-pill">' + escapeHtml(n.role) + '</span>' +
      '<span class="detail-pill">fan-in ' + n.fanIn + '</span>' +
      '<span class="detail-pill">fan-out ' + n.fanOut + '</span>' +
      '<span class="detail-pill">risk ' + n.risk + '</span>' +
      '<span class="detail-pill">saves ~' + Number(n.tokens || 0).toLocaleString() + ' tokens</span>' +
      '<div class="detail-section"><b>Why it matters</b><p>' + escapeHtml(n.why || '') + '</p></div>' +
      '<div class="detail-section"><b>Risk</b><p>' + escapeHtml(n.riskText || '') + '</p></div>' +
      renderNameList('Top callers', n.callers) +
      renderNameList('Top callees', n.callees) +
      '<div class="detail-section"><b>Next action</b><p>' + escapeHtml(n.action || '') + '</p></div>';
    detail.innerHTML = html;
    if (fullscreenDetail) fullscreenDetail.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
  }

  function renderNameList(title, items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return '<div class="detail-section"><b>' + escapeHtml(title) + '</b><p>No visible subgraph matches.</p></div>';
    return '<div class="detail-section"><b>' + escapeHtml(title) + '</b><ul>' +
      list.map(item => '<li>' + escapeHtml(item) + '</li>').join('') +
      '</ul></div>';
  }

  canvas.addEventListener('pointerdown', e => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  window.addEventListener('pointerup', () => {
    dragging = false;
    canvas.style.cursor = 'grab';
  });
  window.addEventListener('pointermove', e => {
    if (!dragging) return;
    rotY += (e.clientX - lastX) * 0.006;
    rotX += (e.clientY - lastY) * 0.006;
    lastX = e.clientX; lastY = e.clientY;
    requestDraw();
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    zoom = Math.max(0.35, Math.min(3, zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    requestDraw();
  }, { passive: false });
  canvas.addEventListener('click', e => {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
    const p = nearest((e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy);
    selectedId = p ? p.id : null;
    renderDetail(p);
    requestDraw();
  });
  canvas.addEventListener('mousemove', e => {
    if (dragging) return;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
    canvas.style.cursor = nearest((e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy) ? 'pointer' : dragging ? 'grabbing' : 'grab';
  });
  for (const card of document.querySelectorAll('[data-project-card]')) {
    card.addEventListener('click', () => {
      activeProject = card.getAttribute('data-project-card');
      load();
      document.querySelector('.graph-toolbar')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  for (const card of document.querySelectorAll('[data-fs-project]')) {
    card.addEventListener('click', () => {
      activeProject = card.getAttribute('data-fs-project');
      load();
    });
  }
  const projectSelect = document.getElementById('projectSelect');
  if (projectSelect) {
    projectSelect.addEventListener('change', () => {
      activeProject = projectSelect.value;
      window.LYNX_INITIAL_PROJECT = activeProject;
      load();
    });
  }
  for (const btn of document.querySelectorAll('[data-mode]')) {
    btn.addEventListener('click', () => {
      mode = btn.getAttribute('data-mode');
      setActiveModeButtons();
      load();
    });
  }
  for (const btn of document.querySelectorAll('[data-fs-mode]')) {
    btn.addEventListener('click', () => {
      mode = btn.getAttribute('data-fs-mode');
      setActiveModeButtons();
      load();
    });
  }
  for (const btn of document.querySelectorAll('[data-layout]')) {
    btn.addEventListener('click', () => {
      layout = btn.getAttribute('data-layout');
      setActiveLayoutButtons();
      if (layout === 'ring') {
        velocities = null;
        forceSettled = false;
        cameraFit = null;
        load();
      } else {
        initForceLayout();
        requestDraw();
      }
    });
  }
  for (const btn of document.querySelectorAll('[data-fs-layout]')) {
    btn.addEventListener('click', () => {
      layout = btn.getAttribute('data-fs-layout');
      setActiveLayoutButtons();
      if (layout === 'ring') {
        velocities = null;
        forceSettled = false;
        cameraFit = null;
        load();
      } else {
        initForceLayout();
        requestDraw();
      }
    });
  }
  window.addEventListener('resize', requestDraw);
  fullscreenBtn?.addEventListener('click', async () => {
    if (!document.fullscreenElement) {
      await graphShell?.requestFullscreen?.();
    } else {
      await document.exitFullscreen?.();
    }
    requestDraw();
  });
  document.addEventListener('fullscreenchange', () => {
    fullscreenBtn.textContent = document.fullscreenElement ? '×' : '⛶';
    fullscreenBtn.title = document.fullscreenElement ? 'Salir de pantalla completa' : 'Pantalla completa';
    fullscreenBtn.setAttribute('aria-label', fullscreenBtn.title);
    cameraFit = null;
    requestDraw();
  });
  window.setInterval(() => {
    if (!dragging && document.visibilityState === 'visible') {
      load({ preserveCamera: true, preserveSelection: true });
    }
  }, 30000);
  load().then(() => requestAnimationFrame(animate));
})();
`;
}
