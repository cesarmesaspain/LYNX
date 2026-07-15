import { LynxDatabase } from '../store/database.js';
import { FileWatcher, type WatcherStatus } from './file-watcher.js';
import type { LynxIndexMode } from '../types.js';

type Entry = { watcher: FileWatcher; db: LynxDatabase };
const entries = new Map<string, Entry>();

export function startProjectWatcher(project: string, rootPath: string, mode: LynxIndexMode = 'fast'): { alreadyRunning: boolean; status: WatcherStatus } {
  const existing = entries.get(project);
  if (existing) return { alreadyRunning: true, status: existing.watcher.status() };
  const db = LynxDatabase.openProject(project);
  try {
    const watcher = new FileWatcher(db, rootPath, project, mode);
    const status = watcher.start();
    entries.set(project, { watcher, db });
    return { alreadyRunning: false, status };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function getProjectWatcherStatus(project: string): WatcherStatus | null {
  return entries.get(project)?.watcher.status() ?? null;
}

export async function stopProjectWatcher(project: string): Promise<WatcherStatus | null> {
  const entry = entries.get(project);
  if (!entry) return null;
  await entry.watcher.stop();
  const status = entry.watcher.status();
  entry.db.close();
  entries.delete(project);
  return status;
}

export async function closeAllProjectWatchers() {
  await Promise.all([...entries.keys()].map(stopProjectWatcher));
}
