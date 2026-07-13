import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
  readLynxConfig: vi.fn(() => ({ auto_index: false })),
  readLynxConfigSafe: vi.fn(() => ({ auto_index: false })),
  upsertLynxConfig: vi.fn((v) => v),
}));

vi.mock('../../../src/config/runtime.js', () => ({
  readLynxConfig: handlers.readLynxConfig,
  readLynxConfigSafe: handlers.readLynxConfigSafe,
  upsertLynxConfig: handlers.upsertLynxConfig,
}));

import { cmdConfig } from '../../../src/cli/commands/config-cmd.js';

beforeEach(() => vi.clearAllMocks());

describe('config CLI command', () => {
  it('gets config', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdConfig([]);
    expect(handlers.readLynxConfigSafe).toHaveBeenCalled();
    log.mockRestore();
  });

  it('sets boolean config', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdConfig(['set', 'auto_index', 'true']);
    expect(handlers.upsertLynxConfig).toHaveBeenCalledWith({ auto_index: true });
    log.mockRestore();
  });

  it('sets locale', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdConfig(['set', 'locale', 'es']);
    expect(handlers.upsertLynxConfig).toHaveBeenCalledWith({ locale: 'es' });
    log.mockRestore();
  });
});
