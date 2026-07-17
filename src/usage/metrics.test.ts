import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSessionDedup,
  clearUsageEvents,
  computeSemanticROI,
  defaultUsageContext,
  estimateRerankCostUsd,
  estimateArchitectureOverviewSavings,
  estimateToolOperationSavings,
  attributeLegacyToolObservation,
  estimateTokensFromFiles,
  estimateTokensSaved,
  exportUsageEvents,
  recordUsageEvent,
  summarizeUsage,
  usageLogPath,
} from './metrics.js';
import { layerValueMetrics } from './value-metrics.js';
import { LynxDatabase } from '../store/database.js';

let tempHome: string;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-metrics-'));
  process.env.LYNX_HOME = tempHome;
  clearSessionDedup();
});

afterEach(() => {
  delete process.env.LYNX_HOME;
  fs.rmSync(tempHome, { recursive: true, force: true });
  clearSessionDedup();
});

describe('usage metrics', () => {
  it('closes the temporary project database used for file-size estimates', () => {
    const db = LynxDatabase.openProject('close-check');
    db.upsertProject('close-check', tempHome);
    db.close();
    const close = vi.spyOn(LynxDatabase.prototype, 'close');

    estimateTokensFromFiles(['missing.ts'], tempHome, 'close-check');

    expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore();
  });

  it('separates conservative savings, exploration potential, and structural confidence', () => {
    const value = layerValueMetrics(
      { estimated_tokens_saved: 1200, estimated_files_avoided: 2, confidence: 'medium' },
      { files: 500, symbols: 8_000 },
      { callers: [{}, {}], relationship_profile: { edge_counts: { CALLS: 2 } } },
    );
    const potential = value.exploration_potential as Record<string, number>;
    const structural = value.structural_confidence as Record<string, unknown>;
    expect(value.estimated_tokens_saved).toBe(1200);
    expect(potential.likely_tokens).toBeGreaterThan(1200);
    expect(potential.maximum_reasonable_tokens).toBeGreaterThan(potential.likely_tokens);
    expect(structural.decision_status).toBe('confirmed');
  });

  it('does not present untraced search results as reinforced graph evidence', () => {
    const value = layerValueMetrics(
      { estimated_tokens_saved: 900, estimated_files_avoided: 0, confidence: 'high', measurement: 'symbol_discovery_context' },
      { files: 500, symbols: 8_000 },
      { results: [{ file: 'src/a.ts' }, { file: 'src/b.ts' }] },
    );
    const structural = value.structural_confidence as Record<string, unknown>;
    const observed = value.observed_savings as Record<string, unknown>;
    expect(value.confidence).toBe('low');
    expect(structural.decision_status).toBe('partial');
    expect(structural.files_affected).toBe(2);
    expect(structural.ambiguities_detected).toContain('limited_structural_evidence');
    expect(observed.basis).toBe('symbol_discovery_context');
  });

  it('estimates savings with confidence', () => {
    expect(estimateTokensSaved({ resultCount: 0, candidateFiles: 10 })).toMatchObject({
      filesAvoided: 0,
      tokensSaved: 0,
    });
    expect(estimateTokensSaved({ resultCount: 2, candidateFiles: 8 })).toMatchObject({
      filesAvoided: 2,
      confidence: 'low',
    });
    expect(estimateTokensSaved({ resultCount: 5, candidateFiles: 40 })).toMatchObject({
      filesAvoided: 5,
      confidence: 'low',
    });
  });

  it('records sanitized events and summarizes by project', () => {
    const value = estimateTokensSaved({ resultCount: 5, candidateFiles: 20 });
    recordUsageEvent({
      type: 'search_graph',
      project: 'demo',
      query: 'email john@example.com +34 666 111 222',
      result_count: 5,
      unique_files: 5,
      files_avoided: value.filesAvoided,
      tokens_saved: value.tokensSaved,
      confidence: value.confidence,
    });

    const raw = fs.readFileSync(usageLogPath(), 'utf-8');
    expect(raw).toContain('[email]');
    expect(raw).toContain('[phone]');
    expect(raw).not.toContain('john@example.com');

    const summary = summarizeUsage('demo');
    expect(summary.events).toBe(1);
    expect(summary.tokens_saved).toBeGreaterThan(0);
    expect(summary.low_confidence_tokens_saved).toBeGreaterThan(0);
    const event = JSON.parse(raw) as { session_id?: string; task_id?: string };
    expect(event.session_id).toBe(defaultUsageContext('demo').session_id);
    expect(event.task_id).toBe(defaultUsageContext('demo').task_id);
  });

  it('exports and clears events', () => {
    recordUsageEvent({ type: 'pack_context', project: 'demo', tokens_saved: 10 });
    recordUsageEvent({ type: 'pack_context', project: 'other', tokens_saved: 20 });

    const exportPath = path.join(tempHome, 'export.json');
    expect(exportUsageEvents(exportPath, 'demo')).toBe(1);
    expect(JSON.parse(fs.readFileSync(exportPath, 'utf-8'))).toHaveLength(1);

    expect(clearUsageEvents('demo')).toBe(1);
    expect(summarizeUsage('demo').events).toBe(0);
    expect(summarizeUsage('other').events).toBe(1);
  });

  it('estimates semantic rerank cost', () => {
    expect(estimateRerankCostUsd(0)).toBeGreaterThanOrEqual(0);
    expect(estimateRerankCostUsd(10)).toBeGreaterThan(estimateRerankCostUsd(1));
  });

  it('scales architecture overview coverage by requested aspects vs total', () => {
    const files = ['missing-a.ts', 'missing-b.ts', 'missing-c.ts', 'missing-d.ts'];
    const full = estimateArchitectureOverviewSavings(files, undefined, undefined, 9);
    const partial = estimateArchitectureOverviewSavings(files, undefined, undefined, 3);
    const single = estimateArchitectureOverviewSavings(files, undefined, undefined, 1);

    // Full overview (9/9 aspects) should save the most
    expect(full.tokensSaved).toBeGreaterThan(partial.tokensSaved);
    // Partial (3/9) should save less than full
    expect(partial.tokensSaved).toBeGreaterThan(single.tokensSaved);
    // Single aspect should still hit the floor (15%), not zero
    expect(single.tokensSaved).toBeGreaterThan(0);
    // Partial should be roughly 1/3 of full (3/9)
    const ratio = partial.tokensSaved / full.tokensSaved;
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(0.4);
  });

  it('estimates architecture orientation from indexed files with full coverage when aspects not specified', () => {
    const files = ['missing-a.ts', 'missing-b.ts', 'missing-c.ts', 'missing-d.ts'];
    const value = estimateArchitectureOverviewSavings(files);

    expect(value.filesAvoided).toBe(4);
    expect(value.tokensSaved).toBeGreaterThan(0);
    expect(value.confidence).toBe('medium');
  });

  it('attributes operational tools from their useful result, proportional to data returned', () => {
    const noResult = estimateToolOperationSavings('find_dead_code', { candidates: [] });
    const candidates = estimateToolOperationSavings('find_dead_code', { candidates: Array(20).fill({}) });
    const failed = estimateToolOperationSavings('find_dead_code', { error: 'not indexed' });

    expect(candidates.tokensSaved).toBeGreaterThan(noResult.tokensSaved);
    expect(candidates.tokensSaved).toBeGreaterThan(8_000);
    expect(candidates.filesAvoided).toBeGreaterThan(0);
    expect(failed.tokensSaved).toBe(0);
  });

  it('uses structured evidence instead of a fixed value for change analysis', () => {
    const small = estimateToolOperationSavings('detect_changes', { category_counts: { total: 1 } });
    const broad = estimateToolOperationSavings('detect_changes', { category_counts: { total: 10 } });
    expect(broad.tokensSaved).toBeGreaterThan(small.tokensSaved);
    expect(broad.tokensSaved).toBeGreaterThan(5_000);
  });

  it('gives legacy zero-value operational events their baseline only', () => {
    const event = attributeLegacyToolObservation({
      ts: '2026-01-01T00:00:00.000Z', type: 'tool_observation', project: 'demo',
      tool_hint: 'index_status', tokens_saved: 0, files_avoided: 0,
    });
    expect(event.tokens_saved).toBe(400);
    expect(event.confidence).toBe('low');
  });
});

