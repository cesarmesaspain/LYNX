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

      const nativeCalls = db.db.prepare(`
        SELECT source.qualified_name AS source, target.qualified_name AS target,
               json_extract(edge.properties, '$.resolution') AS resolution
        FROM edges edge
        JOIN nodes source ON source.id=edge.source_id
        JOIN nodes target ON target.id=edge.target_id
        WHERE edge.project='native-publication' AND edge.type='CALLS'
          AND source.qualified_name IN (
            'widget.ui.measure_widget',
            'widget.ui.measure_pointer',
            'widget.ui.measure_qualified',
            'widget.ui.Widget.size',
            'widget.ui.apply_transform',
            'widget.ui.apply_local_transform'
          )
        ORDER BY source.qualified_name, target.qualified_name
      `).all() as Array<{ source: string; target: string; resolution: string }>;
      expect(nativeCalls).toEqual(expect.arrayContaining([
        {
          source: 'widget.ui.measure_widget',
          target: 'widget.ui.Widget.size',
          resolution: 'receiver_declared_type_member',
        },
        {
          source: 'widget.ui.measure_pointer',
          target: 'widget.ui.Widget.size',
          resolution: 'receiver_declared_type_member',
        },
        {
          source: 'widget.ui.measure_qualified',
          target: 'widget.ui.label',
          resolution: 'qualified_name_suffix_exact',
        },
        {
          source: 'widget.ui.Widget.size',
          target: 'widget.ui.label',
          resolution: 'same_file_direct_unique',
        },
        {
          source: 'widget.ui.apply_transform',
          target: 'widget.ui.apply_transform.operation',
          resolution: 'lexical_function_pointer_invocation',
        },
        {
          source: 'widget.ui.apply_local_transform',
          target: 'widget.ui.apply_local_transform.callback',
          resolution: 'lexical_function_pointer_invocation',
        },
      ]));
      expect(nativeCalls).not.toContainEqual(expect.objectContaining({
        source: 'widget.ui.apply_transform',
        target: 'widget.ui.operation',
      }));
      expect(nativeCalls).not.toContainEqual(expect.objectContaining({
        source: 'widget.ui.apply_local_transform',
        target: 'widget.ui.operation',
      }));
      const leakedCrossScopeValue = db.db.prepare(`
        SELECT 1
        FROM edges edge
        JOIN nodes source ON source.id=edge.source_id
        JOIN nodes target ON target.id=edge.target_id
        WHERE edge.project='native-publication'
          AND source.qualified_name='widget.ui.apply_local_transform'
          AND target.qualified_name='widget.ui.apply_transform.operation'
      `).get();
      expect(leakedCrossScopeValue).toBeUndefined();
      const shadowedCalls = db.db.prepare(`
        SELECT target.qualified_name AS target,
               json_extract(edge.properties, '$.line') AS call_line,
               target.start_line AS declaration_line
        FROM edges edge
        JOIN nodes source ON source.id=edge.source_id
        JOIN nodes target ON target.id=edge.target_id
        WHERE edge.project='native-publication' AND edge.type='CALLS'
          AND source.qualified_name='widget.ui.apply_shadowed_transform'
          AND json_extract(edge.properties, '$.resolution')='lexical_function_pointer_invocation'
        ORDER BY call_line
      `).all() as Array<{ target: string; call_line: number; declaration_line: number }>;
      expect(shadowedCalls).toHaveLength(3);
      expect(shadowedCalls[0]!.target).toBe('widget.ui.apply_shadowed_transform.callback');
      expect(shadowedCalls[1]!.target).toMatch(/^widget\.ui\.apply_shadowed_transform\.callback\.__variant\.L\d+$/);
      expect(shadowedCalls[2]!.target).toBe('widget.ui.apply_shadowed_transform.callback');
      expect(shadowedCalls[1]!.declaration_line).toBeGreaterThan(shadowedCalls[0]!.declaration_line);
      const controlScopeCalls = db.db.prepare(`
        SELECT target.qualified_name AS target,
               json_extract(edge.properties, '$.line') AS call_line
        FROM edges edge
        JOIN nodes source ON source.id=edge.source_id
        JOIN nodes target ON target.id=edge.target_id
        WHERE edge.project='native-publication' AND edge.type='CALLS'
          AND source.qualified_name='widget.ui.apply_for_shadowed_transform'
          AND json_extract(edge.properties, '$.resolution')='lexical_function_pointer_invocation'
        ORDER BY call_line
      `).all() as Array<{ target: string; call_line: number }>;
      expect(controlScopeCalls).toHaveLength(2);
      expect(controlScopeCalls[0]!.target).toMatch(/\.__variant\.L\d+$/);
      expect(controlScopeCalls[1]!.target).toBe('widget.ui.apply_for_shadowed_transform.callback');
      expect(nativeCalls).not.toContainEqual(expect.objectContaining({
        source: 'widget.ui.Widget.size',
        target: 'widget.ui.Widget.size',
      }));
      const nestedCallEvidence = db.db.prepare(`
        SELECT json_extract(edge.properties, '$.column') AS column_number
        FROM edges edge
        JOIN nodes source ON source.id=edge.source_id
        JOIN nodes target ON target.id=edge.target_id
        WHERE edge.project='native-publication' AND edge.type='CALLS'
          AND source.qualified_name='widget.ui.Widget.size'
          AND target.qualified_name='widget.ui.label'
      `).get() as { column_number: number } | undefined;
      expect(nestedCallEvidence?.column_number).toBe(51);

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
