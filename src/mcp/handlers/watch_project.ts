/*
 * watch_project — Start/stop/status the file watcher via MCP.
 *
 * Exposes the FileWatcher daemon through the MCP protocol so IDE agents
 * can enable real-time code indexing without touching the CLI.
 *
 * Actions:
 *  - start: begin watching a project (requires prior indexing)
 *  - stop: stop the watcher
 *  - status: get current watcher state
 */

import * as path from 'node:path';
import { getDb, setDb } from '../server.js';
import { FileWatcher } from '../../watcher/file-watcher.js';
import { LynxDatabase } from '../../store/database.js';

// Watcher registry (session-scoped)
const watchers = new Map<string, FileWatcher>();

export async function handleWatchProject(
  args: Record<string, unknown>
): Promise<unknown> {
  const project = String(args.project || '');
  const action = String(args.action || 'status');

  if (!project) return { error: 'project is required' };

  const db = getDb(project);
  const projInfo = db.getProject(project);
  if (!projInfo) return { error: `Project not found: ${project}. Run index_repository first.` };

  switch (action) {
    case 'start': {
      if (watchers.has(project)) {
        const existing = watchers.get(project)!;
        const status = existing.status();
        return {
          project,
          action: 'start',
          message: 'Watcher already running.',
          status,
        };
      }

      const mode = args.mode ? String(args.mode) : 'fast';
      // Open a fresh DB connection for the watcher (avoids WAL contention with reader)
      const watcherDb = LynxDatabase.openProject(project);

      const watcher = new FileWatcher(
        watcherDb,
        projInfo.rootPath,
        project,
        mode as 'full' | 'moderate' | 'fast'
      );
      watchers.set(project, watcher);

      const status = watcher.start();
      return {
        project,
        action: 'start',
        message: `Watcher started. Watching ${status.filesWatched} files.`,
        status,
      };
    }

    case 'stop': {
      const watcher = watchers.get(project);
      if (!watcher) {
        return {
          project,
          action: 'stop',
          message: 'No watcher running for this project.',
        };
      }

      await watcher.stop();
      watchers.delete(project);
      return {
        project,
        action: 'stop',
        message: 'Watcher stopped.',
        status: watcher.status(),
      };
    }

    case 'status': {
      const watcher = watchers.get(project);
      if (!watcher) {
        return {
          project,
          action: 'status',
          active: false,
          message: 'No watcher running. Use action: "start" to begin watching.',
        };
      }

      const status = watcher.status();
      return {
        project,
        action: 'status',
        active: true,
        status,
      };
    }

    default:
      return { error: `Unknown action: ${action}. Use: start, stop, status.` };
  }
}
