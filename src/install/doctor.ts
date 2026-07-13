/*
 * doctor.ts — LYNX diagnostics.
 *
 * Runs 6 checks: binary location, database health, indexed projects,
 * MCP config entries, hooks (if applicable), and license/cloud config.
 * Prints ✓ / ✗ results with exact next commands for each failure.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { detectAgents, getLynxCommand } from './agents.js';
import { hasMcpEntry } from './mcp-config.js';
import type { AgentInfo } from './agents.js';
import { lynxConfigPath, lynxHome, readLynxConfig } from '../config/runtime.js';
import { readLicense } from '../commercial/license.js';
import { verifyMcpServer } from './mcp-verify.js';
import { listOrphanedLocks } from '../store/lock.js';
import { scanIndexedProjects } from '../mcp/project-catalog.js';
import { storedTimestampMs } from '../store/time.js';
import Database from 'better-sqlite3';

const HOME = os.homedir();
const DBS_DIR = path.join(lynxHome(), 'dbs');
const METRICS_DB_PATH = path.join(lynxHome(), 'metrics.db');

interface DoctorCheck {
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

// ── Individual checks ──────────────────────────────────────────────

function checkBinary(): DoctorCheck {
  const { command, args } = getLynxCommand();
  const nodeOk = fs.existsSync(command);
  const cliPath = args[0] || '';
  const cliOk = (process as NodeJS.Process & { pkg?: unknown }).pkg ? nodeOk : fs.existsSync(cliPath);

  if (nodeOk && cliOk) {
    return {
      label: 'LYNX binary',
      ok: true,
      detail: `${command} ${cliPath}`,
    };
  }
  const missing: string[] = [];
  if (!nodeOk) missing.push('node binary');
  if (!cliOk) missing.push(`cli script (${cliPath})`);
  return {
    label: 'LYNX binary',
    ok: false,
    detail: `missing: ${missing.join(', ')}`,
    fix: 'Reinstall LYNX: curl -fsSL https://lynx.dev/install.sh | bash',
  };
}

function checkDatabase(): DoctorCheck {
  const projects = scanIndexedProjects();
  if (projects.length === 0) {
    return {
      label: 'Database directory',
      ok: true,
      detail: `${DBS_DIR} (no indexed projects yet)`,
    };
  }

  // Only report databases registered in their own project metadata. Test and
  // interrupted-run files may exist in this directory but are not projects.
  const parts: string[] = [];
  for (const project of projects) {
    try {
      const st = fs.statSync(path.join(DBS_DIR, `${project.name}.db`));
      const sizeMB = (st.size / (1024 * 1024)).toFixed(1);
      parts.push(`${project.name} (${sizeMB} MB)`);
    } catch {
      parts.push(project.name);
    }
  }
  return {
    label: 'Database',
    ok: true,
    detail: `${projects.length} project(s): ${parts.join(', ')}`,
  };
}

function checkProjects(): DoctorCheck {
  const projects = scanIndexedProjects();
  if (projects.length === 0) {
    return {
      label: 'Indexed projects',
      ok: true,
      detail: '0 (run lynx index or lynx init in a project)',
    };
  }
  return {
    label: 'Indexed projects',
    ok: true,
    detail: `${projects.length} project(s)`,
  };
}

function checkIndexFreshness(): DoctorCheck {
  const projects = scanIndexedProjects();
  if (projects.length === 0) return { label: 'Index freshness', ok: true, detail: 'No projects indexed' };

  const cfg = readLynxConfig();
  let stale = 0;
  let failed = 0;
  let updating = 0;
  let ready = 0;

  for (const project of projects) {
    if (project.status === 'failed') { failed++; continue; }
    if (project.status === 'updating') { updating++; continue; }
    if (project.nodeCount === 0) continue;
    const ageHours = (Date.now() - storedTimestampMs(project.indexedAt)) / (1000 * 60 * 60);
    if (ageHours > cfg.stale_threshold_hours) stale++;
    else ready++;
  }

  const parts: string[] = [];
  if (ready > 0) parts.push(`${ready} fresh`);
  if (stale > 0) parts.push(`${stale} stale (>${cfg.stale_threshold_hours}h)`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (updating > 0) parts.push(`${updating} updating`);
  const detail = parts.length > 0 ? parts.join(', ') : 'No projects indexed';
  const ok = stale === 0 && failed === 0 && updating === 0;

  return {
    label: 'Index freshness',
    ok,
    detail,
    fix: ok ? undefined : 'Re-index stale/failed projects: lynx index <path>',
  };
}

function checkLocks(): DoctorCheck {
  const orphaned = listOrphanedLocks();
  if (orphaned.length === 0) return { label: 'Index locks', ok: true, detail: 'No orphaned locks' };
  const detail = orphaned.map(l => `${l.project} (pid ${l.pid}, ${Math.round(l.ageMs / 1000)}s ago)`).join(', ');
  return {
    label: 'Index locks',
    ok: false,
    detail: `${orphaned.length} orphaned: ${detail}`,
    fix: 'Orphaned locks will be broken automatically on next index. Or delete manually: rm ~/.lynx/locks/*.lock',
  };
}

function checkSnapshots(): DoctorCheck {
  if (!fs.existsSync(METRICS_DB_PATH)) {
    return { label: 'Metrics snapshots', ok: true, detail: 'No metrics DB yet (normal for fresh installs)' };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(METRICS_DB_PATH, { readonly: true });

    // Check daily_snapshots table exists
    const hasSnapshots = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='daily_snapshots'"
    ).get() as { name: string } | undefined);
    if (!hasSnapshots) {
      return { label: 'Metrics snapshots', ok: true, detail: 'No snapshots table (no metrics archived yet)' };
    }

    const hasArchive = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='events_archive'"
    ).get() as { name: string } | undefined);
    if (!hasArchive) {
      return { label: 'Metrics snapshots', ok: true, detail: 'No events_archive table (no metrics archived yet)' };
    }

    // For each project with snapshots, compare total vs events_archive
    const projects = db.prepare('SELECT DISTINCT project FROM daily_snapshots').all() as { project: string }[];
    if (projects.length === 0) {
      return { label: 'Metrics snapshots', ok: true, detail: 'No snapshots (normal for fresh installs)' };
    }

    const clean: string[] = [];
    const corrupt: { project: string; snapTokens: number; archTokens: number; delta: number }[] = [];

    for (const { project } of projects) {
      const snapRow = db.prepare(`
        SELECT COALESCE(SUM(tokens_saved), 0) as tokens, COALESCE(SUM(events_count), 0) as events
        FROM daily_snapshots WHERE project = ?
      `).get(project) as { tokens: number; events: number };

      const archRow = db.prepare(`
        SELECT COALESCE(SUM(tokens_saved), 0) as tokens, COUNT(*) as events
        FROM events_archive WHERE project = ?
      `).get(project) as { tokens: number; events: number };

      const snapTokens = Number(snapRow.tokens || 0);
      const snapEvents = Number(snapRow.events || 0);
      const archTokens = Number(archRow.tokens || 0);
      const archEvents = Number(archRow.events || 0);
      const delta = snapTokens - archTokens;

      // Corruption: snapshots claim more than 10% above events_archive
      if (archEvents === 0 && snapEvents === 0) continue;
      if (archTokens > 0 && delta > archTokens * 0.1 && delta > 100) {
        corrupt.push({ project, snapTokens, archTokens, delta });
      } else if (archEvents === 0 && snapEvents > 0) {
        // snapshots exist but no archive events — legacy-only data
        clean.push(`${project} (legacy-only, ${snapTokens.toLocaleString()} tokens)`);
      } else {
        clean.push(project);
      }
    }

    if (corrupt.length === 0) {
      const detail = clean.length > 0
        ? `${projects.length} project(s) clean: ${clean.join(', ')}`
        : 'No snapshots to check';
      return { label: 'Metrics snapshots', ok: true, detail };
    }

    const corruptDetail = corrupt
      .map(c => `${c.project} (+${c.delta.toLocaleString()} tokens, snap=${c.snapTokens.toLocaleString()} arch=${c.archTokens.toLocaleString()})`)
      .join('; ');
    return {
      label: 'Metrics snapshots',
      ok: false,
      detail: `${corrupt.length}/${projects.length} project(s) corrupt: ${corruptDetail}`,
      fix: 'Rebuild snapshots from events_archive: lynx metrics rebuild',
    };
  } catch (err) {
    return {
      label: 'Metrics snapshots',
      ok: true,
      detail: `Could not check: ${(err as Error).message}`,
    };
  } finally {
    if (db) { try { db.close(); } catch { /* ok */ } }
  }
}

