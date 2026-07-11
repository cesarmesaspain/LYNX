import { describe, expect, it } from 'vitest';
import { TOOLS } from './tools.js';
import { listMcpTools } from './server.js';

describe('MCP tool registry', () => {
  it('returns the complete registry in one tools/list response', () => {
    expect(TOOLS).toHaveLength(26);
    expect(new Set(TOOLS.map((tool) => tool.name)).size).toBe(TOOLS.length);
    expect(TOOLS.map((tool) => tool.name)).toContain('find_dead_code');
    const listed = listMcpTools();
    expect(listed).toHaveLength(TOOLS.length);
    expect(listed.find((tool) => tool.name === 'search_graph')?.description).toContain(
      'consolidate it and stop investigating',
    );
    expect(listed.find((tool) => tool.name === 'get_architecture')?.description).toContain(
      'do not call again for an aspect already included',
    );
    expect(listed.find((tool) => tool.name === 'search_code')?.description).toContain(
      'one regex search instead of serial equivalent searches',
    );
    expect(listed.find((tool) => tool.name === 'index_repository')?.description).toBe(
      TOOLS.find((tool) => tool.name === 'index_repository')?.description,
    );
  });
});
