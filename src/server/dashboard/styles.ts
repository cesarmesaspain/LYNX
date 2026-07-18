/*
 * dashboard/styles.ts — Dashboard CSS.
 */

export function renderStyles(): string {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root { color-scheme: dark; }
    body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: radial-gradient(1000px 460px at 50% -220px, #1d4d69 0%, transparent 68%), #08111f; color: #e6edf6; min-height: 100vh; letter-spacing: -0.01em; }
    header { position: sticky; top: 0; z-index: 20; background: rgba(8,17,31,.78); border-bottom: 1px solid rgba(148,163,184,.16); padding: 13px clamp(18px,3vw,40px); display: flex; align-items: center; justify-content: space-between; backdrop-filter: blur(18px) saturate(150%); }
    header h1 { font-size: 17px; font-weight: 760; letter-spacing: -.035em; color: #f8fbff; }
    .header-controls { display: flex; align-items: center; gap: 10px; min-width: 0; }
    header .badge { background: rgba(56,189,248,.09); border: 1px solid rgba(103,232,249,.16); color: #b9e8f5; padding: 6px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .lynx-enabled-toggle { display:inline-flex; align-items:center; gap:7px; border:1px solid; border-radius:999px; padding:6px 11px; background:transparent; color:#dbeafe; font:inherit; font-size:11px; font-weight:700; cursor:pointer; transition:all .2s; }
    .lynx-enabled-toggle.is-enabled { border-color:rgba(74,222,128,.42); background:rgba(34,197,94,.10); color:#86efac; }
    .lynx-enabled-toggle.is-disabled { border-color:rgba(148,163,184,.32); background:rgba(71,85,105,.22); color:#cbd5e1; }
    .lynx-enabled-toggle:hover { filter:brightness(1.15); }
    .lynx-enabled-toggle:disabled { opacity:.55; cursor:wait; }
    .lynx-enabled-dot { width:7px; height:7px; border-radius:50%; background:currentColor; box-shadow:0 0 10px currentColor; }
    #localeSelect { background: rgba(15,30,48,.9) !important; border-color: rgba(148,163,184,.26) !important; border-radius: 999px !important; padding: 6px 10px !important; }
    .tab-bar { position: sticky; top: 47px; z-index: 19; display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; background: rgba(8,17,31,.7); border-bottom: 1px solid rgba(148,163,184,.12); padding: 7px clamp(14px,3vw,38px); backdrop-filter: blur(16px); }
    .tab-bar::-webkit-scrollbar { display: none; }
    .tab-btn { background: transparent; border: 1px solid transparent; border-radius: 8px; color: #8293a9; font: inherit; font-size: 12px; font-weight: 600; padding: 7px 11px; cursor: pointer; border-bottom: 1px solid transparent; transition: color .18s, background .18s, border-color .18s, transform .18s; white-space: nowrap; }
    .tab-btn:hover { color: #e5f6ff; background: rgba(56,189,248,.08); border-color: rgba(103,232,249,.14); }
    .tab-btn.active { color: #d9f7ff; border-color: rgba(103,232,249,.3); background: linear-gradient(135deg, rgba(14,116,144,.34), rgba(30,41,59,.5)); box-shadow: inset 0 1px 0 rgba(255,255,255,.08); }
    .tab-btn .tab-icon { margin-right: 7px; font-size: 16px; }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    main { max-width: 1360px; margin: 0 auto; padding: 24px clamp(16px,3vw,40px) 42px; }
    .summary-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin-bottom: 24px; }
    .summary-card { position: relative; overflow: hidden; background: linear-gradient(145deg, rgba(28,45,66,.9), rgba(15,27,44,.95)); border: 1px solid rgba(148,163,184,.17); border-radius: 12px; padding: 13px 13px; min-width: 0; box-shadow: inset 0 1px 0 rgba(255,255,255,.05), 0 12px 28px rgba(0,0,0,.12); transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease; }
    .summary-card::before { content: ''; position: absolute; inset: 0 0 auto; height: 2px; background: linear-gradient(90deg, #38bdf8, transparent 68%); opacity: .7; }
    .summary-card:hover { transform: translateY(-2px); border-color: rgba(103,232,249,.36); box-shadow: inset 0 1px 0 rgba(255,255,255,.07), 0 18px 40px rgba(0,0,0,.22); }
    .summary-card .label { color: #8fa2b8; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .09em; }
    .summary-card .value { font-size: clamp(19px, 1.7vw, 27px); font-weight: 740; margin-top: 6px; color: #f6f9fd; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .summary-card .value.token-value { color: #4ade80; }
    .token-label-dollar { color:#4ade80; font-size:19px; font-weight:800; line-height:0; vertical-align:-2px; margin-right:5px; }
    button:focus-visible, select:focus-visible { outline: 2px solid #67e8f9; outline-offset: 3px; }
    .brief-card { margin: 0 0 26px; padding: 18px; background: linear-gradient(180deg, #202b3d, #172033); border: 1px solid #334155; border-radius: 10px; overflow: hidden; }
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
    .project-card-wrap { position: relative; }
    .project-card { cursor: pointer; text-align: left; width: 100%; font: inherit; color: inherit; transition: border-color .16s ease, transform .16s ease, background .16s ease; }
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
    .graph-shell { position: relative; height: 440px; overflow: hidden; background: radial-gradient(circle at 50% 30%, #172554, #020617 64%); }
    .graph-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
    .graph-toolbar button { background: #0f172a; color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; padding: 8px 10px; }
    .graph-toolbar button.active { border-color: #22d3ee; color: #67e8f9; }
    #actionGraph { width: 100%; height: 100%; display: block; }
    .fullscreen-btn { position: absolute; right: 14px; top: 14px; z-index: 2; width: 36px; height: 36px; display: grid; place-items: center; background: rgba(15, 23, 42, .78); color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; cursor: pointer; font-size: 18px; line-height: 1; }
    .fullscreen-btn:hover { border-color: #38bdf8; color: #67e8f9; background: rgba(15, 23, 42, .94); }
    .graph-layout-controls { position: absolute; left: 14px; top: 14px; z-index: 2; display: flex; gap: 5px; padding: 4px; background: rgba(15,23,42,.76); border: 1px solid rgba(148,163,184,.24); border-radius: 9px; backdrop-filter: blur(10px); }
    .graph-layout-controls button { padding: 6px 9px; background: transparent; color: #aab9ca; border: 1px solid transparent; border-radius: 6px; font: inherit; font-size: 11px; font-weight: 650; cursor: pointer; }
    .graph-layout-controls button:hover, .graph-layout-controls button.active { color: #e7fbff; background: rgba(14,116,144,.34); border-color: rgba(103,232,249,.26); }
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
    @media (max-width: 900px) { .action-graph { grid-template-columns: 1fr; } .graph-shell { height: 360px; } .brief-section-card { min-height: 220px; } }
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
      background: rgba(56,189,248,.08); border: 1px solid rgba(103,232,249,.22); border-radius: 8px; color: #c9f3ff; font: inherit; font-size: 12px; font-weight: 650;
      padding: 6px 9px; cursor: pointer; transition: color .2s, background .2s, border-color .2s, transform .2s;
      white-space: nowrap; display: flex; align-items: center; gap: 6px; margin-left: auto; margin-right: 0; flex: 0 0 auto;
    }
    .add-project-btn-tab:hover { color: #fff; border-color: rgba(103,232,249,.5); background: rgba(14,116,144,.25); transform: translateY(-1px); }
    .add-project-btn-tab .plus-circle {
      width: 20px; height: 20px; border-radius: 50%;
      background: rgba(15,30,48,.8); border: 1px solid rgba(103,232,249,.34);
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
    .metrics-toolbar { display: flex; align-items: end; gap: 18px; padding: 26px 28px 18px; border-bottom: 1px solid rgba(51,65,85,.72); flex-wrap: wrap; }
    .metrics-heading { margin-right: auto; }
    .metrics-heading h2 { margin: 0; font-size: 18px; letter-spacing: -.02em; }
    .metrics-heading span { display: block; margin-top: 4px; color: #64748b; font-size: 12px; }
    .metrics-controls { display: flex; align-items: end; gap: 12px; }
    .metrics-project-control { display: grid; gap: 5px; color: #64748b; font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .metrics-project-control select { min-width: 150px; appearance: auto; background: #101b2d; color: #dbe7f5; border: 1px solid #334155; border-radius: 8px; padding: 8px 10px; font: 600 13px inherit; }
    .metrics-window { display: flex; padding: 3px; background: #101b2d; border: 1px solid #29384d; border-radius: 9px; }
    .win-btn { background: transparent; border: 0; color: #8492a7; min-width: 42px; padding: 7px 10px; border-radius: 6px; cursor: pointer; font: 600 12px inherit; transition: color .2s, background .2s; }
    .win-btn:hover { color: #e2e8f0; background: rgba(71,85,105,.42); }
    .win-btn.active { background: #123c5a; box-shadow: inset 0 0 0 1px #259dcc; color: #7dd3fc; }
    .metrics-export-btn { background: transparent; border: 1px solid #256b8f; color: #7dd3fc; padding: 7px 14px; border-radius: 7px; cursor: pointer; font: 600 11px inherit; transition: background .2s, color .2s; white-space: nowrap; }
    .metrics-export-btn:hover { background: #164e63; color: #cffafe; }
    .metrics-clear-btn { background: transparent; border: 1px solid #7f1d1d; color: #fca5a5; padding: 7px 14px; border-radius: 7px; cursor: pointer; font: 600 11px inherit; transition: background .2s, color .2s; white-space: nowrap; }
    .metrics-clear-btn:hover { background: #7f1d1d; color: #fecaca; }
    .metrics-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 12px; padding: 22px 28px 18px; }
    .metric-card { min-height: 114px; background: linear-gradient(145deg, #1d2a3e, #182438); border: 1px solid rgba(71,85,105,.46); border-radius: 12px; padding: 16px; text-align: left; box-shadow: 0 8px 18px rgba(0,0,0,.1); transition: border-color .2s, transform .2s; }
    .metric-card:hover { border-color: #475569; transform: translateY(-1px); }
    .metric-card-primary { background: linear-gradient(145deg, #17354a, #192a3e); border-color: rgba(56,189,248,.28); }
    .metric-label { color: #94a3b8; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .09em; margin-bottom: 10px; }
    .metric-value { color: #f1f5f9; font-size: 25px; line-height: 1; font-weight: 750; letter-spacing: -.04em; font-variant-numeric: tabular-nums; }
    .metric-sub { color: #718198; font-size: 11px; margin-top: 9px; min-height: 16px; }
    .metric-sub .metrics-badge { vertical-align: top; }
    .metrics-bars { padding: 0 28px 20px; }
    .metrics-section-heading, .llm-model-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 0 10px; }
    .metrics-section-heading span, .llm-model-heading span { display: block; color: #dbe7f5; font-size: 13px; font-weight: 700; }
    .metrics-section-heading small, .llm-model-heading small { display: block; margin-top: 3px; color: #64748b; font-size: 11px; }
    .bars-placeholder { color: #64748b; font-style: italic; padding: 36px; text-align: center; background: #101b2d; border: 1px dashed #334155; border-radius: 10px; }
    .bar-row { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
    .bar-label { width: 168px; text-align: right; font-size: 12px; color: #9aa9bc; flex-shrink: 0; }
    .bar-track { flex: 1; height: 18px; background: #101b2d; border: 1px solid rgba(51,65,85,.5); border-radius: 5px; overflow: hidden; position: relative; }
    .bar-fill { height: 100%; border-radius: 4px; transition: width .3s ease; min-width: 2px; box-shadow: 0 0 16px rgba(56,189,248,.18); }
    .bar-value { width: 88px; font-size: 12px; color: #dbe7f5; font-variant-numeric: tabular-nums; flex-shrink: 0; text-align: right; }
    .metrics-coverage { padding: 0 28px 16px; }
    .coverage-text { color: #91a0b5; font-size: 12px; line-height: 1.55; padding: 13px 15px; background: #101b2d; border: 1px solid rgba(51,65,85,.52); border-radius: 10px; }
    .metrics-insight .coverage-text { border-left: 3px solid #38bdf8; }
    .llm-breakdown { padding-top: 4px; }
    .llm-model-list { background: #101b2d; border: 1px solid rgba(51,65,85,.62); border-radius: 10px; overflow: hidden; }
    .llm-model-row { display: grid; grid-template-columns: minmax(200px,1.5fr) repeat(3, minmax(105px,.5fr)); gap: 16px; align-items: center; padding: 14px 16px; }
    .llm-model-row + .llm-model-row { border-top: 1px solid rgba(51,65,85,.62); }
    .llm-model-name { display: flex; align-items: center; gap: 9px; min-width: 0; color: #dbe7f5; font-size: 13px; }
    .llm-model-name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .llm-model-dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 999px; background: #a78bfa; box-shadow: 0 0 0 4px rgba(167,139,250,.12); }
    .llm-model-stat { text-align: right; }
    .llm-model-stat b { display: block; color: #f1f5f9; font-size: 13px; font-variant-numeric: tabular-nums; }
    .llm-model-stat span { display: block; margin-top: 3px; color: #64748b; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
    .metrics-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .prov-measured { background: rgba(34,197,94,.15); color: #4ade80; }
    .prov-estimated { background: rgba(245,158,11,.15); color: #fbbf24; }
    .prov-scenario { background: rgba(139,92,246,.15); color: #a78bfa; }

    /* Settings tab */
    .settings-section { border: 1px solid #334155; border-radius: 12px; background: #1e293b; padding: 20px; margin-bottom: 20px; }
    .settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; align-items: start; }
    .settings-grid .settings-section { margin-bottom: 0; height: 100%; }
    .settings-section h3 { font-size: 16px; margin: 0 0 16px; color: #e2e8f0; display: flex; align-items: center; gap: 8px; }
    .settings-section h3 .tab-icon { color: #a78bfa; }
    .settings-help { max-width: 720px; margin: -5px 0 18px; color: #94a3b8; font-size: 13px; line-height: 1.55; }
    .settings-agent-response { background: linear-gradient(145deg, rgba(30,41,59,.98), rgba(21,35,55,.92)); border-color: rgba(103,232,249,.22); }
    .settings-inline { display: inline-flex; align-items: center; gap: 8px; color: #94a3b8; font-size: 13px; }
    .settings-inline .settings-input { min-width: 0; flex: 0 0 auto; padding: 8px 10px; }
    .settings-field { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
    .settings-field label { min-width: 110px; font-size: 13px; color: #94a3b8; }
    .settings-input { background: #0f172a; color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; font: inherit; font-size: 13px; flex: 1; min-width: 220px; max-width: 480px; }
    .settings-input:focus { border-color: #38bdf8; outline: none; box-shadow: 0 0 0 2px rgba(56,189,248,.15); }
    .settings-input::placeholder { color: #475569; }
    .settings-toggle-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .settings-toggle-row label { min-width: 110px; font-size: 13px; color: #94a3b8; }
    .settings-toggle { position: relative; width: 44px; height: 24px; cursor: pointer; }
    .settings-toggle input { opacity: 0; width: 0; height: 0; }
    .settings-toggle .toggle-slider { position: absolute; inset: 0; background: #334155; border-radius: 24px; transition: .25s; }
    .settings-toggle .toggle-slider::before { content: ''; position: absolute; width: 18px; height: 18px; left: 3px; bottom: 3px; background: #94a3b8; border-radius: 50%; transition: .25s; }
    .settings-toggle input:checked + .toggle-slider { background: #38bdf8; }
    .settings-toggle input:checked + .toggle-slider::before { transform: translateX(20px); background: #fff; }
    .settings-save-btn { background: #1e3a5f; color: #e2e8f0; border: 1px solid rgba(56,189,248,.4); border-radius: 8px; padding: 10px 18px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .2s; }
    .settings-save-btn:hover { background: #2a4a6f; border-color: #38bdf8; color: #fff; }
    .settings-flash { display: inline-block; margin-left: 12px; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; transition: opacity .3s; }
    .settings-flash.ok { background: rgba(34,197,94,.15); color: #4ade80; }
    .settings-flash.err { background: rgba(239,68,68,.15); color: #fca5a5; }
    .settings-separator { border: none; border-top: 1px solid #334155; margin: 18px 0; }
    @media (max-width: 900px) { .settings-grid { grid-template-columns: 1fr; } .settings-grid .settings-section { height: auto; } }`;
}