describe('session dedup', () => {
  it('counts each independently requested architecture overview', () => {
    const event = {
      type: 'architecture_overview' as const,
      project: 'architecture-dedup',
      files: ['src/a.ts', 'src/b.ts'],
      files_avoided: 2,
      tokens_saved: 1200,
      confidence: 'medium' as const,
      skip_session_dedup: true,
    };
    recordUsageEvent(event);
    recordUsageEvent(event);

    const summary = summarizeUsage('architecture-dedup');
    expect(summary.events).toBe(2);
    expect(summary.tokens_saved).toBe(2400);
  });

  it('deduplicates files across multiple events', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    recordUsageEvent({
      type: 'search_graph',
      project: 'dedup-test',
      files,
      files_avoided: 12,
      tokens_saved: 10_000,
      confidence: 'high',
    });
    recordUsageEvent({
      type: 'pack_context',
      project: 'dedup-test',
      files: ['src/a.ts', 'src/d.ts'],
      files_avoided: 8,
      tokens_saved: 6_000,
      confidence: 'medium',
    });

    const summary = summarizeUsage('dedup-test');
    expect(summary.events).toBe(2);
    // The second event should have reduced files_avoided/tokens_saved
    // because src/a.ts was already seen
    expect(summary.tokens_saved).toBeLessThan(16_000);
  });

  it('does not mutate the caller event during deduplication', () => {
    const event = {
      type: 'search_graph' as const,
      project: 'dedup-immutable',
      files: ['src/a.ts', 'src/b.ts'],
      files_avoided: 8,
      tokens_saved: 6000,
    };

    recordUsageEvent(event);
    recordUsageEvent(event);

    expect(event).toEqual({
      type: 'search_graph',
      project: 'dedup-immutable',
      files: ['src/a.ts', 'src/b.ts'],
      files_avoided: 8,
      tokens_saved: 6000,
    });
  });

  it('unique_files_avoided is less than or equal to files_avoided', () => {
    recordUsageEvent({
      type: 'hook_augment',
      project: 'dedup-test2',
      files: ['src/a.ts', 'src/b.ts'],
      files_avoided: 8,
      tokens_saved: 7_000,
    });
    const summary = summarizeUsage('dedup-test2');
    expect(summary.unique_files_avoided).toBeLessThanOrEqual(summary.files_avoided);
  });
});

