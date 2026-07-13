import { afterEach, describe, expect, it, vi } from 'vitest';

const dashboard = vi.hoisted(() => ({
  isDashboardListening: vi.fn(() => true),
  startDashboard: vi.fn(),
  stopDashboard: vi.fn(),
}));

vi.mock('../../../src/server/dashboard/index.js', () => dashboard);

import { cmdDashboard } from '../../../src/cli/commands/dashboard-cmd.js';

describe('dashboard CLI command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    dashboard.isDashboardListening.mockClear();
    dashboard.startDashboard.mockClear();
    dashboard.stopDashboard.mockClear();
  });

  it('opens the dashboard without running any background workload', () => {
    const interval = vi.spyOn(global, 'setInterval').mockReturnValue({ unref: vi.fn() } as unknown as ReturnType<typeof setInterval>);
    const processOn = vi.spyOn(process, 'on').mockReturnThis();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    cmdDashboard();

    expect(dashboard.startDashboard).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('Dashboard: http://localhost:9191');
    expect(interval).toHaveBeenCalledOnce();
    expect(processOn).toHaveBeenCalled();
  });
});