function checkMcpConfigs(agents: AgentInfo[]): DoctorCheck {
  if (agents.length === 0) {
    return {
      label: 'MCP configs',
      ok: false,
      detail: 'no supported agents detected',
      fix: 'Install Claude Code, Codex, or VS Code first',
    };
  }
  const configured: string[] = [];
  const missing: string[] = [];
  for (const a of agents) {
    if (!a.mcpConfigPath || !a.mcpConfigFormat) continue; // no MCP support
    if (hasMcpEntry(a)) {
      configured.push(a.label);
    } else {
      missing.push(a.label);
    }
  }
  if (missing.length === 0) {
    return {
      label: 'MCP configs',
      ok: true,
      detail: `✓ ${configured.join(', ')}`,
    };
  }
  return {
    label: 'MCP configs',
    ok: configured.length > 0,
    detail: `configured: ${configured.join(', ') || 'none'} | missing: ${missing.join(', ')}`,
    fix: 'Run: lynx install',
  };
}

async function checkMcpRuntime(): Promise<DoctorCheck> {
  const { command, args } = getLynxCommand();
  const verification = await verifyMcpServer(command, args);
  if (verification.ok) {
    return { label: 'MCP runtime', ok: true, detail: `${verification.discovered}/${verification.expected} tools available` };
  }
  const detail = `${verification.discovered}/${verification.expected} tools available` +
    (verification.missing.length > 0 ? ` | missing: ${verification.missing.join(', ')}` : '') +
    (verification.error ? ` | ${verification.error}` : '');
  return {
    label: 'MCP runtime',
    ok: false,
    detail,
    fix: 'Run: lynx install',
  };
}

