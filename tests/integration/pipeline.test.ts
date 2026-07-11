import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LynxDatabase } from '../../src/store/database.js';
import { runPipeline } from '../../src/pipeline/orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../fixtures/sample-project');

describe('Pipeline integration', () => {
  let db: LynxDatabase;
  const project = 'test-sample';

  beforeAll(() => {
    db = LynxDatabase.openMemory();
  });

  it('indexes a sample project without errors', async () => {
    const result = await runPipeline(db, FIXTURE, project, { mode: 'fast', testSkipProjectBrief: true });
    expect(result.status.totalNodes).toBeGreaterThan(0);
    expect(result.status.totalEdges).toBeGreaterThan(0);
    expect(result.status.status).toBe('ready');
    expect(result.filesProcessed).toBeGreaterThan(0);
  }, 30000);

  it('produces expected edge types', async () => {
    const edges = db.db.prepare(
      'SELECT DISTINCT type FROM edges WHERE project = ?'
    ).all(project) as Array<{ type: string }>;
    const types = edges.map(e => e.type);
    expect(types).toContain('DEFINES');
    expect(types).toContain('CALLS');
    expect(types).toContain('IMPORTS');
    expect(types).toContain('CONTAINS_FILE');
  });

  it('produces expected node kinds', async () => {
    const nodes = db.db.prepare(
      'SELECT DISTINCT kind FROM nodes WHERE project = ?'
    ).all(project) as Array<{ kind: string }>;
    const kinds = nodes.map(n => n.kind);
    expect(kinds).toContain('Function');
    expect(kinds).toContain('Class');
    expect(kinds).toContain('File');
  });

  it('is idempotent (second run does not change counts)', async () => {
    const countNodes = () => (db.db.prepare(
      'SELECT COUNT(*) as cnt FROM nodes WHERE project = ?'
    ).get(project) as { cnt: number }).cnt;
    const countEdges = () => (db.db.prepare(
      'SELECT COUNT(*) as cnt FROM edges WHERE project = ?'
    ).get(project) as { cnt: number }).cnt;

    const beforeNodes = countNodes();
    const beforeEdges = countEdges();

    await runPipeline(db, FIXTURE, project, { mode: 'fast', testSkipProjectBrief: true });

    const afterNodes = countNodes();
    const afterEdges = countEdges();

    expect(afterNodes).toBe(beforeNodes);
    expect(afterEdges).toBe(beforeEdges);
  }, 30000);
});

describe('incremental pipeline safety', () => {
  function initGit(root: string): void {
    for (const args of [['init'], ['config', 'user.email', 'test@lynx.local'], ['config', 'user.name', 'LYNX Test'], ['add', '.'], ['commit', '-m', 'fixture']]) execFileSync('git', args, { cwd: root });
  }

  it('reindexes a modified file incrementally', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-incremental-'));
    const db = LynxDatabase.openMemory();
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;');
      initGit(root);
      await runPipeline(db, root, 'modified', { mode: 'fast', testSkipProjectBrief: true });
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2; export const b = 3;');
      const result = await runPipeline(db, root, 'modified', { mode: 'fast', incremental: true, incrementalFeatureFlag: true, testSkipProjectBrief: true });
      expect(result.incremental.updateMode).toBe('incremental');
      expect(result.incremental.modified).toEqual(['src/a.ts']);
      expect(result.incremental.reindexed).toEqual(['src/a.ts']);
      expect(result.incremental.health).toBe('healthy');
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }, 30000);

  it('classifies a rename and falls back to the semantic reference rebuild', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-incremental-'));
    const db = LynxDatabase.openMemory();
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;');
      initGit(root);
      await runPipeline(db, root, 'rename', { mode: 'fast', testSkipProjectBrief: true });
      fs.renameSync(path.join(root, 'src', 'a.ts'), path.join(root, 'src', 'renamed.ts'));
      const result = await runPipeline(db, root, 'rename', { mode: 'fast', incremental: true, incrementalFeatureFlag: true, testSkipProjectBrief: true });
      expect(result.incremental.updateMode).toBe('full_fallback');
      expect(result.incremental.renamed).toEqual([{ from: 'src/a.ts', to: 'src/renamed.ts' }]);
      expect(result.incremental.fallbackReason).toContain('deleted_or_renamed');
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }, 30000);

  it('rolls back every persistent mutation after injected write failures', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-incremental-'));
    const db = LynxDatabase.openMemory();
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;');
      initGit(root);
      await runPipeline(db, root, 'rollback', { mode: 'fast', testSkipProjectBrief: true });
      const snapshot = () => db.db.prepare("SELECT (SELECT COUNT(*) FROM nodes WHERE project = ?) AS nodes, (SELECT COUNT(*) FROM edges WHERE project = ?) AS edges, (SELECT COUNT(*) FROM file_hashes WHERE project = ?) AS hashes, (SELECT COUNT(*) FROM findings WHERE project = ?) AS findings, (SELECT COUNT(*) FROM index_runs WHERE project = ?) AS runs").get('rollback', 'rollback', 'rollback', 'rollback', 'rollback') as { nodes: number; edges: number; hashes: number; findings: number; runs: number };
      const before = snapshot();
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2;');
      for (const testFailAt of ['cleanup', 'nodes', 'edges', 'hashes', 'run'] as const) {
        await expect(runPipeline(db, root, 'rollback', { mode: 'fast', incremental: true, incrementalFeatureFlag: true, testFailAt, testSkipProjectBrief: true })).rejects.toThrow(`LYNX_TEST_PIPELINE_FAILURE:${testFailAt}`);
        expect(snapshot()).toEqual(before);
      }
      const recovered = await runPipeline(db, root, 'rollback', { mode: 'fast', incremental: true, incrementalFeatureFlag: true, testSkipProjectBrief: true });
      expect(recovered.incremental.health).toBe('healthy');
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }, 30000);
  it('falls back safely for a deleted file and matches a full rebuild', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-incremental-'));
    const db = LynxDatabase.openMemory();
    let fresh: LynxDatabase | undefined;
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;');
      fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a.js'; export const b = a;");
      for (const args of [
        ['init'], ['config', 'user.email', 'test@lynx.local'], ['config', 'user.name', 'LYNX Test'],
        ['add', '.'], ['commit', '-m', 'fixture']
      ]) execFileSync('git', args, { cwd: root });
      await runPipeline(db, root, 'incremental', { mode: 'fast', testSkipProjectBrief: true });
      fs.unlinkSync(path.join(root, 'src', 'a.ts'));
      const result = await runPipeline(db, root, 'incremental', { mode: 'fast', incremental: true, incrementalFeatureFlag: true, testSkipProjectBrief: true });
      expect(result.incremental.updateMode).toBe('full_fallback');
      expect(result.incremental.deleted).toEqual(['src/a.ts']);
      expect(result.incremental.fallbackReason).toContain('deleted_or_renamed');
      expect((db.db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE project = ? AND file_path = ?').get('incremental', 'src/a.ts') as { count: number }).count).toBe(0);
      fresh = LynxDatabase.openMemory();
      const full = await runPipeline(fresh, root, 'fresh', { mode: 'fast', testSkipProjectBrief: true });
      expect(result.status.totalNodes).toBe(full.status.totalNodes);
      expect(result.status.totalEdges).toBe(full.status.totalEdges);
    } finally {
      fresh?.close();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
