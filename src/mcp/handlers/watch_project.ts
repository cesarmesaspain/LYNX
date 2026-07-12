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
import { getProjectWatcherStatus, startProjectWatcher, stopProjectWatcher } from '../../watcher/watcher-manager.js';

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
      const existing = getProjectWatcherStatus(project);
      if (existing) {
        return {
          project,
          action: 'start',
          message: 'Watcher already running.',
          status: existing,
        };
      }

      const mode = args.mode ? String(args.mode) : 'fast';
      const { status } = startProjectWatcher(project, projInfo.rootPath, mode as 'full' | 'moderate' | 'fast');
      return {
        project,
        action: 'start',
        message: `Watcher started. Watching ${status.filesWatched} files.`,
        status,
      };
    }

    case 'stop': {
      const status = await stopProjectWatcher(project);
      if (!status) {
        return {
          project,
          action: 'stop',
          message: 'No watcher running for this project.',
        };
      }

      return {
        project,
        action: 'stop',
        message: 'Watcher stopped.',
        status,
      };
    }

    case 'status': {
      const status = getProjectWatcherStatus(project);
      if (!status) {
        return {
          project,
          action: 'status',
          active: false,
          message: 'No watcher running. Use action: "start" to begin watching.',
        };
      }

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
