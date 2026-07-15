import { afterEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
  findNearestProject: vi.fn(),
  readLynxConfig: vi.fn(),
  runServer: vi.fn(async () => undefined),
}));

vi.mock('../../../src/discovery/project-scanner.js', () => ({
  findNearestProject: handlers.findNearestProject,
}));
vi.mock('../../../src/config/runtime.js', () => ({
  readLynxConfig: handlers.readLynxConfig,
}));
vi.mock('../../../src/mcp/server.js', () => ({ runServer: handlers.runServer }));

import { cmdServe } from '../../../src/cli/commands/serve-cmd.js';

afterEach(() => vi.restoreAllMocks());

describe('serve CLI command', () => {
  it('starts the MCP server after detecting a project', async () => {
    handlers.findNearestProject.mockReturnValue({ name: 'TEST', language: 'TypeScript' });
    handlers.readLynxConfig.mockReturnValue({ auto_index: false });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await cmdServe();

    expect(handlers.runServer).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('Auto-detected project: TEST (TypeScript)');
  });
});
