import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getProjectWatcherStatus,
  startProjectWatcher,
  stopProjectWatcher,
} from '../../../src/watcher/watcher-manager.js';

const project = `watcher-manager-${process.pid}-${Date.now()}`;
let tempDir = '';

afterEach(async () => {
  await stopProjectWatcher(project);
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('project watcher manager', () => {
  it('starts one watcher per project and releases it on stop', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-watcher-manager-'));
    fs.writeFileSync(path.join(tempDir, 'example.ts'), 'export const value = 1;\n');

    const first = startProjectWatcher(project, tempDir, 'fast');
    const second = startProjectWatcher(project, tempDir, 'fast');

    expect(first.alreadyRunning).toBe(false);
    expect(first.status.watching).toBe(true);
    expect(second.alreadyRunning).toBe(true);
    expect(getProjectWatcherStatus(project)?.watching).toBe(true);

    const stopped = await stopProjectWatcher(project);

    expect(stopped?.watching).toBe(false);
    expect(getProjectWatcherStatus(project)).toBeNull();
  });
});