describe('semantic ROI', () => {
  it('computes ROI correctly', () => {
    const roi1 = computeSemanticROI(100_000, 0);
    expect(roi1.tokensPerDollar).toBe(Infinity);

    const roi2 = computeSemanticROI(500_000, 0.05);
    expect(roi2.tokensPerDollar).toBeGreaterThan(1_000_000);
    expect(roi2.summary.length).toBeGreaterThan(0);
  });

  it('computes weaker ROI', () => {
    const roi = computeSemanticROI(10_000, 0.05);
    expect(roi.tokensPerDollar).toBe(200_000);
    expect(roi.summary.length).toBeGreaterThan(0);
  });
});

describe('token estimation from files', () => {
  it('estimates from real files when available', () => {
    const tempDir = path.join(tempHome, 'fake-project');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'a.ts'), 'x'.repeat(4000));
    // Actual files may not be there on a clean run, but the fn should not throw
    const result = estimateTokensFromFiles(['src/a.ts'], tempDir);
    expect(result.filesAvoided).toBe(1);
    expect(result.tokensSaved).toBeGreaterThan(0);
    expect(['low', 'medium', 'high']).toContain(result.confidence);
  });
});

describe('log rotation', () => {
  it('does not crash on many events', () => {
    for (let i = 0; i < 20; i++) {
      recordUsageEvent({
        type: 'benchmark',
        project: 'rotation-test',
        tokens_saved: 100,
      });
    }
    const summary = summarizeUsage('rotation-test');
    expect(summary.events).toBe(20);
  });
});
