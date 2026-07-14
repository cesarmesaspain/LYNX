import { describe, expect, it } from 'vitest';
import { TOOLS } from './tools.js';
import { buildIndexContext, getDb, listMcpTools, setDb, unsetDb } from './server.js';
import { LynxDatabase } from '../store/database.js';

describe('MCP tool registry', () => {
  it('returns the complete registry in one tools/list response', () => {
    expect(TOOLS).toHaveLength(29);
    expect(new Set(TOOLS.map((tool) => tool.name)).size).toBe(TOOLS.length);
    expect(TOOLS.map((tool) => tool.name)).toContain('find_dead_code');
    expect(TOOLS.map((tool) => tool.name)).toContain('diagnose');
    expect(TOOLS.map((tool) => tool.name)).toContain('usage_summary');
    const listed = listMcpTools();
    expect(listed).toHaveLength(TOOLS.length);
    expect(listed.map(tool => tool.name)).toContain('pack_context');
    expect(listed.map(tool => tool.name)).toContain('delete_project');
    expect(listed.find((tool) => tool.name === 'search_graph')?.description).toContain(
      'Use the smallest focused call',
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
  });

  it('offers the compact profile only when explicitly requested', () => {
    const previous = process.env.LYNX_TOOL_PROFILE;
    process.env.LYNX_TOOL_PROFILE = 'core';
    try {
      expect(listMcpTools()).toHaveLength(11);
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
