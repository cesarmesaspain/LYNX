import { describe, expect, it } from 'vitest';
import { TOOLS } from './tools.js';
import { listMcpTools } from './server.js';

describe('MCP tool registry', () => {
  it('returns the complete registry in one tools/list response', () => {
    expect(TOOLS).toHaveLength(27);
    expect(new Set(TOOLS.map((tool) => tool.name)).size).toBe(TOOLS.length);
    expect(TOOLS.map((tool) => tool.name)).toContain('find_dead_code');
    const listed = listMcpTools();
    expect(listed).toHaveLength(9);
    expect(listed.map(tool => tool.name)).toContain('pack_context');
    expect(listed.map(tool => tool.name)).not.toContain('delete_project');
    expect(listed.find((tool) => tool.name === 'search_graph')?.description).toContain(
      'consolidate it and stop investigating',
    );
  });
});
