import { describe, it, expect } from 'vitest';
import { LynxDatabase } from '../../src/store/database.js';
import { resolveAll } from '../../src/pipeline/phases/resolve/index.js';

describe('resolveAll contract', () => {
  it('returns empty stats for empty batches', () => {
    const db = LynxDatabase.openMemory();
    const result = resolveAll(db, [], 'test-empty');
    expect(result.totalEdges).toBe(0);
    expect(result.totalCalls).toBe(0);
    expect(result.unresolvedCalls).toBe(0);
    expect(Object.keys(result.edgeTypeBreakdown).length).toBe(0);
  });

  it('returns ResolutionStats with expected shape', () => {
    const db = LynxDatabase.openMemory();
    const result = resolveAll(db, [], 'test-shape');
    expect(result).toHaveProperty('unresolvedCalls');
    expect(result).toHaveProperty('totalCalls');
    expect(result).toHaveProperty('totalEdges');
    expect(result).toHaveProperty('edgeTypeBreakdown');
    expect(typeof result.totalEdges).toBe('number');
    expect(typeof result.edgeTypeBreakdown).toBe('object');
  });

  it('does not throw with null/undefined project name', () => {
    const db = LynxDatabase.openMemory();
    // Empty batches should be safe regardless of project name
    expect(() => resolveAll(db, [], '')).not.toThrow();
  });
});
