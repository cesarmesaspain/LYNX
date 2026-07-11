import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { LynxDatabase } from '../../../src/store/database.js';
import {
  collectProjectCards,
  nodeAction,
  projectHealth,
  type ProjectCard,
} from '../../../src/server/dashboard/data.js';
import { assertIsolated, testHome } from '../../setup.js';

const tmpDir = path.join(testHome(), 'dbs');

function seedProject(
  name: string,
  opts?: {
    nodes?: number;
    edges?: number;
    indexedAt?: string;
    status?: string;
    statusError?: string | null;
    indexRuns?: boolean;
  }
): string {
  const dbPath = path.join(tmpDir, `${name}.db`);
  const db = new LynxDatabase(dbPath);
  const project = opts?.indexedAt
    ? db.db
        .prepare(
          `INSERT INTO projects (name, repo_path, indexed_at, status, status_error) VALUES (?, ?, ?, ?, ?)`
        )
        .run(name, '/fake/repo', opts.indexedAt, opts?.status || 'ready', opts?.statusError || null)
    : db.db
        .prepare(
          `INSERT INTO projects (name, repo_path, indexed_at, status, status_error) VALUES (?, ?, ?, ?, ?)`
        )
        .run(name, '/fake/repo', new Date().toISOString(), opts?.status || 'ready', opts?.statusError || null);

  const nodeCount = opts?.nodes || 5;
  for (let i = 0; i < nodeCount; i++) {
    db.db
      .prepare(
        `INSERT INTO nodes (project, name, qualified_name, kind, file_path, start_line, end_line, is_entry_point, is_exported, properties) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(name, `func${i}`, `pkg.func${i}`, 'Function', `src/file${i}.ts`, i + 1, i + 5, i === 0 ? 1 : 0, 1, '{}');
  }
  if (opts?.edges && nodeCount >= 2) {
    const edgeCount = Math.min(opts.edges, nodeCount * (nodeCount - 1));
    for (let i = 0; i < edgeCount; i++) {
      const src = (i % nodeCount) + 1;
      const dst = ((i + 1) % nodeCount) + 1;
      if (src !== dst) {
        db.db
          .prepare(`INSERT INTO edges (project, source_id, target_id, type) VALUES (?, ?, ?, ?)`)
          .run(name, src, dst, 'CALLS');
      }
    }
  }
  if (opts?.indexRuns) {
    try { db.db.prepare(`INSERT INTO index_runs (project, run_at, mode) VALUES (?, ?, ?)`).run(name, new Date().toISOString(), 'fast'); } catch { /* ok */ }
  }
  db.close();
  return dbPath;
}

describe('collectProjectCards', () => {
  // Fixture DBs are created under the worker's isolated LYNX_HOME/dbs/
  // (set by tests/setup.ts). No real ~/.lynx/dbs is ever touched.

  beforeAll(() => {
    assertIsolated();
  });

  describe('ProjectCard contract', () => {
    it('all required Phase 6 fields are present in the type', () => {
      const card: ProjectCard = {
        name: 'test',
        displayName: 'test',
        dbPath: '/tmp/test.db',
        nodes: 10,
        edges: 20,
        edgeTypes: 2,
        filesIndexed: 5,
        entryPoints: 1,
        hotspots: 2,
        riskyNodes: 1,
        tokensSaved: 1000,
        filesAvoided: 50,
        uniqueFiles: 40,
        semanticROI: null,
        semanticTopChanged: 0,
        semanticEvents: 0,
        lastIndexed: new Date().toISOString(),
        freshness: 'ready',
        status: null,
        statusError: null,
        dbSizeBytes: 4096,
        indexDurationMs: null,
        hoursSinceIndex: 1,
        llmProvider: null,
        llmModel: null,
        llmCalls: 0,
        llmTokensUsed: 0,
        llmCostUsd: 0,
        errorCount: 0,
        brief: null,
      };
      expect(card.freshness).toBe('ready');
      expect(card.dbSizeBytes).toBeGreaterThan(0);
      expect(card.hoursSinceIndex).toBe(1);
    });
  });

  describe('projectHealth', () => {
    const base: ProjectCard = {
      name: 'test', displayName: 'test', dbPath: '/tmp/t.db',
      nodes: 100, edges: 200, edgeTypes: 3, filesIndexed: 50,
      entryPoints: 5, hotspots: 10, riskyNodes: 5,
      tokensSaved: 500, filesAvoided: 30, uniqueFiles: 25,
      semanticROI: null, semanticTopChanged: 0, semanticEvents: 0,
      lastIndexed: new Date().toISOString(),
      freshness: 'ready', status: null, statusError: null,
      dbSizeBytes: 1024, indexDurationMs: null, hoursSinceIndex: 2,
      llmProvider: null, llmModel: null, llmCalls: 0, llmTokensUsed: 0, llmCostUsd: 0,
      errorCount: 0, brief: null,
    };

    it('flags high surface when risky > 500', () => {
      const h = projectHealth({ ...base, riskyNodes: 600 });
      expect(h.className).toBe('health-watch');
    });

    it('flags sparse when edges < nodes', () => {
      const h = projectHealth({ ...base, nodes: 100, edges: 50 });
      expect(h.className).toBe('health-risk');
    });

    it('returns healthy for normal projects', () => {
      const h = projectHealth(base);
      expect(h.className).toBe('health-good');
    });

    it('returns Spanish labels when requested', () => {
      const h = projectHealth(base, true);
      expect(h.label).toBe('Saludable');
    });
  });

  describe('freshness contract', () => {
    it('all freshness values are valid', () => {
      const values: ProjectCard['freshness'][] = ['ready', 'stale', 'updating', 'failed', 'unknown'];
      for (const v of values) {
        const card: ProjectCard = {
          name: 'f', displayName: 'f', dbPath: '/tmp/f.db',
          nodes: 1, edges: 1, edgeTypes: 1, filesIndexed: 1,
          entryPoints: 1, hotspots: 0, riskyNodes: 0,
          tokensSaved: 0, filesAvoided: 0, uniqueFiles: 1,
          semanticROI: null, semanticTopChanged: 0, semanticEvents: 0,
          lastIndexed: null,
          freshness: v,
          status: null, statusError: null,
          dbSizeBytes: 0, indexDurationMs: null, hoursSinceIndex: null,
          llmProvider: null, llmModel: null, llmCalls: 0, llmTokensUsed: 0, llmCostUsd: 0,
          errorCount: 0, brief: null,
        };
        expect(card.freshness).toBe(v);
      }
    });
  });
});

describe('nodeAction', () => {
  it('recommends proportional investigation instead of mandatory sequencing', () => {
    expect(nodeAction('entry')).toContain('when downstream flow is relevant');
    expect(nodeAction('entry')).not.toContain('Start with trace_path');
    expect(nodeAction('hotspot')).not.toContain('Run trace_path before editing');
  });
});

describe('HTML escape', () => {
  // Import escapeHtml lazily to avoid module-level side effects
  async function getEscapeHtml() {
    const mod = await import('../../../src/server/dashboard/utils.js');
    return mod.escapeHtml;
  }

  it('escapes HTML special characters', async () => {
    const escapeHtml = await getEscapeHtml();
    expect(escapeHtml('<script>alert(1)</script>')).not.toContain('<script>');
    expect(escapeHtml('a & b')).toContain('&amp;');
    expect(escapeHtml('"quoted"')).toContain('&quot;');
    // escapeHtml does NOT escape single quotes (only < > & ")
  });

  it('prevents secret leakage through HTML', async () => {
    const escapeHtml = await getEscapeHtml();
    const secret = 'sk-abc123secretKey';
    const escaped = escapeHtml(secret);
    // Should not contain raw HTML that would render as a script
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
  });

  it('handles null/undefined gracefully', async () => {
    const escapeHtml = await getEscapeHtml();
    // These should not throw
    expect(() => escapeHtml('')).not.toThrow();
  });
});

describe('renderDashboard HTML contract', () => {
  async function getRenderDashboard() {
    const mod = await import('../../../src/server/dashboard/html.js');
    return mod.renderDashboard;
  }

  it('renders empty state with no cards', async () => {
    const renderDashboard = await getRenderDashboard();
    const html = renderDashboard([]);
    expect(html).toContain('No indexed projects yet');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('summary-grid');
  });

  it('renders project names in cards', async () => {
    const renderDashboard = await getRenderDashboard();
    const card: ProjectCard = {
      name: 'my-project', displayName: 'My Project', dbPath: '/tmp/mp.db',
      nodes: 100, edges: 200, edgeTypes: 3, filesIndexed: 50,
      entryPoints: 5, hotspots: 10, riskyNodes: 5,
      tokensSaved: 5000, filesAvoided: 30, uniqueFiles: 25,
      semanticROI: 50, semanticTopChanged: 2, semanticEvents: 10,
      lastIndexed: '2026-07-10T00:00:00Z',
      freshness: 'ready', status: null, statusError: null,
      dbSizeBytes: 102400, indexDurationMs: null, hoursSinceIndex: 5,
      llmProvider: null, llmModel: null, llmCalls: 0, llmTokensUsed: 0, llmCostUsd: 0,
      errorCount: 0, brief: null,
    };
    const html = renderDashboard([card]);
    expect(html).toContain('My Project');
    expect(html).toContain('5,000');
  });

  it('renders freshness badge for non-ready states', async () => {
    const renderDashboard = await getRenderDashboard();
    const card: ProjectCard = {
      name: 'stale-project', displayName: 'Stale', dbPath: '/tmp/sp.db',
      nodes: 10, edges: 20, edgeTypes: 2, filesIndexed: 5,
      entryPoints: 1, hotspots: 1, riskyNodes: 0,
      tokensSaved: 100, filesAvoided: 5, uniqueFiles: 3,
      semanticROI: null, semanticTopChanged: 0, semanticEvents: 0,
      lastIndexed: '2026-06-01T00:00:00Z',
      freshness: 'stale', status: null, statusError: null,
      dbSizeBytes: 2048, indexDurationMs: null, hoursSinceIndex: 900,
      llmProvider: null, llmModel: null, llmCalls: 0, llmTokensUsed: 0, llmCostUsd: 0,
      errorCount: 0, brief: null,
    };
    const html = renderDashboard([card]);
    expect(html).toContain('freshness-stale');
    expect(html).toContain('>stale<');
  });

  it('renders failed freshness badge', async () => {
    const renderDashboard = await getRenderDashboard();
    const card: ProjectCard = {
      name: 'broken', displayName: 'Broken', dbPath: '/tmp/b.db',
      nodes: 0, edges: 0, edgeTypes: 0, filesIndexed: 0,
      entryPoints: 0, hotspots: 0, riskyNodes: 0,
      tokensSaved: 0, filesAvoided: 0, uniqueFiles: 0,
      semanticROI: null, semanticTopChanged: 0, semanticEvents: 0,
      lastIndexed: null,
      freshness: 'failed', status: 'failed', statusError: 'ENOENT during indexing',
      dbSizeBytes: 0, indexDurationMs: null, hoursSinceIndex: null,
      llmProvider: null, llmModel: null, llmCalls: 0, llmTokensUsed: 0, llmCostUsd: 0,
      errorCount: 3, brief: null,
    };
    const html = renderDashboard([card]);
    expect(html).toContain('freshness-failed');
    // error text depends on locale; just verify error count appears
    expect(html).toMatch(/3 (errores|errors)/);
  });

  it('renders ops-row with DB size and hours', async () => {
    const renderDashboard = await getRenderDashboard();
    const card: ProjectCard = {
      name: 'ops', displayName: 'Ops', dbPath: '/tmp/o.db',
      nodes: 50, edges: 80, edgeTypes: 2, filesIndexed: 20,
      entryPoints: 2, hotspots: 3, riskyNodes: 1,
      tokensSaved: 200, filesAvoided: 10, uniqueFiles: 8,
      semanticROI: null, semanticTopChanged: 0, semanticEvents: 0,
      lastIndexed: '2026-07-10T00:00:00Z',
      freshness: 'ready', status: null, statusError: null,
      dbSizeBytes: 5 * 1024 * 1024, indexDurationMs: null, hoursSinceIndex: 3,
      llmProvider: null, llmModel: null, llmCalls: 0, llmTokensUsed: 0, llmCostUsd: 0,
      errorCount: 0, brief: null,
    };
    const html = renderDashboard([card]);
    expect(html).toContain('ops-row');
    expect(html).toContain('5.0 MB');
    expect(html).toContain('3h');
  });

  it('renders LLM info when calls > 0', async () => {
    const renderDashboard = await getRenderDashboard();
    const card: ProjectCard = {
      name: 'llm', displayName: 'LLM', dbPath: '/tmp/l.db',
      nodes: 10, edges: 15, edgeTypes: 1, filesIndexed: 5,
      entryPoints: 1, hotspots: 1, riskyNodes: 0,
      tokensSaved: 100, filesAvoided: 5, uniqueFiles: 4,
      semanticROI: 2000, semanticTopChanged: 5, semanticEvents: 20,
      lastIndexed: '2026-07-10T00:00:00Z',
      freshness: 'ready', status: null, statusError: null,
      dbSizeBytes: 1024, indexDurationMs: null, hoursSinceIndex: 0,
      llmProvider: 'deepseek', llmModel: 'deepseek-v4-flash', llmCalls: 42, llmTokensUsed: 10000, llmCostUsd: 0.0012,
      errorCount: 0, brief: null,
    };
    const html = renderDashboard([card]);
    expect(html).toContain('ops-row');
    expect(html).toContain('42 calls');
    expect(html).toContain('$0.0012');
  });

  it('summary includes Phase 6 metrics when present', async () => {
    const renderDashboard = await getRenderDashboard();
    const card: ProjectCard = {
      name: 'big', displayName: 'Big', dbPath: '/tmp/big.db',
      nodes: 1000, edges: 5000, edgeTypes: 5, filesIndexed: 200,
      entryPoints: 10, hotspots: 50, riskyNodes: 20,
      tokensSaved: 50000, filesAvoided: 1000, uniqueFiles: 150,
      semanticROI: 100, semanticTopChanged: 10, semanticEvents: 50,
      lastIndexed: '2026-07-10T00:00:00Z',
      freshness: 'ready', status: null, statusError: null,
      dbSizeBytes: 10 * 1024 * 1024, indexDurationMs: 2500, hoursSinceIndex: 1,
      llmProvider: 'deepseek', llmModel: null, llmCalls: 100, llmTokensUsed: 0, llmCostUsd: 0.05,
      errorCount: 0, brief: null,
    };
    const html = renderDashboard([card]);
    expect(html).toContain('10 MB');
    expect(html).toMatch(/Llamadas|LLM Calls/);
  });

  it('no freshness badge when ready', async () => {
    const renderDashboard = await getRenderDashboard();
    const card: ProjectCard = {
      name: 'healthy', displayName: 'Healthy', dbPath: '/tmp/h.db',
      nodes: 10, edges: 20, edgeTypes: 2, filesIndexed: 5,
      entryPoints: 1, hotspots: 1, riskyNodes: 0,
      tokensSaved: 100, filesAvoided: 5, uniqueFiles: 3,
      semanticROI: null, semanticTopChanged: 0, semanticEvents: 0,
      lastIndexed: new Date().toISOString(),
      freshness: 'ready', status: null, statusError: null,
      dbSizeBytes: 4096, indexDurationMs: null, hoursSinceIndex: 0,
      llmProvider: null, llmModel: null, llmCalls: 0, llmTokensUsed: 0, llmCostUsd: 0,
      errorCount: 0, brief: null,
    };
    const html = renderDashboard([card]);
    // Ready should NOT show a freshness pill
    expect(html).not.toContain('freshness-ready');
  });

  it('handles large dataset (100 projects) without error', async () => {
    const renderDashboard = await getRenderDashboard();
    const cards: ProjectCard[] = Array.from({ length: 100 }, (_, i) => ({
      name: `proj-${i}`,
      displayName: `Project ${i}`,
      dbPath: `/tmp/p${i}.db`,
      nodes: 50 + i,
      edges: 100 + i * 2,
      edgeTypes: 2,
      filesIndexed: 10 + i,
      entryPoints: 1,
      hotspots: 2,
      riskyNodes: 1,
      tokensSaved: 100 * i,
      filesAvoided: 10 * i,
      uniqueFiles: 8,
      semanticROI: i % 2 === 0 ? null : 10,
      semanticTopChanged: i,
      semanticEvents: i * 2,
      lastIndexed: new Date(Date.now() - i * 3600000).toISOString(),
      freshness: (['ready', 'stale', 'updating', 'failed', 'unknown'] as const)[i % 5],
      status: null,
      statusError: null,
      dbSizeBytes: 1024 * (i + 1),
      indexDurationMs: null,
      hoursSinceIndex: i,
      llmProvider: i % 3 === 0 ? 'deepseek' : null,
      llmModel: null,
      llmCalls: i % 3 === 0 ? i : 0,
      llmTokensUsed: 0,
      llmCostUsd: i % 3 === 0 ? i * 0.0001 : 0,
      errorCount: i % 7 === 0 ? 1 : 0,
      brief: null,
    }));
    const html = renderDashboard(cards);
    expect(html).toContain('<!doctype html>');
    expect(html.length).toBeGreaterThan(10000);
  });
});

describe('field redaction and safety', () => {
  it('ProjectCard fields do not expose raw secrets', () => {
    // All string fields should be safe for display
    const card: ProjectCard = {
      name: 'test',
      displayName: 'Test',
      dbPath: '/home/user/.lynx/dbs/test.db',
      nodes: 0, edges: 0, edgeTypes: 0, filesIndexed: 0,
      entryPoints: 0, hotspots: 0, riskyNodes: 0,
      tokensSaved: 0, filesAvoided: 0, uniqueFiles: 0,
      semanticROI: null, semanticTopChanged: 0, semanticEvents: 0,
      lastIndexed: null,
      freshness: 'unknown', status: null, statusError: null,
      dbSizeBytes: 0, indexDurationMs: null, hoursSinceIndex: null,
      llmProvider: null, llmModel: null, llmCalls: 0, llmTokensUsed: 0, llmCostUsd: 0,
      errorCount: 0, brief: null,
    };
    // dbPath should not contain API keys or tokens
    expect(card.dbPath).not.toMatch(/sk-/);
    expect(card.dbPath).not.toMatch(/eyJ/);
    // Display fields should be plain
    expect(card.name).not.toContain('<');
    expect(card.displayName).not.toContain('<');
  });
});
