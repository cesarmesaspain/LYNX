import { beforeEach,  describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({findNearestProject: vi.fn()}));

vi.mock('../../../src/discovery/project-scanner.js', () => ({findNearestProject: handlers.findNearestProject}));

import { cmdDetect } from '../../../src/cli/commands/detect-cmd.js';

beforeEach(() => vi.clearAllMocks());

describe('detect CLI command', () => {
  it('prints detected project', () => {
    handlers.findNearestProject.mockReturnValue({ name: 'TEST', language: 'TypeScript', secondaryLanguages: [], frameworks: [], rootPath: '/tmp/test', markers: [], confidence: 0.9 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdDetect(['/tmp/test']);
    expect(log).toHaveBeenCalledWith('Project: TEST');
    log.mockRestore();
  });
  it('prints no project message', () => {
    handlers.findNearestProject.mockReturnValue(undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdDetect([]);
    expect(log).toHaveBeenCalledWith('No project detected.');
    log.mockRestore();
  });
});
