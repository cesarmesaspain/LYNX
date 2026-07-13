import { afterEach, describe, expect, it } from 'vitest';
import { handleToolCatalog } from '../../../src/mcp/handlers/tool_catalog.js';

const originalProfile = process.env.LYNX_TOOL_PROFILE;

afterEach(() => {
  if (originalProfile === undefined) delete process.env.LYNX_TOOL_PROFILE;
  else process.env.LYNX_TOOL_PROFILE = originalProfile;
});

describe('tool_catalog profile reporting', () => {
  it('reports the full registry as the default profile', async () => {
    delete process.env.LYNX_TOOL_PROFILE;

    const result = await handleToolCatalog() as { profile: string; advanced_profile: string };

    expect(result.profile).toBe('full');
    expect(result.advanced_profile).toBe('Full catalog is active.');
  });

  it('keeps the compact profile guidance when core is explicitly selected', async () => {
    process.env.LYNX_TOOL_PROFILE = 'core';

    const result = await handleToolCatalog() as { profile: string; advanced_profile: string };

    expect(result.profile).toBe('core');
    expect(result.advanced_profile).toContain('Switch MCP catalog to Full');
  });
});
