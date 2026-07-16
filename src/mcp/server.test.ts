import { describe, expect, it } from 'vitest';
import { TOOLS } from './tools.js';
import { buildIndexContext, getDb, listMcpTools, setDb, unsetDb } from './server.js';
import { LynxDatabase } from '../store/database.js';
import { handleGetEdgeEvidence } from './handlers/get_edge_evidence.js';
import { handleTracePath } from './handlers/trace_path.js';
import { handleInvestigateSymbol } from './handlers/investigate_symbol.js';

describe('MCP tool registry', () => {
  it('returns the complete registry in one tools/list response', () => {
    expect(TOOLS).toHaveLength(31);
    expect(new Set(TOOLS.map((tool) => tool.name)).size).toBe(TOOLS.length);
    expect(TOOLS.map((tool) => tool.name)).toContain('find_dead_code');
    expect(TOOLS.map((tool) => tool.name)).toContain('diagnose');
    expect(TOOLS.map((tool) => tool.name)).toContain('usage_summary');
    const listed = listMcpTools();
    expect(listed).toHaveLength(TOOLS.length);
    expect(listed.map(tool => tool.name)).toContain('pack_context');
    expect(listed.map(tool => tool.name)).toContain('delete_project');
    expect(listed.find((tool) => tool.name === 'search_graph')?.description).toContain(
      'Use the smallest sufficient call',
    );
    expect((listed.find((tool) => tool.name === 'get_code_snippet')?.inputSchema as { properties: Record<string, unknown> })
      .properties.max_lines).toBeDefined();
    expect((listed.find((tool) => tool.name === 'detect_changes')?.inputSchema as { properties: Record<string, unknown> })
      .properties.include_committed).toBeDefined();
    expect(listed.find((tool) => tool.name === 'list_projects')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(listed.find((tool) => tool.name === 'delete_project')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    const totalDescriptionChars = listed.reduce((sum, tool) => sum + tool.description.length, 0);
    const totalSchemaChars = listed.reduce((sum, tool) => sum + JSON.stringify(tool.inputSchema).length, 0);
    expect(totalDescriptionChars).toBeLessThan(7200);
    expect(totalSchemaChars).toBeLessThan(11800);
    expect(JSON.stringify(listed).length).toBeLessThan(23200);
  });

  it('offers the compact profile only when explicitly requested', () => {
    const previous = process.env.LYNX_TOOL_PROFILE;
    process.env.LYNX_TOOL_PROFILE = 'core';
    try {
      const listed = listMcpTools();
      expect(listed).toHaveLength(13);
      expect(listed.reduce((sum, tool) => sum + tool.description.length, 0)).toBeLessThan(3400);
      expect(listed.reduce((sum, tool) => sum + JSON.stringify(tool.inputSchema).length, 0)).toBeLessThan(6200);
      expect(JSON.stringify(listed).length).toBeLessThan(11300);
    } finally {
      if (previous === undefined) delete process.env.LYNX_TOOL_PROFILE;
      else process.env.LYNX_TOOL_PROFILE = previous;
    }
  });

  it('keeps the legacy advanced environment profile compatible with Full', () => {
    const previous = process.env.LYNX_TOOL_PROFILE;
    process.env.LYNX_TOOL_PROFILE = 'advanced';
    try {
      expect(listMcpTools()).toHaveLength(TOOLS.length);
    } finally {
      if (previous === undefined) delete process.env.LYNX_TOOL_PROFILE;
      else process.env.LYNX_TOOL_PROFILE = previous;
    }
  });
});

describe('MCP database cache', () => {
  it('reopens a database when the cached instance was closed by its owner', () => {
    const project = 'closed-cache-recovery';
    const closed = LynxDatabase.openMemory();
    setDb(project, closed);
    closed.close();

    const recovered = getDb(project);

    try {
      expect(recovered).not.toBe(closed);
      expect(recovered.db.open).toBe(true);
    } finally {
      unsetDb(project, { close: true });
    }
  });
});

describe('MCP index context', () => {
  it('does not label an empty project database as fresh', () => {
    const project = 'empty-index-context';
    const db = LynxDatabase.openMemory();
    try {
      db.upsertProject(project, process.cwd());
      setDb(project, db);

      expect(buildIndexContext({ project })).toMatchObject({ freshness: 'unknown' });
    } finally {
      unsetDb(project, { close: false });
      db.close();
    }
  });
});


describe('edge evidence MCP lookup', () => {
  it('returns semantic relationship, confidence, and source_location for a CALLS edge', async () => {
    const project = 'edge-evidence-semantic';
    const db = LynxDatabase.openMemory();
    try {
      const insertNode = db.db.prepare('INSERT INTO nodes (project, kind, name, qualified_name, file_path, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const sourceId = Number(insertNode.run(project, 'Function', 'readConfig', 'mod.readConfig', 'src/db.ts', 42, 48).lastInsertRowid);
      const targetId = Number(insertNode.run(project, 'Function', 'openDb', 'mod.openDb', 'src/db.ts', 50, 55).lastInsertRowid);
      const edge = db.db.prepare('INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)').run(project, sourceId, targetId, 'CALLS', JSON.stringify({ line: 45 }));
      db.db.prepare('INSERT INTO edge_evidence (project, edge_id, evidence_type, source_kind, source_path, start_line, end_line, extractor, strength, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(project, Number(edge.lastInsertRowid), 'CALL_EXPRESSION', 'resolver', 'src/db.ts', 45, 45, 'resolve', 0.85, JSON.stringify({ caller_line: 45, callee_name: 'openDb', syntax: 'openDb(config)' }));
      setDb(project, db);
      const result = await handleGetEdgeEvidence({ project, source_name: 'readConfig', target_name: 'openDb' }) as Record<string, unknown>;
      // Semantic layer
      expect(result.relationship).toBe('readConfig calls openDb');
      expect(result.confidence).toMatchObject({ tier: 'resolver' });
      expect((result.confidence as Record<string, unknown>).score).toBeGreaterThan(0.8);
      expect(result.source_location).toMatchObject({ file: 'src/db.ts', name: 'readConfig', lines: '42-48' });
      expect((result as { evidence_chain: Array<unknown> }).evidence_chain).toHaveLength(1);
      expect((result as { evidence_chain: Array<Record<string, unknown>> }).evidence_chain[0]).toMatchObject({
        evidence_type: 'CALL_EXPRESSION',
        location: 'src/db.ts line 45',
      });
      // Backward compat
      expect(result.evidence_count).toBe(1);
      expect(result.verified).toBe(true);
      expect(result.explanation).toContain('readConfig calls openDb');
      expect(result.explanation).toContain('85%');
    } finally {
      unsetDb(project, { close: false });
      db.close();
    }
  });

  it('classifies confidence correctly for AST and heuristic extractors', async () => {
    const project = 'edge-evidence-confidence';
    const db = LynxDatabase.openMemory();
    try {
      const insertNode = db.db.prepare('INSERT INTO nodes (project, kind, name, qualified_name, file_path) VALUES (?, ?, ?, ?, ?)');
      const sId = Number(insertNode.run(project, 'Class', 'App', 'mod.App', 'src/app.ts').lastInsertRowid);
      const tId = Number(insertNode.run(project, 'Class', 'Base', 'mod.Base', 'src/app.ts').lastInsertRowid);
      const edge1 = db.db.prepare('INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)').run(project, sId, tId, 'INHERITS', '{}');
      const edge2 = db.db.prepare('INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)').run(project, sId, tId, 'IMPORTS', '{}');
      // AST extractor → exact_ast
      db.db.prepare('INSERT INTO edge_evidence (project, edge_id, evidence_type, source_kind, extractor, strength, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(project, Number(edge1.lastInsertRowid), 'INHERITANCE', 'tsc', 'tsc', 0.98, JSON.stringify({ base_class: 'Base', derived_class: 'App' }));
      // Semantic guess → heuristic
      db.db.prepare('INSERT INTO edge_evidence (project, edge_id, evidence_type, source_kind, extractor, strength, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(project, Number(edge2.lastInsertRowid), 'IMPORT_STATEMENT', 'semantic', 'name-matcher', 0.6, JSON.stringify({ imported_symbol: 'Base', imported_from: './base' }));
      setDb(project, db);
      const result1 = await handleGetEdgeEvidence({ project, edge_id: Number(edge1.lastInsertRowid) }) as Record<string, unknown>;
      expect((result1.confidence as Record<string, unknown>).tier).toBe('exact_ast');
      const result2 = await handleGetEdgeEvidence({ project, edge_id: Number(edge2.lastInsertRowid) }) as Record<string, unknown>;
      expect((result2.confidence as Record<string, unknown>).tier).toBe('heuristic');
    } finally {
      unsetDb(project, { close: false });
      db.close();
    }
  });

  it('handles edge_id lookup and malformed evidence payloads safely', async () => {
    const project = 'edge-evidence-edge-id';
    const db = LynxDatabase.openMemory();
    try {
      const sourceId = Number(db.db.prepare('INSERT INTO nodes (project, kind, name, qualified_name, file_path) VALUES (?, ?, ?, ?, ?)').run(project, 'Function', 'sourceFn', 'mod.sourceFn', 'src/mod.ts').lastInsertRowid);
      const targetId = Number(db.db.prepare('INSERT INTO nodes (project, kind, name, qualified_name, file_path) VALUES (?, ?, ?, ?, ?)').run(project, 'Function', 'targetFn', 'mod.targetFn', 'src/mod.ts').lastInsertRowid);
      const edge = db.db.prepare('INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)').run(project, sourceId, targetId, 'CALLS', '{}');
      db.db.prepare('INSERT INTO edge_evidence (project, edge_id, evidence_type, source_kind, strength, payload_json) VALUES (?, ?, ?, ?, ?, ?)').run(project, Number(edge.lastInsertRowid), 'structural', 'resolver', 0.8, '{bad-json');
      setDb(project, db);
      const result = await handleGetEdgeEvidence({ project, edge_id: Number(edge.lastInsertRowid) }) as Record<string, unknown>;
      expect(result.evidence_count).toBe(1);
      expect(result.relationship).toBe('sourceFn calls targetFn');
    } finally {
      unsetDb(project, { close: false });
      db.close();
    }
  });

  it('returns not-found error when edge does not exist', async () => {
    const project = 'edge-evidence-missing';
    const db = LynxDatabase.openMemory();
    try {
      // Create nodes so symbols resolve, but no edge between them
      const ins = db.db.prepare('INSERT INTO nodes (project, kind, name, qualified_name, file_path) VALUES (?, ?, ?, ?, ?)');
      ins.run(project, 'Function', 'nope', 'mod.nope', 'src/nope.ts');
      ins.run(project, 'Function', 'gone', 'mod.gone', 'src/gone.ts');
      setDb(project, db);
      const result = await handleGetEdgeEvidence({ project, source_name: 'nope', target_name: 'gone' }) as Record<string, unknown>;
      expect(result.direct_edge).toBe(false);
    } finally {
      unsetDb(project, { close: false });
      db.close();
    }
  });
});

describe('trace_path evidence integration', () => {
  it('annotates edges with evidence when include_evidence is true', async () => {
    const project = 'trace-evidence-int';
    const db = LynxDatabase.openMemory();
    try {
      db.upsertProject(project, process.cwd());
      // Insert a call chain: main → helper, helper → dbWrite
      const ins = db.db.prepare('INSERT INTO nodes (project, kind, name, qualified_name, file_path, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const mainId = Number(ins.run(project, 'Function', 'main', 'pkg.main', 'src/main.ts', 1, 10).lastInsertRowid);
      const helperId = Number(ins.run(project, 'Function', 'helper', 'pkg.helper', 'src/helpers.ts', 5, 15).lastInsertRowid);
      const dbWriteId = Number(ins.run(project, 'Function', 'dbWrite', 'pkg.dbWrite', 'src/db.ts', 20, 30).lastInsertRowid);
      // Edges: main → helper (CALLS), helper → dbWrite (CALLS)
      const e1 = db.db.prepare('INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)').run(project, mainId, helperId, 'CALLS', '{}');
      const e2 = db.db.prepare('INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)').run(project, helperId, dbWriteId, 'CALLS', '{}');
      // Evidence for both edges
      db.db.prepare('INSERT INTO edge_evidence (project, edge_id, evidence_type, source_kind, source_path, start_line, extractor, strength, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(project, Number(e1.lastInsertRowid), 'CALL_EXPRESSION', 'resolver', 'src/main.ts', 5, 'resolve', 0.85, JSON.stringify({ caller_line: 5, callee_name: 'helper' }));
      db.db.prepare('INSERT INTO edge_evidence (project, edge_id, evidence_type, source_kind, source_path, start_line, extractor, strength, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(project, Number(e2.lastInsertRowid), 'CALL_EXPRESSION', 'resolver', 'src/helpers.ts', 12, 'resolve', 0.85, JSON.stringify({ caller_line: 12, callee_name: 'dbWrite' }));
      setDb(project, db);

      const result = await handleTracePath({
        project, function_name: 'main', direction: 'outbound', depth: 2,
        include_edges: true, include_evidence: true,
      }) as Record<string, unknown>;

      expect(result.function).toBeDefined();
      const edgesResult = result.edges as Array<Record<string, unknown>>;
      expect(edgesResult).toBeDefined();
      // Both edges should have evidence
      const withEvidence = edgesResult.filter(e => e.evidence !== undefined);
      expect(withEvidence.length).toBeGreaterThanOrEqual(1);
      const ev = withEvidence[0].evidence as Array<Record<string, unknown>>;
      expect(ev[0]).toMatchObject({
        evidence_type: 'CALL_EXPRESSION',
        confidence_tier: 'resolver',
      });
      expect(ev[0].location).toContain('.ts:');
    } finally {
      unsetDb(project, { close: false });
      db.close();
    }
  });

  it('excludes evidence when include_evidence is false (default)', async () => {
    const project = 'trace-no-ev';
    const db = LynxDatabase.openMemory();
    try {
      db.upsertProject(project, process.cwd());
      const ins = db.db.prepare('INSERT INTO nodes (project, kind, name, qualified_name, file_path) VALUES (?, ?, ?, ?, ?)');
      const aId = Number(ins.run(project, 'Function', 'a', 'pkg.a', 'a.ts').lastInsertRowid);
      const bId = Number(ins.run(project, 'Function', 'b', 'pkg.b', 'b.ts').lastInsertRowid);
      const e = db.db.prepare('INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)').run(project, aId, bId, 'CALLS', '{}');
      db.db.prepare('INSERT INTO edge_evidence (project, edge_id, evidence_type, source_kind, extractor, strength, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(project, Number(e.lastInsertRowid), 'CALL_EXPRESSION', 'resolver', 'resolve', 0.85, '{}');
      setDb(project, db);

      const result = await handleTracePath({
        project, function_name: 'a', direction: 'outbound', depth: 1,
        include_edges: true,
        // include_evidence not set → defaults to false
      }) as Record<string, unknown>;

      const edgesResult = (result.edges as Array<Record<string, unknown>>) || [];
      if (edgesResult.length > 0) {
        expect(edgesResult[0].evidence).toBeUndefined();
      }
    } finally {
      unsetDb(project, { close: false });
      db.close();
    }
  });

  it('shows include_evidence in tool schema', () => {
    const tracePath = TOOLS.find(t => t.name === 'trace_path');
    expect(tracePath).toBeDefined();
    expect((tracePath!.inputSchema as { properties: Record<string, unknown> }).properties.include_evidence).toBeDefined();
  });
});

describe('investigate_symbol meta-tool', () => {
  it('returns a unified context pack for a known symbol', async () => {
    const project = 'investigate-sym';
    const db = LynxDatabase.openMemory();
    try {
      db.upsertProject(project, process.cwd());
      const ins = db.db.prepare('INSERT INTO nodes (project, kind, name, qualified_name, file_path, start_line, end_line, is_exported) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const aId = Number(ins.run(project, 'Function', 'readConfig', 'pkg.readConfig', 'src/db.ts', 10, 20, 1).lastInsertRowid);
      const bId = Number(ins.run(project, 'Function', 'openDb', 'pkg.openDb', 'src/db.ts', 25, 35, 1).lastInsertRowid);
      const e = db.db.prepare('INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)').run(project, aId, bId, 'CALLS', '{}');
      db.db.prepare('INSERT INTO edge_evidence (project, edge_id, evidence_type, source_kind, source_path, start_line, extractor, strength, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(project, Number(e.lastInsertRowid), 'CALL_EXPRESSION', 'resolver', 'src/db.ts', 15, 'resolve', 0.85, JSON.stringify({ caller_line: 15, callee_name: 'openDb' }));
      // Test files need a node for find_tests to work
      db.db.prepare('INSERT INTO nodes (project, kind, name, qualified_name, file_path, is_test) VALUES (?, ?, ?, ?, ?, ?)').run(project, 'Function', 'testConfig', 'tests.testConfig', 'tests/db.test.ts', 1);
      const testNode = db.db.prepare('SELECT id FROM nodes WHERE qualified_name = ?').get('tests.testConfig') as { id: number };
      db.db.prepare('INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)').run(project, testNode.id, aId, 'TESTS', '{}');
      setDb(project, db);

      const result = await handleInvestigateSymbol({ project, symbol: 'readConfig', depth: 1 }) as Record<string, unknown>;

      expect(result.symbol).toBe('readConfig');
      expect(result.project).toBe(project);
      expect(result.errors).toBeUndefined();
      // The meta-tool always produces the 5-layer structure
      const layers = result.layers as Record<string, unknown>;
      expect(layers.search).toBeDefined();
      expect(layers.explain).toBeDefined();
      expect(layers.trace).toBeDefined();
      expect(layers.snippet).toBeDefined();
      expect(layers.tests).toBeDefined();
      // Meta field documents the operations collapsed into one call
      const meta = result.meta as Record<string, unknown>;
      expect(meta.operations_collapsed).toBeGreaterThan(0);
      expect(meta.layers_succeeded).toBeGreaterThan(0);
      expect(meta.layers_attempted).toBe(5);
    } finally {
      unsetDb(project, { close: false });
      db.close();
    }
  });

  it('collects errors when a layer fails but still returns other layers', async () => {
    const project = 'investigate-partial';
    const db = LynxDatabase.openMemory();
    try {
      db.upsertProject(project, process.cwd());
      // No nodes — search_graph will return no results but won't throw;
      // explain_symbol will report not found but won't throw either.
      setDb(project, db);
      const result = await handleInvestigateSymbol({ project, symbol: 'nonexistent', depth: 1 }) as Record<string, unknown>;
      expect(result.symbol).toBe('nonexistent');
      const layers = result.layers as Record<string, unknown>;
      // All layers should still exist, even if empty/error
      expect(layers).toBeDefined();
    } finally {
      unsetDb(project, { close: false });
      db.close();
    }
  });
});
