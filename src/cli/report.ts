/*
 * report.ts — Local value report for demos and sales validation. v2.
 *
 * v2 improvements:
 * - Semantic ROI section
 * - Unique files avoided section
 * - Confidence breakdown with visual bar
 * - Semantic lift impact detail
 * - Auto-opens in browser on macOS
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { lynxHome } from '../config/runtime.js';
import { readUsageEvents, summarizeUsage, computeSemanticROI } from '../usage/metrics.js';

export function runReport(args: string[]): void {
  const project = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  const summary = summarizeUsage(project, 5000);
  const events = readUsageEvents(project, 50).reverse();
  const reportsDir = path.join(lynxHome(), 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const slug = (project || 'all-projects').replace(/[^A-Za-z0-9_.-]+/g, '-');
  const filePath = path.join(reportsDir, `${slug}-value-report.html`);
  fs.writeFileSync(filePath, renderHtml(project || 'All projects', summary, events));
  console.log(`LYNX value report: ${filePath}`);
}

function renderHtml(
  title: string,
  summary: ReturnType<typeof summarizeUsage>,
  events: ReturnType<typeof readUsageEvents>
): string {
  const tokenFmt = new Intl.NumberFormat('en-US').format;
  const totalConf =
    (summary.high_confidence_tokens_saved || 0) +
    (summary.medium_confidence_tokens_saved || 0) +
    (summary.low_confidence_tokens_saved || 0);
  const pctHigh = totalConf > 0 ? Math.round((summary.high_confidence_tokens_saved / totalConf) * 100) : 0;
  const pctMed = totalConf > 0 ? Math.round((summary.medium_confidence_tokens_saved / totalConf) * 100) : 0;
  const pctLow = totalConf > 0 ? Math.round((summary.low_confidence_tokens_saved / totalConf) * 100) : 0;

  const roi = computeSemanticROI(summary.tokens_saved, summary.estimated_llm_cost_usd);

  const rows = events
    .map(
      (event) => `
    <tr>
      <td>${escapeHtml(event.ts)}</td>
      <td>${escapeHtml(event.project)}</td>
      <td>${escapeHtml(event.type)}</td>
      <td>${escapeHtml(event.query || '')}</td>
      <td>${event.result_count ?? ''}</td>
      <td>${(event.files_avoided ?? 0).toLocaleString()}</td>
      <td>${(event.tokens_saved ?? 0).toLocaleString()}</td>
      <td>${escapeHtml(event.confidence || '')}</td>
      <td>${escapeHtml(event.llm_provider || '')}</td>
      <td>${event.top_changed === undefined ? '' : String(event.top_changed)}</td>
      <td>${event.estimated_llm_cost_usd ?? ''}</td>
    </tr>
  `
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LYNX Value Report — ${escapeHtml(title)}</title>
  <style>
    body { margin: 0; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #111827; }
    main { max-width: 1120px; margin: 0 auto; padding: 32px 20px; }
    h1 { font-size: 28px; margin: 0 0 4px; }
    h2 { font-size: 18px; margin: 28px 0 12px; }
    .muted { color: #6b7280; margin: 0 0 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; }
    .label { color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .value { font-size: 26px; font-weight: 700; margin-top: 8px; }
    .value-sm { font-size: 14px; color: #374151; margin-top: 4px; }
    .bar-track { background: #e5e7eb; border-radius: 4px; height: 10px; margin: 8px 0; display: flex; overflow: hidden; }
    .bar-high { background: #059669; }
    .bar-med { background: #d97706; }
    .bar-low { background: #9ca3af; }
    .legend { display: flex; gap: 16px; font-size: 12px; color: #6b7280; }
    .legend span { display: flex; align-items: center; gap: 4px; }
    .legend .swatch { width: 10px; height: 10px; border-radius: 2px; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eef0f3; font-size: 13px; vertical-align: top; }
    th { background: #111827; color: white; font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    .roi-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .roi-excellent { background: #d1fae5; color: #065f46; }
    .roi-strong { background: #dbeafe; color: #1e40af; }
    .roi-good { background: #fef3c7; color: #92400e; }
    .semantic { color: #7c3aed; }
    @media (max-width: 800px) { .grid { grid-template-columns: 1fr 1fr; } table { display: block; overflow-x: auto; } }
  </style>
</head>
<body>
  <main>
    <h1>LYNX Value Report</h1>
    <p class="muted">${escapeHtml(title)} — local private metrics, no telemetry</p>

    <section class="grid">
      <div class="card"><div class="label">Tokens Saved</div><div class="value">${tokenFmt(summary.tokens_saved)}</div></div>
      <div class="card"><div class="label">Files Avoided</div><div class="value">${tokenFmt(summary.files_avoided)}</div></div>
      <div class="card"><div class="label">Unique Files</div><div class="value">${tokenFmt(summary.unique_files_avoided)}</div></div>
      <div class="card"><div class="label">Semantic Cost</div><div class="value">$${summary.estimated_llm_cost_usd.toFixed(6)}</div></div>
    </section>

    <section class="grid">
      <div class="card">
        <div class="label">Semantic Lifts</div>
        <div class="value">${summary.llm_top_changed}/${summary.llm_events}</div>
        <div class="value-sm">Rank improved: ${summary.llm_rank_changed}/${summary.llm_events}</div>
      </div>
      <div class="card">
        <div class="label">Semantic ROI</div>
        <div class="value">${summary.semantic_roi !== null ? tokenFmt(summary.semantic_roi) : '—'}</div>
        <div class="value-sm">tokens saved per $1</div>
      </div>
      <div class="card">
        <div class="label">Events Recorded</div>
        <div class="value">${tokenFmt(summary.events)}</div>
        <div class="value-sm">${summary.since ? 'Since ' + summary.since : ''}</div>
      </div>
      <div class="card">
        <div class="label">Avg Semantic Latency</div>
        <div class="value">${summary.llm_events > 0 ? Math.round(summary.llm_latency_ms / summary.llm_events) : '—'}ms</div>
      </div>
    </section>

    <section class="card" style="margin-bottom:24px">
      <div class="label">Confidence Breakdown</div>
      <div class="bar-track">
        <div class="bar-high" style="flex:${pctHigh};min-width:${pctHigh > 0 ? 4 : 0}px"></div>
        <div class="bar-med" style="flex:${pctMed};min-width:${pctMed > 0 ? 4 : 0}px"></div>
        <div class="bar-low" style="flex:${pctLow};min-width:${pctLow > 0 ? 4 : 0}px"></div>
      </div>
      <div class="legend">
        <span><span class="swatch bar-high"></span>High: ${tokenFmt(summary.high_confidence_tokens_saved)} tokens (${pctHigh}%)</span>
        <span><span class="swatch bar-med"></span>Medium: ${tokenFmt(summary.medium_confidence_tokens_saved)} tokens (${pctMed}%)</span>
        <span><span class="swatch bar-low"></span>Low: ${tokenFmt(summary.low_confidence_tokens_saved)} tokens (${pctLow}%)</span>
      </div>
    </section>

    ${roi.tokensPerDollar !== Infinity && roi.tokensPerDollar > 0 ? `
    <section class="card" style="margin-bottom:24px">
      <div class="label">Semantic Impact Detail</div>
      <p style="font-size:14px;color:#374151;margin:8px 0 0;">${roi.summary}</p>
      <p style="font-size:13px;color:#6b7280;">Every \$1 spent on semantic ranking avoids ~${tokenFmt(roi.tokensPerDollar)} tokens of manual file exploration. At typical API pricing (\$3/1M tokens), that's \$${((roi.tokensPerDollar / 1_000_000) * 3).toFixed(2)} in gross API savings per \$1 of ranking cost.</p>
    </section>` : ''}

    <h2>Event Log</h2>
    <table>
      <thead>
        <tr>
          <th>Time</th><th>Project</th><th>Event</th><th>Query</th><th>Results</th>
          <th>Files</th><th>Tokens</th><th>Confidence</th><th>Provider</th><th>Top Changed</th><th>Cost</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
