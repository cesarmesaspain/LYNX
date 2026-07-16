import { describe, expect, it } from 'vitest';
import { metricsTabScript } from '../../../src/server/dashboard/scripts/metrics-tab.js';
import { tabScript } from '../../../src/server/dashboard/scripts/tabs.js';

describe('dashboard metrics interaction', () => {
  it('localizes category labels rendered from metric data', () => {
    const script = metricsTabScript(false, [], 0, 0);

    expect(script).toContain("direct_discovery: 'Direct discovery'");
    expect(script).toContain("llm_rerank: 'Semantic reranking'");
    expect(script).toContain('escapeHtml(label)');
    expect(script).toContain('Events recorded without LLM');
    expect(script).toContain('mtNetSavings');
    expect(script).toContain('estimated net savings');
    expect(script).toContain('savings_attribution');
    expect(script).toContain('events without attributable results are recorded as activity only');
    expect(script).toContain('LLM usage by model');
    expect(script).toContain('Model not recorded');
    expect(script).toContain("row.model || (row.provider + ' · ' + legacy)");
    expect(script).toContain('function fitMetricValues()');
    expect(script).toContain('element.scrollWidth > element.clientWidth');
    expect(script).toContain('new ResizeObserver');
    expect(script).not.toContain("metricEls.events.textContent = '...'");
    expect(script).toContain('function updateBarsHtml(html)');
    expect(script).toContain(".metric-explainer:hover, .metric-explainer:focus");
    expect(script).toContain('pendingBarsHtml');
    expect(script).toContain('llm-model-row');
    expect(script).toContain("architecture_overview: 'Architecture overview'");
    expect(script).toContain("project_operations: 'Project operations'");
    expect(script).toContain("document.getElementById('exportMetricsCsv')");
    expect(script).toContain("'&format=csv'");
    expect(script).toContain("'&project=' + encodeURIComponent(project)");
    expect(script).toContain("localStorage.getItem('lynx.metrics.project')");
    expect(script).toContain("localStorage.setItem('lynx.metrics.project', projSelect.value)");
    expect(script).toContain("localStorage.removeItem('lynx.metrics.project')");
    expect(script).toContain('categoryExplanation');
    expect(script).toContain("return label + '. ' + categoryExplanation(category)");
    expect(script).not.toContain('La longitud de la barra es relativa');
    expect(script).not.toContain('Bar length is relative');
    expect(script).toContain('data-tooltip=');
    expect(script).toContain('tabindex="0"');
  });

  it('restores the metrics tab after a reload', () => {
    expect(tabScript()).toContain('"metrics"');
  });
});