function checkHooks(agents: AgentInfo[]): DoctorCheck {
  const details: string[] = [];
  const missing: string[] = [];

  const claude = agents.find(a => a.key === 'claude-code');
  if (claude) {
    const hooksDir = path.join(HOME, '.claude', 'hooks');
    const sessionHook = path.join(hooksDir, 'lynx-session-start');
    const augmentHook = path.join(hooksDir, 'lynx-code-discovery-augment');
    const settingsPath = path.join(HOME, '.claude', 'settings.json');

    let sessionSettingsOk = false;
    let augmentSettingsOk = false;
    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      sessionSettingsOk = raw.includes('lynx-session-start');
      augmentSettingsOk = raw.includes('lynx-code-discovery-augment') && /Grep\|Glob/.test(raw);
    } catch {
      // settings.json doesn't exist yet — not an error
    }

    const sessionHookExists = fs.existsSync(sessionHook);
    const augmentHookExists = fs.existsSync(augmentHook);
    if (sessionHookExists && sessionSettingsOk) {
      details.push('Claude SessionStart ✓');
    } else {
      if (!sessionHookExists) missing.push('Claude SessionStart script');
      if (!sessionSettingsOk) missing.push('Claude SessionStart settings');
    }

    if (augmentHookExists && augmentSettingsOk) {
      details.push('Claude PreToolUse ✓');
    } else {
      if (!augmentHookExists) missing.push('Claude PreToolUse script');
      if (!augmentSettingsOk) missing.push('Claude PreToolUse settings');
    }
  }

  const codex = agents.find(a => a.key === 'codex');
  if (codex) {
    const hooksJsonPath = path.join(codex.configDir, 'hooks.json');
    const configPath = path.join(codex.configDir, 'config.toml');
    let codexOk = false;
    try {
      if (fs.existsSync(hooksJsonPath)) {
        codexOk = fs.readFileSync(hooksJsonPath, 'utf-8').includes('LYNX code discovery protocol');
      } else {
        codexOk = fs.readFileSync(configPath, 'utf-8').includes('# >>> lynx SessionStart >>>');
      }
    } catch {
      // config missing
    }
    if (codexOk) details.push('Codex SessionStart ✓');
    else missing.push('Codex SessionStart');
  }

  const gemini = agents.find(a => a.key === 'gemini');
  if (gemini) {
    const gSettingsPath = path.join(gemini.configDir, 'settings.json');
    let gSessionOk = false;
    let gBeforeToolOk = false;
    try {
      const raw = fs.readFileSync(gSettingsPath, 'utf-8');
      gSessionOk = raw.includes('LYNX code discovery protocol');
      gBeforeToolOk = raw.includes('LYNX Code Intelligence') && raw.includes('Prefer MCP graph tools');
    } catch {
      // settings.json doesn't exist
    }
    if (gSessionOk && gBeforeToolOk) details.push('Gemini SessionStart+BeforeTool ✓');
    else {
      if (!gSessionOk) missing.push('Gemini SessionStart');
      if (!gBeforeToolOk) missing.push('Gemini BeforeTool');
    }
  }

  const antigravity = agents.find(a => a.key === 'antigravity');
  if (antigravity) {
    const agSettingsPath = path.join(antigravity.configDir, 'settings.json');
    let agOk = false;
    try {
      agOk = fs.readFileSync(agSettingsPath, 'utf-8').includes('LYNX code discovery protocol');
    } catch {
      // settings.json doesn't exist
    }
    if (agOk) details.push('Antigravity SessionStart ✓');
    else missing.push('Antigravity SessionStart');
  }

  if (!claude && !codex && !gemini && !antigravity) {
    return {
      label: 'Agent hooks',
      ok: true,
      detail: 'N/A (no hook-capable agent detected)',
    };
  }

  if (missing.length === 0) {
    return {
      label: 'Agent hooks',
      ok: true,
      detail: details.join(', '),
    };
  }

  return {
    label: 'Agent hooks',
    ok: false,
    detail: `configured: ${details.join(', ') || 'none'} | missing: ${missing.join(', ')}`,
    fix: 'Run: lynx install',
  };
}

