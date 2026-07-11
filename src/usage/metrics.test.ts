import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSessionDedup,
  clearUsageEvents,
  computeSemanticROI,
  estimateRerankCostUsd,
  estimateTokensFromFiles,
  estimateTokensSaved,
  exportUsageEvents,
  recordUsageEvent,
  summarizeUsage,
  usageLogPath,
} from './metrics.js';

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
  it('estimates savings with confidence', () => {
    expect(estimateTokensSaved(0, 10)).toEqual({
      filesAvoided: 0,
      tokensSaved: 0,
      confidence: 'low',
    });
    expect(estimateTokensSaved(2, 8)).toMatchObject({
      filesAvoided: 8,
      confidence: 'medium',
    });
    expect(estimateTokensSaved(5, 40)).toMatchObject({
      filesAvoided: 20,
      confidence: 'high',
    });
  });

  it('records sanitized events and summarizes by project', () => {
    const value = estimateTokensSaved(5, 20);
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
    expect(summary.high_confidence_tokens_saved).toBeGreaterThan(0);
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
});

describe('session dedup', () => {
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
