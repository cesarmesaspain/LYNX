import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  spawn: vi.fn(() => ({ pid: 4242, unref: vi.fn() })),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn((path: string) => {
    const value = state.files.get(path);
    if (value === undefined) throw new Error('missing');
    return value;
  }),
  writeFileSync: vi.fn((path: string, value: string) => state.files.set(path, value)),
  unlinkSync: vi.fn((path: string) => state.files.delete(path)),
}));
vi.mock('node:child_process', () => ({ spawn: state.spawn }));

import { startDashboardService } from '../../../src/server/dashboard/service.js';

describe('standalone dashboard service', () => {
  beforeEach(() => { state.files.clear(); state.spawn.mockClear(); });

  it('starts detached from MCP clients and passes service mode', () => {
    const result = startDashboardService('/usr/bin/node', ['/opt/lynx/cli.js', 'serve']);
    expect(result).toContain('started standalone dashboard service');
    expect(state.spawn).toHaveBeenCalledWith('/usr/bin/node', ['/opt/lynx/cli.js', 'dashboard', '--service'], expect.objectContaining({ detached: true, stdio: 'ignore' }));
  });
});