function checkRuntimeConfig(): DoctorCheck {
  const cfg = readLynxConfig();
  return {
    label: 'Runtime config',
    ok: true,
    detail: `${lynxConfigPath()} auto_index=${cfg.auto_index}, auto_index_limit=${cfg.auto_index_limit}, auto_watch=${cfg.auto_watch}, auto_dashboard=${cfg.auto_dashboard}`,
  };
}

function checkLicense(): DoctorCheck {
  const license = readLicense();

  if (!license) {
    return {
      label: 'License',
      ok: true,
      detail: 'Free tier (no license). Run: lynx license activate <key> to upgrade.',
    };
  }

  const exp = license.expiresAt.getTime()
    ? license.expiresAt.toISOString().slice(0, 10)
    : 'unknown';
  const status = license.isValid ? 'active' : 'expired/invalid (degraded to Free)';

  return {
    label: 'License',
    ok: license.isValid,
    detail: `${license.tier.toUpperCase()} — ${status} — expires ${exp}`,
    fix: !license.isValid ? 'Run: lynx license refresh' : undefined,
  };
}

// ── Main ───────────────────────────────────────────────────────────

export async function runDoctor(): Promise<void> {
  console.log('LYNX doctor\n');

  const agents = detectAgents();
  const checks: DoctorCheck[] = [
    checkBinary(),
    checkDatabase(),
    checkProjects(),
    checkIndexFreshness(),
    checkLocks(),
    checkSnapshots(),
    checkMcpConfigs(agents),
    checkHooks(agents),
    checkRuntimeConfig(),
    checkLicense(),
  ];
  checks.splice(6, 0, await checkMcpRuntime());

  let okCount = 0;
  const failed: DoctorCheck[] = [];

  for (const check of checks) {
    const icon = check.ok ? '✓' : '✗';
    console.log(`  ${icon} ${check.label}: ${check.detail}`);
    if (check.ok) {
      okCount++;
    } else {
      failed.push(check);
    }
  }

  console.log(`\n${okCount}/${checks.length} checks passed.`);

  if (failed.length > 0) {
    console.log('\nFixes:');
    for (const f of failed) {
      if (f.fix) {
        console.log(`  ✗ ${f.label}: ${f.fix}`);
      }
    }
  }
}
