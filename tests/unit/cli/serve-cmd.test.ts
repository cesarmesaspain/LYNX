import { afterEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
  findNearestProject: vi.fn(),
  readLynxConfig: vi.fn(),
  runServer: vi.fn(async () => undefined),
  getLynxCommand: vi.fn(() => ({ command: '/usr/bin/node', args: ['/opt/lynx/cli.js', 'serve'] })),
  ensureDashboardService: vi.fn(async () => 'dashboard ready'),
}));

vi.mock('../../../src/discovery/project-scanner.js', () => ({
  findNearestProject: handlers.findNearestProject,
}));
vi.mock('../../../src/config/runtime.js', () => ({
  readLynxConfig: handlers.readLynxConfig,
}));
vi.mock('../../../src/mcp/server.js', () => ({ runServer: handlers.runServer }));
vi.mock('../../../src/install/agents.js', () => ({ getLynxCommand: handlers.getLynxCommand }));
vi.mock('../../../src/server/dashboard/service.js', () => ({ ensureDashboardService: handlers.ensureDashboardService }));

import { cmdServe } from '../../../src/cli/commands/serve-cmd.js';

afterEach(() => vi.restoreAllMocks());

describe('serve CLI command', () => {
  it('starts the MCP server after detecting a project', async () => {
    handlers.findNearestProject.mockReturnValue({ name: 'TEST', language: 'TypeScript' });
    handlers.readLynxConfig.mockReturnValue({ enabled: true, auto_index: false, auto_dashboard: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await cmdServe();

    expect(handlers.runServer).toHaveBeenCalledOnce();
    expect(handlers.ensureDashboardService).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('Auto-detected project: TEST (TypeScript)');
  });

  it('does not ensure the dashboard when auto_dashboard is disabled', async () => {
    handlers.findNearestProject.mockReturnValue(null);
    handlers.readLynxConfig.mockReturnValue({ enabled: true, auto_index: false, auto_dashboard: false });
    handlers.ensureDashboardService.mockClear();

    await cmdServe();

    expect(handlers.ensureDashboardService).not.toHaveBeenCalled();
    expect(handlers.runServer).toHaveBeenCalled();
  });
});
