/* Agent hook installation and removal adapters. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const HOME = os.homedir();
const STRICT_THRESHOLD = 4;

function log(msg: string): void { console.log(`  ${msg}`); }
function ensureDir(dir: string): void { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function lynxDiscoveryReminder(): string {
  return [
    'LYNX code discovery guidance:',
    '1. Choose the smallest relevant tool set that can provide sufficient evidence.',
    '2. If tools are not visible, run tool_search for: lynx pack_context search_graph trace_path get_code_snippet query_graph index_repository.',
    '3. Establish the project with list_projects/index_status; run index_repository if missing or stale.',
    '4. Use pack_context for broad multi-symbol tasks, search_graph for relationships, trace_path for callers/callees, get_code_snippet for exact source, and query_graph for metrics.',
    '5. Use find_tests when coverage is material to the intended change; use batch_get_code when comparing multiple candidates.',
    '6. Use shell search/read when it is more direct for docs, configs, literals, or when LYNX has no useful result. Reuse evidence and stop when it is sufficient.',
  ].join(' ');
}

// ── Hooks (Claude Code) ────────────────────────────────────────────

function hooksDir(): string {
  return path.join(HOME, '.claude', 'hooks');
}

export function installClaudeHooks(command: string, args: string[], dryRun: boolean, strict: boolean): void {
  const dir = hooksDir();
  const sessionHookPath = path.join(dir, 'lynx-session-start');
  const augmentHookPath = path.join(dir, 'lynx-code-discovery-augment');
  const hookAlreadyExists = fs.existsSync(sessionHookPath);
  const augmentAlreadyExists = fs.existsSync(augmentHookPath);

  if (dryRun) {
    log(hookAlreadyExists
      ? 'would update SessionStart hook'
      : `would install SessionStart hook → ${sessionHookPath}`);
    log(augmentAlreadyExists
      ? 'would update PreToolUse augment hook (Grep|Glob)'
      : `would install PreToolUse augment hook → ${augmentHookPath}`);
    log(`would register hooks in ~/.claude/settings.json`);
    return;
  }

  ensureDir(dir);

  const sessionHookScript = [
    '#!/bin/bash',
    '# lynx-session-start — SessionStart hook for LYNX MCP awareness.',
    '# Installed by: lynx install',
    'cat << \'REMINDER\'',
    'LYNX Code Intelligence is active.',
    '',
    'Code discovery guidance:',
    '1. Choose the smallest relevant tool set that can provide sufficient evidence',
    '2. pack_context(task, project?) -- broad tasks spanning several symbols or files',
    '3. search_graph -- find structural relationships by name, kind, or pattern',
    '4. trace_path -- trace callers, callees, or data flow when needed',
    '5. query_graph -- Cypher queries for metrics and cross-cutting relationships',
    '6. get_code_snippet -- read exact symbol source',
    '7. batch_get_code -- compare multiple known symbols in one call',
    '8. find_tests -- inspect coverage when it is material to the intended change',
    '9. semantic_search -- natural-language code search',
    '10. explain_symbol / smart_review -- deeper analysis when the task requires it',
    '',
    'Use grep/glob/read when they are more direct for text, config, literals, or unsupported cases.',
    'If the project is not indexed or stale, use index_repository. Reuse evidence and stop when sufficient.',
    'REMINDER',
  ].join('\n');

  const hookCommandLine = shellCommand(command, hookArgs(args, 'hook-augment'));
  const strictEnv = strict ? 'LYNX_STRICT=1' : '';
  const augmentHookScript = [
    '#!/bin/bash',
    '# lynx-code-discovery-augment — Claude PreToolUse context augmenter.',
    '# Installed by: lynx install' + (strict ? ' --strict' : ''),
    strict ? '# STRICT MODE: blocks non-LYNX tools after ' + STRICT_THRESHOLD + ' consecutive uses.' : '# Non-blocking by design: failures must never stop Grep/Glob.',
    strict ? `${strictEnv} ${hookCommandLine} 2>/dev/null` : `${hookCommandLine} 2>/dev/null`,
    'exit 0',
  ].join('\n');

  const settingsPath = path.join(HOME, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    fs.copyFileSync(settingsPath, settingsPath + '.lynx-bak');
  }

  fs.writeFileSync(sessionHookPath, sessionHookScript);
  fs.chmodSync(sessionHookPath, 0o755);
  log(`created ${sessionHookPath}`);

  fs.writeFileSync(augmentHookPath, augmentHookScript);
  fs.chmodSync(augmentHookPath, 0o755);
  log(`created ${augmentHookPath}`);

  registerSessionStartHook(settingsPath, sessionHookPath);
  registerPreToolUseAugmentHook(settingsPath, augmentHookPath, strict);
}

function hookArgs(args: string[], commandName: string): string[] {
  if (args.length > 0 && args[args.length - 1] === 'serve') {
    return [...args.slice(0, -1), commandName];
  }
  return [...args, commandName];
}

function shellCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ── Hooks (Gemini CLI) ─────────────────────────────────────────────

function geminiSettingsPath(configDir: string): string {
  return path.join(configDir, 'settings.json');
}

export function installGeminiHooks(configDir: string, dryRun: boolean): void {
  const settingsPath = geminiSettingsPath(configDir);
  const hasSessionStart = hookSettingExists(settingsPath, 'SessionStart', 'LYNX code discovery protocol');
  const hasBeforeTool = hookSettingExists(settingsPath, 'BeforeTool', 'LYNX Code Intelligence');

  if (dryRun) {
    log(hasSessionStart
      ? 'would refresh Gemini SessionStart hook'
      : 'would install Gemini SessionStart hook');
    log(hasBeforeTool
      ? 'would refresh Gemini BeforeTool hook'
      : 'would install Gemini BeforeTool hook');
    return;
  }

  ensureDir(configDir);
  if (fs.existsSync(settingsPath)) {
    fs.copyFileSync(settingsPath, settingsPath + '.lynx-bak');
  }

  upsertEchoHook(settingsPath, 'SessionStart', 'startup|resume|clear|compact',
    `echo ${JSON.stringify(lynxDiscoveryReminder())}`);
  upsertEchoHook(settingsPath, 'BeforeTool', '',
    `echo ${JSON.stringify('LYNX Code Intelligence is active. Prefer MCP graph tools.')}`);

  log(hasSessionStart
    ? 'refreshed Gemini SessionStart hook'
    : 'installed Gemini SessionStart hook');
  log(hasBeforeTool
    ? 'refreshed Gemini BeforeTool hook'
    : 'installed Gemini BeforeTool hook');
}

export function removeGeminiHooks(configDir: string, dryRun: boolean): void {
  removeEchoHooksFromSettings(geminiSettingsPath(configDir), dryRun, 'Gemini');
}

// ── Hooks (Antigravity) ────────────────────────────────────────────

function antigravitySettingsPath(configDir: string): string {
  return path.join(configDir, 'settings.json');
}

export function installAntigravityHooks(configDir: string, dryRun: boolean): void {
  const settingsPath = antigravitySettingsPath(configDir);
  const hasSessionStart = hookSettingExists(settingsPath, 'SessionStart', 'LYNX code discovery protocol');

  if (dryRun) {
    log(hasSessionStart
      ? 'would refresh Antigravity SessionStart hook'
      : 'would install Antigravity SessionStart hook');
    return;
  }

  ensureDir(configDir);
  if (fs.existsSync(settingsPath)) {
    fs.copyFileSync(settingsPath, settingsPath + '.lynx-bak');
  }

  upsertEchoHook(settingsPath, 'SessionStart', 'startup|resume|clear|compact',
    `echo ${JSON.stringify(lynxDiscoveryReminder())}`);

  log(hasSessionStart
    ? 'refreshed Antigravity SessionStart hook'
    : 'installed Antigravity SessionStart hook');
}

export function removeAntigravityHooks(configDir: string, dryRun: boolean): void {
  removeEchoHooksFromSettings(antigravitySettingsPath(configDir), dryRun, 'Antigravity');
}

// ── Hook helpers (settings.json echo-command hooks) ────────────────

function hookSettingExists(settingsPath: string, hookType: string, marker: string): boolean {
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const hooks = (settings.hooks as Record<string, unknown>) || {};
    const entries = Array.isArray(hooks[hookType]) ? hooks[hookType] as Array<Record<string, unknown>> : [];
    return entries.some(entry => {
      const inner = Array.isArray(entry.hooks) ? entry.hooks as Array<Record<string, unknown>> : [];
      return inner.some(h => String(h.command || '').includes(marker));
    });
  } catch {
    return false;
  }
}

function upsertEchoHook(settingsPath: string, hookType: string, matcher: string, commandStr: string): void {
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      // corrupt — start fresh
    }
  }

  const hooks = (settings.hooks as Record<string, unknown>) || {};
  const entries = Array.isArray(hooks[hookType])
    ? (hooks[hookType] as Array<Record<string, unknown>>).map(e => ({ ...e }))
    : [];

  // Remove any existing LYNX entry of this type
  const filtered = entries.filter(entry => {
    const inner = Array.isArray(entry.hooks) ? entry.hooks as Array<Record<string, unknown>> : [];
    return !inner.some(h => String(h.command || '').includes('LYNX'));
  });

  filtered.push({ matcher, hooks: [{ type: 'command', command: commandStr }] });
  hooks[hookType] = filtered;
  settings.hooks = hooks;

  const tmp = settingsPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsPath);
}

function removeEchoHooksFromSettings(settingsPath: string, dryRun: boolean, label: string): void {
  if (!fs.existsSync(settingsPath)) {
    if (dryRun) log(`would skip ${label} hooks (no settings.json)`);
    return;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return;
  }

  const hooks = (settings.hooks as Record<string, unknown>) || {};
  let removed = false;

  for (const hookType of ['SessionStart', 'BeforeTool', 'PreToolUse']) {
    const entries = Array.isArray(hooks[hookType])
      ? hooks[hookType] as Array<Record<string, unknown>>
      : [];
    const filtered = entries.filter(entry => {
      const inner = Array.isArray(entry.hooks) ? entry.hooks as Array<Record<string, unknown>> : [];
      return !inner.some(h => String(h.command || '').includes('LYNX'));
    });
    if (filtered.length !== entries.length) {
      removed = true;
      if (filtered.length === 0) {
        delete hooks[hookType];
      } else {
        hooks[hookType] = filtered;
      }
    }
  }

  if (!removed) {
    if (dryRun) log(`would skip ${label} hooks (no lynx entries)`);
    return;
  }

  if (dryRun) {
    log(`would remove ${label} hooks from ${settingsPath}`);
    return;
  }

  settings.hooks = hooks;
  const tmp = settingsPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsPath);
  log(`removed ${label} hooks from ${settingsPath}`);
}

// ── Hooks (Codex) ──────────────────────────────────────────────────

const CODEX_HOOK_START = '# >>> lynx SessionStart >>>';
const CODEX_HOOK_END = '# <<< lynx SessionStart <<<';

function codexHookBlock(): string {
  return [
    CODEX_HOOK_START,
    '[[hooks.SessionStart]]',
    'matcher = "startup|resume|clear|compact"',
    '',
    '[[hooks.SessionStart.hooks]]',
    'type = "command"',
    `command = ${JSON.stringify(`echo ${JSON.stringify(lynxDiscoveryReminder())}`)}`,
    CODEX_HOOK_END,
    '',
  ].join('\n');
}

export function installCodexHook(configDir: string, dryRun: boolean): void {
  const hooksJsonPath = path.join(configDir, 'hooks.json');
  if (fs.existsSync(hooksJsonPath)) {
    installCodexHooksJson(hooksJsonPath, dryRun);
    return;
  }

  const configPath = path.join(configDir, 'config.toml');
  const block = codexHookBlock();
  const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';
  const hasBlock = current.includes(CODEX_HOOK_START) && current.includes(CODEX_HOOK_END);

  if (dryRun) {
    log(hasBlock
      ? `would update Codex SessionStart hook in ${configPath}`
      : `would install Codex SessionStart hook → ${configPath}`);
    return;
  }

  ensureDir(configDir);
  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, configPath + '.lynx-bak');
  }

  const next = hasBlock
    ? current.slice(0, current.indexOf(CODEX_HOOK_START)).trimEnd() + '\n\n' +
      block +
      current.slice(current.indexOf(CODEX_HOOK_END) + CODEX_HOOK_END.length).trimStart()
    : current.trimEnd() + '\n\n' + block;

  const tmp = configPath + '.tmp';
  fs.writeFileSync(tmp, next.endsWith('\n') ? next : next + '\n');
  fs.renameSync(tmp, configPath);
  log(hasBlock
    ? `updated Codex SessionStart hook in ${configPath}`
    : `installed Codex SessionStart hook → ${configPath}`);
}

function codexReminderCommand(): string {
  return `echo ${JSON.stringify(lynxDiscoveryReminder())}`;
}

function installCodexHooksJson(hooksPath: string, dryRun: boolean): void {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(hooksPath)) {
    try {
      config = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }

  const hooks = (config.hooks as Record<string, unknown>) || {};
  const entries = Array.isArray(hooks.SessionStart)
    ? hooks.SessionStart as Array<Record<string, unknown>>
    : [];
  const filtered = entries.filter((entry) => {
    const inner = Array.isArray(entry.hooks) ? entry.hooks as Array<Record<string, unknown>> : [];
    return !inner.some((hook) => String(hook.command || '').includes('LYNX code discovery protocol'));
  });
  filtered.push({
    matcher: 'startup|resume|clear|compact',
    hooks: [{ type: 'command', command: codexReminderCommand() }],
  });
  hooks.SessionStart = filtered;
  config.hooks = hooks;

  if (dryRun) {
    log(`would install Codex SessionStart hook → ${hooksPath}`);
    return;
  }

  fs.copyFileSync(hooksPath, hooksPath + '.lynx-bak');
  const tmp = hooksPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, hooksPath);
  log(`installed Codex SessionStart hook → ${hooksPath}`);
}

function registerSessionStartHook(settingsPath: string, hookPath: string): void {
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      return;
    }
  }

  const hooks = (settings.hooks as Record<string, unknown>) || {};
  const sessionStart = (hooks.SessionStart as Array<Record<string, unknown>>) || [];

  const alreadyRegistered = sessionStart.some(entry => {
    const inner = (entry.hooks as Array<Record<string, unknown>>) || [];
    return inner.some(h => (h.command as string || '').includes('lynx-session-start'));
  });
  if (alreadyRegistered) return;

  const matchers = ['startup', 'resume', 'clear', 'compact'];
  for (const m of matchers) {
    sessionStart.push({
      matcher: m,
      hooks: [{ type: 'command', command: hookPath }],
    });
  }

  hooks.SessionStart = sessionStart;
  settings.hooks = hooks;

  const tmp = settingsPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsPath);
}

function registerPreToolUseAugmentHook(settingsPath: string, hookPath: string, strict: boolean): void {
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      return;
    }
  }

  const hooks = (settings.hooks as Record<string, unknown>) || {};
  const preToolUse = Array.isArray(hooks.PreToolUse)
    ? hooks.PreToolUse as Array<Record<string, unknown>>
    : [];

  const filtered = preToolUse.filter((entry) => {
    const inner = Array.isArray(entry.hooks) ? entry.hooks as Array<Record<string, unknown>> : [];
    return !inner.some((h) => String(h.command || '').includes('lynx-code-discovery-augment'));
  });

  // Strict mode: also intercept Bash to catch grep/find inside bash commands
  const matcher = strict ? 'Grep|Glob|Read|Bash' : 'Grep|Glob|Read';
  const hookEntry: Record<string, unknown> = {
    matcher,
    hooks: [{ type: 'command', command: hookPath, timeout: 5 }],
  };

  filtered.push(hookEntry);

  hooks.PreToolUse = filtered;
  settings.hooks = hooks;

  const tmp = settingsPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsPath);
}

export function removeClaudeHooks(dryRun: boolean): void {
  const dir = hooksDir();
  const sessionHookPath = path.join(dir, 'lynx-session-start');
  const augmentHookPath = path.join(dir, 'lynx-code-discovery-augment');

  for (const hookPath of [sessionHookPath, augmentHookPath]) {
    if (!fs.existsSync(hookPath)) continue;
    if (dryRun) {
      log(`would remove ${hookPath}`);
    } else {
      fs.unlinkSync(hookPath);
      log(`removed ${hookPath}`);
    }
  }

  const settingsPath = path.join(HOME, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) return;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return;
  }

  const hooks = (settings.hooks as Record<string, unknown>) || {};
  const sessionStart = (hooks.SessionStart as Array<Record<string, unknown>>) || [];
  const preToolUse = (hooks.PreToolUse as Array<Record<string, unknown>>) || [];

  const filtered = sessionStart.filter(entry => {
    const inner = (entry.hooks as Array<Record<string, unknown>>) || [];
    return !inner.some(h => (h.command as string || '').includes('lynx-session-start'));
  });
  const filteredPreToolUse = preToolUse.filter(entry => {
    const inner = (entry.hooks as Array<Record<string, unknown>>) || [];
    return !inner.some(h => (h.command as string || '').includes('lynx-code-discovery-augment'));
  });

  if (filtered.length === sessionStart.length && filteredPreToolUse.length === preToolUse.length) {
    if (dryRun) {
      log(`would skip settings.json (no lynx hook entries)`);
    }
    return;
  }

  if (dryRun) {
    log(`would remove lynx hooks from ${settingsPath}`);
    return;
  }

  if (filtered.length === 0) {
    delete hooks.SessionStart;
  } else {
    hooks.SessionStart = filtered;
  }
  if (filteredPreToolUse.length === 0) {
    delete hooks.PreToolUse;
  } else {
    hooks.PreToolUse = filteredPreToolUse;
  }
  settings.hooks = hooks;

  const tmp = settingsPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsPath);
  log(`removed lynx hook entries from ${settingsPath}`);
}

export function removeCodexHook(configDir: string, dryRun: boolean): void {
  const hooksJsonPath = path.join(configDir, 'hooks.json');
  if (fs.existsSync(hooksJsonPath)) {
    removeCodexHooksJson(hooksJsonPath, dryRun);
  }

  const configPath = path.join(configDir, 'config.toml');
  if (!fs.existsSync(configPath)) {
    if (dryRun) log(`would skip Codex hook (no ${configPath})`);
    return;
  }

  const current = fs.readFileSync(configPath, 'utf-8');
  const start = current.indexOf(CODEX_HOOK_START);
  const end = current.indexOf(CODEX_HOOK_END);

  if (start === -1 || end === -1) {
    if (dryRun) log(`would skip Codex hook (no lynx block in ${configPath})`);
    return;
  }

  if (dryRun) {
    log(`would remove Codex SessionStart hook from ${configPath}`);
    return;
  }

  fs.copyFileSync(configPath, configPath + '.lynx-bak');
  const next = current.slice(0, start).trimEnd() + '\n\n' +
    current.slice(end + CODEX_HOOK_END.length).trimStart();
  const tmp = configPath + '.tmp';
  fs.writeFileSync(tmp, next.endsWith('\n') ? next : next + '\n');
  fs.renameSync(tmp, configPath);
  log(`removed Codex SessionStart hook from ${configPath}`);
}

function removeCodexHooksJson(hooksPath: string, dryRun: boolean): void {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return;
  }

  const hooks = (config.hooks as Record<string, unknown>) || {};
  const entries = Array.isArray(hooks.SessionStart)
    ? hooks.SessionStart as Array<Record<string, unknown>>
    : [];
  const filtered = entries.filter((entry) => {
    const inner = Array.isArray(entry.hooks) ? entry.hooks as Array<Record<string, unknown>> : [];
    return !inner.some((hook) => String(hook.command || '').includes('LYNX code discovery protocol'));
  });

  if (filtered.length === entries.length) {
    if (dryRun) log(`would skip Codex hooks.json (no lynx hook in ${hooksPath})`);
    return;
  }
  if (dryRun) {
    log(`would remove Codex SessionStart hook from ${hooksPath}`);
    return;
  }

  fs.copyFileSync(hooksPath, hooksPath + '.lynx-bak');
  if (filtered.length === 0) delete hooks.SessionStart;
  else hooks.SessionStart = filtered;
  config.hooks = hooks;
  const tmp = hooksPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, hooksPath);
  log(`removed Codex SessionStart hook from ${hooksPath}`);
}

