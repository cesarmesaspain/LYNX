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
    expect(script).toContain('llm-model-row');
    expect(script).toContain("architecture_overview: 'Architecture overview'");
    expect(script).toContain("project_operations: 'Project operations'");
  });

  it('restores the metrics tab after a reload', () => {
    expect(tabScript()).toContain('"metrics"');
  });
});
