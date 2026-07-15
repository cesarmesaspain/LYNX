/* Agent hook installation and removal adapters. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const HOME = os.homedir();
const STRICT_THRESHOLD = 4;
const CLAUDE_GUIDANCE_START = '<!-- lynx:global:start -->';
const CLAUDE_GUIDANCE_END = '<!-- lynx:global:end -->';

// These operations are strictly read/discovery/analysis. Keep write-capable
// tools (indexing, watching, ADR/traces management and deletion) outside this
// list so the host can still request confirmation for a state change.
const CLAUDE_READ_ONLY_LYNX_TOOLS = [
  'tool_catalog', 'pack_context', 'search_graph', 'trace_path',
  'get_code_snippet', 'get_architecture', 'query_graph', 'index_status',
  'list_projects', 'get_graph_schema', 'search_code', 'detect_changes',
  'assess_impact', 'pack_memory', 'analyze_hotspots', 'find_dead_code',
  'compare_runs', 'explain_symbol', 'smart_review', 'semantic_search',
  'find_tests', 'batch_get_code', 'diagnose', 'usage_summary',
] as const;

function log(msg: string): void { console.log(`  ${msg}`); }
function ensureDir(dir: string): void { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function lynxDiscoveryReminder(): string {
  return [
    'LYNX code discovery guidance:',
    '1. For any analyze, review, explore, or understand-code request, use LYNX before shell/file tools. Start broad work with pack_context(task).',
    '2. If tools are not visible, run tool_search for: lynx pack_context search_graph trace_path get_code_snippet query_graph index_repository.',
    '3. Establish the project with list_projects/index_status; run index_repository automatically if the active project is missing or stale.',
    '4. Use pack_context for broad multi-symbol tasks, search_graph for relationships, trace_path for callers/callees, get_code_snippet for exact source, and query_graph for metrics.',
    '5. Use find_tests when coverage is material to the intended change; use batch_get_code when comparing multiple candidates.',
    '6. Use shell search/read when it is more direct for docs, configs, literals, or when LYNX has no useful result. Reuse evidence and stop when it is sufficient.',
  ].join(' ');
}

/**
 * Index only repositories that explicitly opt into LYNX guidance. This keeps
 * the global user-level hook from indexing arbitrary folders opened in Codex
 * or Claude while still covering projects initialized by `lynx init`.
 */
function sessionStartIndexCommand(): string {
  return 'if [ -f "$PWD/CLAUDE.md" ] || [ -f "$PWD/AGENTS.md" ]; then lynx index "$PWD" --mode fast --incremental; fi';
}

function isLynxCodexSessionStartHook(hook: Record<string, unknown>): boolean {
  const command = String(hook.command || '');
  return command.includes('LYNX code discovery protocol') ||
    command.includes('lynx index "$PWD" --mode fast');
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
    '# New chats must establish LYNX context before exploratory file tools.',
    'rm -f "$HOME/.lynx/session-counter.json"',
    '# Keep the local graph fresh for projects that opt into LYNX guidance.',
    sessionStartIndexCommand(),
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
  // Enforce LYNX-first only for the initial discovery step. The hook releases
  // normal targeted filesystem work as soon as a LYNX tool has been used.
  const strictEnv = 'LYNX_STRICT=1';
  const augmentHookScript = [
    '#!/bin/bash',
    '# lynx-code-discovery-augment — Claude PreToolUse context augmenter.',
    '# Installed by: lynx install' + (strict ? ' --strict' : ''),
    '# LYNX-first: blocks exploratory filesystem tools until this chat uses LYNX.',
    `${strictEnv} ${hookCommandLine} 2>/dev/null`,
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

  registerClaudeReadOnlyLynxPermissions(settingsPath);
  installClaudeGlobalGuidance();
  registerSessionStartHook(settingsPath, sessionHookPath);
  registerPreToolUseAugmentHook(settingsPath, augmentHookPath, strict);
}

/** Keep Claude's global guidance as strong as the enforced PreToolUse guard. */
function installClaudeGlobalGuidance(): void {
  const guidancePath = path.join(HOME, '.claude', 'CLAUDE.md');
  const block = [
    CLAUDE_GUIDANCE_START,
    '## LYNX-first code discovery',
    '',
    'For any request to analyze, review, explore, or understand code, use a LYNX MCP tool before Bash, Read, Grep, or Glob.',
    'For broad work, call `pack_context(task)` first. If no project is resolved, use `list_projects`, then call `pack_context(task, project)`; index the active project locally if missing or stale.',
    'Do not enumerate directories or read every source file as a prelude to discovery. After a compact overview, use get_code_snippet only for the one or two symbols that need verification.',
    CLAUDE_GUIDANCE_END,
    '',
  ].join('\n');
  let current = '';
  try {
    current = fs.existsSync(guidancePath) ? fs.readFileSync(guidancePath, 'utf-8') : '';
  } catch {
    return;
  }
  const start = current.indexOf(CLAUDE_GUIDANCE_START);
  const end = current.indexOf(CLAUDE_GUIDANCE_END);
  const next = start >= 0 && end >= start
    ? current.slice(0, start) + block + current.slice(end + CLAUDE_GUIDANCE_END.length).replace(/^\s*/, '')
    : current.trimEnd() + (current.trim() ? '\n\n' : '') + block;
  if (next === current) return;
  const tmp = guidancePath + '.tmp';
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, guidancePath);
  log(`updated global LYNX-first guidance → ${guidancePath}`);
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
    'matcher = "startup"',
    '',
    '[[hooks.SessionStart.hooks]]',
    'type = "command"',
    `command = ${JSON.stringify(sessionStartIndexCommand())}`,
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
    return !inner.some(isLynxCodexSessionStartHook);
  });
  filtered.push({
    matcher: 'startup',
    hooks: [{ type: 'command', command: sessionStartIndexCommand() }],
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

  const filtered = sessionStart.filter(entry => {
    const inner = (entry.hooks as Array<Record<string, unknown>>) || [];
    return !inner.some(h => (h.command as string || '').includes('lynx-session-start'));
  });

  filtered.push({
    matcher: 'startup',
    hooks: [{ type: 'command', command: hookPath }],
  });

  hooks.SessionStart = filtered;
  settings.hooks = hooks;

  const tmp = settingsPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsPath);
}

/**
 * Claude's permission matcher is host-specific, so we register each safe
 * operation explicitly rather than relying only on a wildcard. This applies
 * at the user level (~/.claude/settings.json), independent of the folder or
 * chat that happens to be open.
 */
function registerClaudeReadOnlyLynxPermissions(settingsPath: string): void {
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      return;
    }
  }

  const permissions = (settings.permissions as Record<string, unknown>) || {};
  const allow = Array.isArray(permissions.allow)
    ? permissions.allow.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const required = CLAUDE_READ_ONLY_LYNX_TOOLS.map((name) => `mcp__lynx__${name}`);
  const missing = required.filter((entry) => !allow.includes(entry));
  if (missing.length === 0) return;

  permissions.allow = [...allow, ...missing];
  settings.permissions = permissions;
  const tmp = settingsPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsPath);
  log(`approved ${missing.length} read-only LYNX tools globally for Claude`);
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
  const matcher = 'Grep|Glob|Read|Bash';
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
    return !inner.some(isLynxCodexSessionStartHook);
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
