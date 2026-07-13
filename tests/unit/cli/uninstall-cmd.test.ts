import { beforeEach, describe, expect, it, vi } from 'vitest';
const handlers = vi.hoisted(() => ({
runUninstall: vi.fn(),
}));
vi.mock('../../../src/install/index.js', () => ({
runUninstall: handlers.runUninstall,
}));
import { cmdUninstall } from '../../../src/cli/commands/uninstall-cmd.js';
beforeEach(() => {
vi.clearAllMocks();
});
describe('uninstall CLI command', () => {
it('delegates dryRun flag to runUninstall', () => {
cmdUninstall(['--dry-run']);
expect(handlers.runUninstall).toHaveBeenCalledWith(true);
});
it('delegates false when flag is absent', () => {
cmdUninstall([]);
expect(handlers.runUninstall).toHaveBeenCalledWith(false);
});
});
