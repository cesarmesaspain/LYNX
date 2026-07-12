/*
 * dashboard/styles.ts — Dashboard CSS.
 */

export function renderStyles(): string {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    header { background: #1e293b; border-bottom: 1px solid #334155; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
    header h1 { font-size: 20px; font-weight: 700; }
    header .badge { background: #334155; color: #94a3b8; padding: 4px 10px; border-radius: 6px; font-size: 12px; }
    .tab-bar { display: flex; gap: 0; background: #0f172a; border-bottom: 1px solid #334155; padding: 0 24px; }
    .tab-btn { background: none; border: none; color: #64748b; font: inherit; font-size: 14px; font-weight: 500; padding: 14px 20px; cursor: pointer; border-bottom: 2px solid transparent; transition: all .2s; white-space: nowrap; }
    .tab-btn:hover { color: #cbd5e1; }
    .tab-btn.active { color: #38bdf8; border-bottom-color: #38bdf8; }
    .tab-btn .tab-icon { margin-right: 7px; font-size: 16px; }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    main { max-width: 1280px; margin: 0 auto; padding: 24px 20px; }
    .summary-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin-bottom: 28px; }
    .summary-card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 12px; min-width: 0; }
    .summary-card .label { color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
    .summary-card .value { font-size: clamp(20px, 1.8vw, 28px); font-weight: 700; margin-top: 6px; color: #f1f5f9; overflow-wrap: anywhere; }
    .summary-card .value.token-value { color: #4ade80; }
    .token-label-dollar { color:#4ade80; font-size:19px; font-weight:800; line-height:0; vertical-align:-2px; margin-right:5px; }
    .value-strip { margin: -10px 0 26px; padding: 14px 16px; display: flex; gap: 12px; align-items: center; background: #162033; border: 1px solid #334155; border-radius: 10px; color: #cbd5e1; font-size: 13px; }
    .value-strip b { color: #f8fafc; white-space: nowrap; }
    .brief-card { margin: -12px 0 26px; padding: 18px; background: linear-gradient(180deg, #202b3d, #172033); border: 1px solid #334155; border-radius: 10px; overflow: hidden; }
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
    .project-card { cursor: pointer; text-align: left; width: 100%; font: inherit; color: inherit; transition: border-color .16s ease, transform .16s ease, background .16s ease; position: relative; }
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
    .graph-shell { position: relative; height: 520px; overflow: hidden; background: radial-gradient(circle at 50% 30%, #172554, #020617 64%); }
    .graph-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
    .graph-toolbar button { background: #0f172a; color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; padding: 8px 10px; }
    .graph-toolbar button.active { border-color: #22d3ee; color: #67e8f9; }
    #actionGraph { width: 100%; height: 100%; display: block; }
    .fullscreen-btn { position: absolute; right: 14px; top: 14px; z-index: 2; width: 36px; height: 36px; display: grid; place-items: center; background: rgba(15, 23, 42, .78); color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; cursor: pointer; font-size: 18px; line-height: 1; }
    .fullscreen-btn:hover { border-color: #38bdf8; color: #67e8f9; background: rgba(15, 23, 42, .94); }
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
    @media (max-width: 900px) { .action-graph { grid-template-columns: 1fr; } .graph-shell { height: 420px; } .brief-section-card { min-height: 220px; } }
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
      background: none; border: none; color: #94a3b8; font: inherit; font-size: 14px; font-weight: 500;
      padding: 14px 20px; cursor: pointer; border-bottom: 2px solid transparent; transition: all .2s;
      white-space: nowrap; display: flex; align-items: center; gap: 8px; margin-left: auto; margin-right: 0;
    }
    .add-project-btn-tab:hover { color: #cbd5e1; }
    .add-project-btn-tab .plus-circle {
      width: 28px; height: 28px; border-radius: 50%;
      background: #1e293b; border: 1.5px dashed #475569;
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
    .metrics-toolbar { display: flex; align-items: center; gap: 4px; padding: 20px 24px 12px; flex-wrap: wrap; }
    .win-btn { background: #1e293b; border: 1px solid #334155; color: #94a3b8; padding: 7px 14px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 13px; transition: all .2s; }
    .win-btn:hover { color: #e2e8f0; border-color: #475569; }
    .win-btn.active { background: #1e3a5f; border-color: #38bdf8; color: #38bdf8; font-weight: 600; }
    .metrics-summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; padding: 0 24px 20px; }
    .metric-card { background: #1e293b; border: 1px solid #1e293b; border-radius: 10px; padding: 16px; text-align: center; transition: border-color .2s; }
    .metric-card:hover { border-color: #334155; }
    .metric-label { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px; }
    .metric-value { color: #e2e8f0; font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .metric-sub { color: #64748b; font-size: 11px; margin-top: 4px; }
    .metrics-bars { padding: 0 24px 20px; }
    .bars-placeholder { color: #64748b; font-style: italic; padding: 40px; text-align: center; }
    .bar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .bar-label { width: 170px; text-align: right; font-size: 13px; color: #94a3b8; flex-shrink: 0; }
    .bar-track { flex: 1; height: 22px; background: #0f172a; border-radius: 6px; overflow: hidden; position: relative; }
    .bar-fill { height: 100%; border-radius: 6px; transition: width .3s ease; min-width: 2px; }
    .bar-value { width: 90px; font-size: 13px; color: #e2e8f0; font-variant-numeric: tabular-nums; flex-shrink: 0; text-align: right; }
    .metrics-coverage { padding: 0 24px 20px; }
    .coverage-text { color: #64748b; font-size: 13px; padding: 12px; background: #0f172a; border-radius: 8px; }
    .metrics-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .prov-measured { background: rgba(34,197,94,.15); color: #4ade80; }
    .prov-estimated { background: rgba(245,158,11,.15); color: #fbbf24; }
    .prov-scenario { background: rgba(139,92,246,.15); color: #a78bfa; }
`;
}
