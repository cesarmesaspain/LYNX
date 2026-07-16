import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../../src/pipeline/orchestrator.js';
import { LynxDatabase } from '../../src/store/database.js';

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/native-core');
const nativeCore = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../native/lynx_native_core');

describe.skipIf(!fs.existsSync(nativeCore))('native structural core publication', () => {
  it('publishes validated native C/C++ nodes, relationships, and evidence into the canonical graph', async () => {
    const db = LynxDatabase.openMemory();
    const previousPath = process.env.LYNX_NATIVE_CORE_PATH;
    process.env.LYNX_NATIVE_CORE_PATH = nativeCore;
    try {
      const result = await runPipeline(db, fixture, 'native-publication', {
        mode: 'full',
        testSkipProjectBrief: true,
      });
      const edge = db.db.prepare(`
        SELECT e.type, e.properties
        FROM edges e
        JOIN nodes source ON source.id=e.source_id
        JOIN nodes target ON target.id=e.target_id
        WHERE e.project='native-publication'
          AND source.qualified_name='math.main'
          AND target.qualified_name='math.add_numbers'
          AND e.type='CALLS'
      `).get() as { type: string; properties: string } | undefined;

      expect(result.status.status).toBe('ready');
      expect(result.coverage.partial_files.length).toBeGreaterThan(0);
      const macro = db.db.prepare("SELECT kind, properties FROM nodes WHERE project='native-publication' AND qualified_name='include.math.__header.__macro.MATH_LIMIT.L3'").get() as { kind: string; properties: string } | undefined;
      expect(macro?.kind).toBe('Macro');
      expect(JSON.parse(macro!.properties)).toEqual({});
      expect(edge?.type).toBe('CALLS');
      expect(JSON.parse(edge!.properties)).toMatchObject({
        extractor: 'lynx-native-core',
        resolution: 'same_file_direct_unique',
        confidence: 1,
      });
      const evidenceCount = db.db.prepare(`
        SELECT COUNT(*) AS count FROM edge_evidence evidence
        JOIN edges edge ON edge.id=evidence.edge_id
        WHERE edge.project='native-publication' AND evidence.source_kind='same_file_direct_unique'
      `).get() as { count: number };
      expect(evidenceCount.count).toBeGreaterThan(0);

      const before = db.db.prepare("SELECT COUNT(*) AS nodes, (SELECT COUNT(*) FROM edges WHERE project='native-publication') AS edges FROM nodes WHERE project='native-publication'")
        .get();
      await expect(runPipeline(db, fixture, 'native-publication', {
        mode: 'full', testSkipProjectBrief: true, testFailAt: 'edges',
      })).rejects.toThrow('LYNX_TEST_PIPELINE_FAILURE:edges');
      const after = db.db.prepare("SELECT COUNT(*) AS nodes, (SELECT COUNT(*) FROM edges WHERE project='native-publication') AS edges FROM nodes WHERE project='native-publication'")
        .get();
      expect(after).toEqual(before);
    } finally {
      if (previousPath === undefined) delete process.env.LYNX_NATIVE_CORE_PATH;
      else process.env.LYNX_NATIVE_CORE_PATH = previousPath;
      db.close();
    }
  }, 30_000);
});
