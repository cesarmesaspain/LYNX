import { describe, expect, it } from 'vitest';
import { TOOLS } from './tools.js';
import { listMcpTools } from './server.js';

describe('MCP tool registry', () => {
  it('returns the complete registry in one tools/list response', () => {
    expect(TOOLS).toHaveLength(27);
    expect(new Set(TOOLS.map((tool) => tool.name)).size).toBe(TOOLS.length);
    expect(TOOLS.map((tool) => tool.name)).toContain('find_dead_code');
    const listed = listMcpTools();
    expect(listed).toHaveLength(TOOLS.length);
    expect(listed.map(tool => tool.name)).toContain('pack_context');
    expect(listed.map(tool => tool.name)).toContain('delete_project');
    expect(listed.find((tool) => tool.name === 'search_graph')?.description).toContain(
      'consolidate it and stop investigating',
    );
  });

  it('offers the compact profile only when explicitly requested', () => {
    const previous = process.env.LYNX_TOOL_PROFILE;
    process.env.LYNX_TOOL_PROFILE = 'core';
    try {
      expect(listMcpTools()).toHaveLength(9);
    } finally {
      if (previous === undefined) delete process.env.LYNX_TOOL_PROFILE;
      else process.env.LYNX_TOOL_PROFILE = previous;
    }
  });
});
