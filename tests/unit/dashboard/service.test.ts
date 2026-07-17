import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  lockHeld: false,
  command: '/usr/bin/node /opt/lynx/cli.js dashboard --service',
  child: {
    pid: 4242,
    unref: vi.fn(),
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      state.listeners.set(event, listener);
      return state.child;
    }),
  },
  spawn: vi.fn(() => state.child),
}));

vi.mock('node:fs', () => ({
  closeSync: vi.fn(),
  openSync: vi.fn(() => {
    if (state.lockHeld) throw new Error('EEXIST');
    state.lockHeld = true;
    return 99;
  }),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn((path: string) => {
    const value = state.files.get(path);
    if (value === undefined) throw new Error('missing');
    return value;
  }),
  writeFileSync: vi.fn((path: string, value: string) => state.files.set(path, value)),
  unlinkSync: vi.fn((path: string) => {
    if (path.endsWith('dashboard.start.lock')) state.lockHeld = false;
    state.files.delete(path);
  }),
}));
vi.mock('node:http', () => ({
  get: vi.fn((_options: unknown, callback: (response: { statusCode: number; resume: () => void }) => void) => {
    callback({ statusCode: 200, resume: vi.fn() });
    const request = {
      destroy: vi.fn(),
      once: vi.fn(() => request),
    };
    return request;
  }),
}));
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => state.command),
  spawn: state.spawn,
}));
vi.mock('../../../src/config/runtime.js', () => ({ lynxHome: () => '/tmp/lynx-service-test' }));

import { ensureDashboardService } from '../../../src/server/dashboard/service.js';

describe('standalone dashboard service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.files.clear();
    state.listeners.clear();
    state.lockHeld = false;
    state.command = '/usr/bin/node /opt/lynx/cli.js dashboard --service';
    state.spawn.mockClear();
    state.child.unref.mockClear();
    state.child.once.mockClear();
    vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('persists the PID only after the detached service survives startup', async () => {
    const pending = ensureDashboardService('/usr/bin/node', ['/opt/lynx/cli.js', 'serve']);
    expect([...state.files.values()]).not.toContain('4242');

    await vi.advanceTimersByTimeAsync(300);
    const result = await pending;

    expect(result).toContain('started standalone dashboard service');
    expect([...state.files.values()]).toContain('4242');
    expect(state.spawn).toHaveBeenCalledWith('/usr/bin/node', ['/opt/lynx/cli.js', 'dashboard', '--service'], expect.objectContaining({ detached: true, stdio: 'ignore' }));
  });

  it('does not spawn twice when the PID belongs to the dashboard service', async () => {
    state.files.set('/tmp/lynx-service-test/dashboard.pid', '4242');

    const result = await ensureDashboardService('/usr/bin/node', ['/opt/lynx/cli.js', 'serve']);

    expect(result).toContain('already running');
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it('serializes concurrent startup attempts into a single spawn', async () => {
    const first = ensureDashboardService('/usr/bin/node', ['/opt/lynx/cli.js', 'serve']);
    const second = ensureDashboardService('/usr/bin/node', ['/opt/lynx/cli.js', 'serve']);

    await vi.advanceTimersByTimeAsync(500);
    const results = await Promise.all([first, second]);

    expect(state.spawn).toHaveBeenCalledOnce();
    expect(results.some((result) => result.includes('started standalone dashboard service'))).toBe(true);
    expect(results.some((result) => result.includes('already running'))).toBe(true);
  });

  it('replaces a live PID that belongs to another process', async () => {
    state.files.set('/tmp/lynx-service-test/dashboard.pid', '4242');
    state.command = '/usr/bin/sleep 100';

    const pending = ensureDashboardService('/usr/bin/node', ['/opt/lynx/cli.js', 'serve']);
    state.command = '/usr/bin/node /opt/lynx/cli.js dashboard --service';
    await vi.advanceTimersByTimeAsync(300);

    expect(await pending).toContain('started standalone dashboard service');
    expect(state.spawn).toHaveBeenCalledOnce();
  });

  it('removes a dead PID and starts a replacement', async () => {
    state.files.set('/tmp/lynx-service-test/dashboard.pid', '3131');
    vi.mocked(process.kill)
      .mockImplementationOnce(() => { throw new Error('ESRCH'); })
      .mockImplementation(() => true);

    const pending = ensureDashboardService('/usr/bin/node', ['/opt/lynx/cli.js', 'serve']);
    await vi.advanceTimersByTimeAsync(300);

    expect(await pending).toContain('started standalone dashboard service');
    expect(state.files.get('/tmp/lynx-service-test/dashboard.pid')).toBe('4242');
  });

  it('does not leave a PID when spawn fails immediately', async () => {
    const pending = ensureDashboardService('/usr/bin/node', ['/opt/lynx/cli.js', 'serve']);
    state.listeners.get('error')?.(new Error('ENOENT'));
    await vi.advanceTimersByTimeAsync(100);

    expect(await pending).toContain('failed to start');
    expect([...state.files.values()]).not.toContain('4242');
  });

  it('does not leave a PID when the child exits during startup', async () => {
    const pending = ensureDashboardService('/usr/bin/node', ['/opt/lynx/cli.js', 'serve']);
    state.listeners.get('exit')?.(1, null);
    await vi.advanceTimersByTimeAsync(100);

    expect(await pending).toContain('exited during startup');
    expect([...state.files.values()]).not.toContain('4242');
  });
});
