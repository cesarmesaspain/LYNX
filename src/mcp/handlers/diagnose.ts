/*
 * diagnose.ts — Fast, local MCP diagnostics.
 *
 * This intentionally does not launch another MCP process or perform network
 * checks. It exposes actionable health information to an agent without
 * bypassing strict-mode hooks or leaking configured credentials.
 */

import * as fs from 'node:fs';
import { getLynxCommand } from '../../install/agents.js';
import { readLynxConfigSafe, lynxHome } from '../../config/runtime.js';
import { findDuplicateProjectRoots, scanIndexedProjects } from '../project-catalog.js';
import { storedTimestampMs } from '../../store/time.js';
import { listOrphanedLocks } from '../../store/lock.js';
import { getDb } from '../server.js';
import { detectGraphDrift } from '../../store/graph-drift.js';

type Health = 'healthy' | 'attention_needed';

export async function handleDiagnose(): Promise<Record<string, unknown>> {
  const config = readLynxConfigSafe();
  const projects = scanIndexedProjects();
  const now = Date.now();
  const staleThresholdMs = Math.max(1, config.stale_threshold_hours) * 60 * 60 * 1_000;
  const projectHealth = projects.map((project) => {
    const ageMs = Math.max(0, now - storedTimestampMs(project.indexedAt));
    let freshness = project.status === 'ready' && project.nodeCount > 0 && ageMs <= staleThresholdMs
      ? 'fresh'
      : project.status === 'ready' && project.nodeCount === 0
        ? 'empty'
        : project.status === 'ready'
          ? 'stale'
          : project.status;
    if (freshness === 'fresh') {
      try {
        const db = getDb(project.name);
        const meta = db.getProject(project.name);
        if (meta && detectGraphDrift(db, meta)?.status === 'drifted') freshness = 'drifted';
      } catch {
        // Temporal health remains useful when the project root cannot be scanned.
      }
    }
    return {
      project: project.name,
      root_path: project.rootPath,
      freshness,
      indexed_at: project.indexedAt,
      node_count: project.nodeCount,
      ...(project.statusError ? { status_error: project.statusError } : {}),
    };
  });
  const locks = listOrphanedLocks();
  const duplicateRoots = findDuplicateProjectRoots(projects);
  const { command, args } = getLynxCommand();
  const runtimeAvailable = fs.existsSync(command) && ((process as NodeJS.Process & { pkg?: unknown }).pkg || fs.existsSync(args[0] || ''));
  const attention = projectHealth.filter((project) => project.freshness !== 'fresh').length + locks.length + duplicateRoots.length;
  const recommendations: string[] = [];
  if (!runtimeAvailable) recommendations.push('Reinstall LYNX so the configured runtime is available.');
  if (locks.length > 0) recommendations.push('Run a normal index; LYNX will safely clear orphaned locks before indexing.');
  if (projectHealth.some((project) => project.freshness === 'stale')) recommendations.push('Re-index stale projects incrementally.');
  if (projectHealth.some((project) => project.freshness === 'drifted')) recommendations.push('Re-index projects whose working tree has drifted from the graph.');
  if (projectHealth.some((project) => project.freshness === 'empty' || project.freshness === 'failed')) recommendations.push('Re-index empty or failed projects before trusting graph results.');
  if (duplicateRoots.length > 0) recommendations.push('Resolve duplicate project aliases that point to the same root so metrics and graph state remain unified.');

  return {
    status: attention === 0 && runtimeAvailable ? 'healthy' as Health : 'attention_needed' as Health,
    runtime: {
      available: runtimeAvailable,
      lynx_home: lynxHome(),
    },
    projects: projectHealth,
    orphaned_locks: locks.map((lock) => ({ project: lock.project, pid: lock.pid, age_ms: lock.ageMs })),
    duplicate_project_roots: duplicateRoots.map((duplicate) => ({ root_path: duplicate.rootPath, projects: duplicate.projects })),
    configuration: {
      enabled: config.enabled,
      stale_threshold_hours: config.stale_threshold_hours,
      mcp_tool_profile: config.mcp_tool_profile,
      agent_response: config.agent_response,
      api_keys_configured: {
        deepseek: Boolean(config.api_keys?.deepseek),
        vps: Boolean(config.api_keys?.vps_url && config.api_keys?.vps_key),
      },
    },
    recommendations,
    local_only: true,
  };
}
