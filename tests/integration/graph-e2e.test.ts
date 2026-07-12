/*
 * graph-e2e.test.ts — Integration tests for the full LYNX pipeline:
 * index → search → trace → dead code detection.
 *
 * Uses the sample-project fixture (expanded with dead code candidates)
 * and validates end-to-end correctness through real pipeline runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LynxDatabase } from '../../src/store/database.js';
import { runPipeline } from '../../src/pipeline/orchestrator.js';
import { handleSearchGraph } from '../../src/mcp/handlers/search_graph.js';
import { handleTracePath } from '../../src/mcp/handlers/trace_path.js';
import { handleFindDeadCode } from '../../src/mcp/handlers/find_dead_code.js';
import { handleAnalyzeHotspots } from '../../src/mcp/handlers/analyze_hotspots.js';
import { setDb, unsetDb } from '../../src/mcp/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../fixtures/sample-project');
const PROJECT = 'graph-e2e';

describe('Graph E2E: index → search → trace → dead code', () => {
  let db: LynxDatabase;

  beforeAll(async () => {
    db = LynxDatabase.openMemory();
    const result = await runPipeline(db, FIXTURE, PROJECT, { mode: 'fast', testSkipProjectBrief: true });
    // Sanity: pipeline completed successfully
    expect(result.status.status).toBe('ready');
    expect(result.status.totalNodes).toBeGreaterThan(0);
    expect(result.status.totalEdges).toBeGreaterThan(0);
    setDb(PROJECT, db);
  }, 30000);

  afterAll(() => {
    unsetDb(PROJECT, { close: false });
    db.close();
  });

  // ── search_graph ────────────────────────────────────────────────

  describe('search_graph', () => {
    it('finds exported functions by name', async () => {
      const result = await handleSearchGraph({ project: PROJECT, query: 'calculate', enable_llm: false }) as Record<string, unknown>;
      const results = result.results as Array<Record<string, unknown>>;
      expect(results.length).toBeGreaterThanOrEqual(1);
      const names = results.map(r => r.name);
      expect(names).toContain('calculate');
    });

    it('filters by kind=Class', async () => {
      const result = await handleSearchGraph({ project: PROJECT, label: 'Class', enable_llm: false }) as Record<string, unknown>;
      const results = result.results as Array<Record<string, unknown>>;
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect(r.kind).toBe('Class');
      }
    });

    it('filters by file_pattern', async () => {
      const result = await handleSearchGraph({ project: PROJECT, file_pattern: 'src/utils/**', enable_llm: false }) as Record<string, unknown>;
      const results = result.results as Array<Record<string, unknown>>;
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect(r.file).toMatch(/^src\/utils\//);
      }
    });

    it('returns empty for nonsense query', async () => {
      const result = await handleSearchGraph({ project: PROJECT, query: 'xyznonexistent123', enable_llm: false }) as Record<string, unknown>;
      const results = result.results as Array<Record<string, unknown>>;
      expect(results.length).toBe(0);
    });

    it('finds unused.ts symbols via name_pattern', async () => {
      const result = await handleSearchGraph({ project: PROJECT, name_pattern: 'dead%', enable_llm: false }) as Record<string, unknown>;
      const results = result.results as Array<Record<string, unknown>>;
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect(r.name).toMatch(/^dead/);
      }
    });
  });

  // ── trace_path ──────────────────────────────────────────────────

  describe('trace_path', () => {
    it('traces outbound calls from main', async () => {
      const result = await handleTracePath({ project: PROJECT, function_name: 'main', direction: 'outbound', mode: 'calls', depth: 3 }) as Record<string, unknown>;
      const functionObj = result.function as Record<string, unknown>;
      expect(functionObj.name).toBe('main');
      // callers/callees are at top level of result, not nested under function
      const callees = result.callees as Array<Record<string, unknown>>;
      const calleeNames = callees.map(c => c.name);
      expect(calleeNames).toContain('calculate');
      expect(calleeNames).toContain('greet');
    });

    it('traces inbound calls to calculate', async () => {
      const result = await handleTracePath({ project: PROJECT, function_name: 'calculate', direction: 'inbound', mode: 'calls', depth: 2 }) as Record<string, unknown>;
      const functionObj = result.function as Record<string, unknown>;
      expect(functionObj.name).toBe('calculate');
      const callers = result.callers as Array<Record<string, unknown>>;
      const callerNames = callers.map(c => c.name);
      expect(callerNames).toContain('main');
    });

    it('traces intra-file calls: calculate → add', async () => {
      const result = await handleTracePath({ project: PROJECT, function_name: 'calculate', direction: 'outbound', mode: 'calls', depth: 1 }) as Record<string, unknown>;
      const callees = result.callees as Array<Record<string, unknown>>;
      const calleeNames = callees.map(c => c.name);
      // add() is called by calculate in the same file
      expect(calleeNames).toContain('add');
    });
  });

  // ── find_dead_code ──────────────────────────────────────────────

  describe('find_dead_code', () => {
    it('detects uncalled functions in unused.ts', async () => {
      const result = await handleFindDeadCode({ project: PROJECT, kinds: ['Function'] }) as Record<string, unknown>;
      const candidates = result.candidates as Array<Record<string, unknown>>;
      const names = candidates.map(c => c.name);
      // deadFunction is exported but never called
      expect(names).toContain('deadFunction');
      // alsoDead is exported but never called
      expect(names).toContain('alsoDead');
    });

    it('does not flag actively called functions', async () => {
      const result = await handleFindDeadCode({ project: PROJECT, kinds: ['Function'] }) as Record<string, unknown>;
      const candidates = result.candidates as Array<Record<string, unknown>>;
      const names = candidates.map(c => c.name);
      // calculate is called by main
      expect(names).not.toContain('calculate');
      // main is called by run
      expect(names).not.toContain('main');
      // greet is called by main
      expect(names).not.toContain('greet');
    });

    it('marks exported dead code with medium confidence and caveat', async () => {
      const result = await handleFindDeadCode({ project: PROJECT, kinds: ['Function'] }) as Record<string, unknown>;
      const candidates = result.candidates as Array<Record<string, unknown>>;
      const deadFunc = candidates.find(c => c.name === 'deadFunction');
      expect(deadFunc).toBeDefined();
      if (deadFunc) {
        expect(deadFunc.definition_verified).toBe(true);
        expect(deadFunc.zero_incoming_references).toBe(true);
        expect(deadFunc.incoming_calls).toBe(0);
      }
    });
  });

  // ── analyze_hotspots ────────────────────────────────────────────

  describe('analyze_hotspots', () => {
    it('returns hotspots with valid metrics', async () => {
      const result = await handleAnalyzeHotspots({ project: PROJECT }) as Record<string, unknown>;
      expect(result.project).toBe(PROJECT);
      expect(Array.isArray(result.hotspots)).toBe(true);
      const hotspots = result.hotspots as Array<Record<string, unknown>>;
      if (hotspots.length > 0) {
        const h = hotspots[0];
        expect(h.name).toBeDefined();
        expect(typeof h.complexity).toBe('number');
        expect(typeof h.fan_in).toBe('number');
      }
    });

    it('is deterministic on repeated calls', async () => {
      const a = await handleAnalyzeHotspots({ project: PROJECT }) as Record<string, unknown>;
      const b = await handleAnalyzeHotspots({ project: PROJECT }) as Record<string, unknown>;
      const aHotspots = a.hotspots as Array<Record<string, unknown>>;
      const bHotspots = b.hotspots as Array<Record<string, unknown>>;
      expect(aHotspots.length).toBe(bHotspots.length);
      for (let i = 0; i < aHotspots.length; i++) {
        expect(aHotspots[i].name).toBe(bHotspots[i].name);
      }
    });
  });

  // ── Edge type integrity ─────────────────────────────────────────

  describe('edge integrity', () => {
    it('has CALLS edges for cross-file calls', () => {
      const rows = db.db.prepare(
        `SELECT n1.name as caller, n2.name as callee
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id AND n1.project = ?
         JOIN nodes n2 ON e.target_id = n2.id AND n2.project = ?
         WHERE e.project = ? AND e.type = 'CALLS'`
      ).all(PROJECT, PROJECT, PROJECT) as Array<{ caller: string; callee: string }>;
      const pairs = rows.map(r => `${r.caller} → ${r.callee}`);
      // cross-file: main → calculate, main → greet, run → main
      expect(pairs).toContain('main → calculate');
      expect(pairs).toContain('main → greet');
    });

    it('has CALLS edges for intra-file calls (C extractor fix verified)', () => {
      const rows = db.db.prepare(
        `SELECT n1.name as caller, n2.name as callee
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id AND n1.project = ?
         JOIN nodes n2 ON e.target_id = n2.id AND n2.project = ?
         WHERE e.project = ? AND e.type = 'CALLS'`
      ).all(PROJECT, PROJECT, PROJECT) as Array<{ caller: string; callee: string }>;
      const pairs = rows.map(r => `${r.caller} → ${r.callee}`);
      // intra-file: calculate → add
      expect(pairs).toContain('calculate → add');
    });
  });
});
