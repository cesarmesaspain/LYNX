/*
 * mcp-config.ts — Safe MCP config writers for all agent formats.
 *
 * Each writer: reads existing config → merges the "lynx" entry →
 * writes back atomically (temp file + rename). Never overwrites
 * existing entries. Backs up the original before writing.
 * Validates paths stay within expected config directories.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentInfo } from './agents.js';
import { READ_ONLY_TOOL_NAMES } from '../mcp/tools.js';

const LYNX_ENTRY_KEY = 'lynx';
const ALLOWED_ROOTS = [path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.codex'), path.join(os.homedir(), '.cursor'), path.join(os.homedir(), '.gemini'), path.join(os.homedir(), '.config'), path.join(os.homedir(), 'Library'), path.join(os.homedir(), '.vscode'), path.join(os.homedir(), '.zed'), path.join(os.homedir(), '.aider'), path.join(os.homedir(), '.kilocode'), path.join(os.homedir(), '.openclaw'), path.join(os.homedir(), '.antigravity')];

// ── Helpers ─────────────────────────────────────────────────────────

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function validatePath(filePath: string): void {
  const resolved = path.resolve(filePath);
  const allowed = ALLOWED_ROOTS.some(root => {
    const rel = path.relative(root, resolved);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!allowed) {
    throw new Error(`Refusing to write outside config directories: ${filePath}`);
  }
}

function backupFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const backupPath = filePath + '.lynx-bak';
  fs.copyFileSync(filePath, backupPath);
  // Verify backup is valid
  const original = fs.readFileSync(filePath);
  const backup = fs.readFileSync(backupPath);
  if (original.length !== backup.length) {
    fs.unlinkSync(backupPath);
    throw new Error(`Backup verification failed for ${filePath}`);
  }
}

function guardMcp(agent: AgentInfo): string | null {
  if (!agent.mcpConfigPath || !agent.mcpConfigFormat) {
    return null; // agent has no MCP support, skip silently
  }
  return agent.mcpConfigPath;
}

// ── JSON writers ───────────────────────────────────────────────────

function readJson(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(filePath: string, data: Record<string, unknown>): void {
  validatePath(filePath);
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  // Verify the JSON we just wrote is parseable
  JSON.parse(fs.readFileSync(tmp, 'utf-8'));
  fs.renameSync(tmp, filePath);
}

function mcpEntryFromCommand(command: string, args: string[]): Record<string, unknown> {
  const entry: Record<string, unknown> = { command };
  if (args.length > 0) entry.args = args;
  return entry;
}

function writeJsonMcp(agent: AgentInfo, command: string, args: string[], dryRun: boolean): string {
  const configPath = guardMcp(agent);
  if (!configPath) return `skipped (no MCP support for ${agent.label})`;

  const config = readJson(configPath);
  const serverKey = agent.mcpKey!;

  const servers = (config[serverKey] as Record<string, unknown>) || {};

  if (servers[LYNX_ENTRY_KEY]) {
    const existing = typeof servers[LYNX_ENTRY_KEY] === 'object' && servers[LYNX_ENTRY_KEY] !== null
      ? { ...(servers[LYNX_ENTRY_KEY] as Record<string, unknown>) }
      : {};
    const refreshed = { ...existing, ...mcpEntryFromCommand(command, args) };
    delete refreshed.cwd;

    if (dryRun) {
      return `would refresh lynx → ${configPath} (${agent.mcpConfigFormat})`;
    }

    backupFile(configPath);
    servers[LYNX_ENTRY_KEY] = refreshed;
    config[serverKey] = servers;
    writeJson(configPath, config);
    return `refreshed lynx → ${configPath}`;
  }

  const newEntry = mcpEntryFromCommand(command, args);

  if (dryRun) {
    return `would add lynx → ${configPath} (${agent.mcpConfigFormat})`;
  }

  backupFile(configPath);
  servers[LYNX_ENTRY_KEY] = newEntry;
  config[serverKey] = servers;
  writeJson(configPath, config);
  return `added lynx → ${configPath}`;
}

// ── TOML writer (Codex) ────────────────────────────────────────────

function readTomlText(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

function tomLine(key: string, value: string): string {
  return `${key} = ${value}\n`;
}

function writeTomlMcp(agent: AgentInfo, command: string, args: string[], dryRun: boolean): string {
  const configPath = guardMcp(agent);
  if (!configPath) return `skipped (no MCP support for ${agent.label})`;

  let content = readTomlText(configPath);
  const sectionHeader = `[${agent.mcpKey}.${LYNX_ENTRY_KEY}]`;

  if (content.includes(sectionHeader)) {
    if (dryRun) {
      return `would refresh lynx → ${configPath} (${agent.mcpConfigFormat})`;
    }

    backupFile(configPath);
    const refreshed = refreshTomlSection(content, sectionHeader, command, args);
    const newContent = ensureCodexReadOnlyToolApprovals(refreshed);
    validatePath(configPath);
    ensureDir(path.dirname(configPath));
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, newContent);
    fs.renameSync(tmp, configPath);
    return `refreshed lynx → ${configPath}`;
  }

  const lines: string[] = [];
  lines.push(`\n${sectionHeader}\n`);
  lines.push(tomLine('command', JSON.stringify(command)));
  if (args.length > 0) {
    lines.push(tomLine('args', JSON.stringify(args)));
  }

  if (dryRun) {
    return `would add lynx → ${configPath} (${agent.mcpConfigFormat})`;
  }

  backupFile(configPath);
  const newContent = ensureCodexReadOnlyToolApprovals(content.trimEnd() + '\n' + lines.join(''));
  validatePath(configPath);
  ensureDir(path.dirname(configPath));
  const tmp = configPath + '.tmp';
  fs.writeFileSync(tmp, newContent);
  fs.renameSync(tmp, configPath);
  return `added lynx → ${configPath}`;
}

/**
 * Codex supports a per-MCP-tool approval policy. Populate every LYNX
 * discovery/read operation explicitly, rather than assuming a client-wide
 * default or a short hand-maintained subset. Write-capable tools remain
 * absent, so they retain Codex's normal confirmation flow.
 */
function ensureCodexReadOnlyToolApprovals(content: string): string {
  let next = content.trimEnd() + '\n';
  for (const toolName of READ_ONLY_TOOL_NAMES) {
    const section = `[mcp_servers.${LYNX_ENTRY_KEY}.tools.${toolName}]`;
    if (next.includes(section)) continue;
    next += `\n${section}\napproval_mode = "approve"\n`;
  }
  return next;
}

function refreshTomlSection(content: string, sectionHeader: string, command: string, args: string[]): string {
  const start = content.indexOf(sectionHeader);
  if (start === -1) return content;

  const bodyStart = start + sectionHeader.length;
  const after = content.slice(bodyStart);
  const nextSectionOffset = after.search(/\n\[/);
  const sectionEnd = nextSectionOffset === -1 ? content.length : bodyStart + nextSectionOffset;

  const before = content.slice(0, start);
  const body = content.slice(bodyStart, sectionEnd);
  const rest = content.slice(sectionEnd);

  const preserved = body
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 &&
        !trimmed.startsWith('command ') &&
        !trimmed.startsWith('command=') &&
        !trimmed.startsWith('args ') &&
        !trimmed.startsWith('args=') &&
        !trimmed.startsWith('cwd ') &&
        !trimmed.startsWith('cwd=');
    });

  const lines = [
    sectionHeader,
    tomLine('command', JSON.stringify(command)).trimEnd(),
    ...(args.length > 0 ? [tomLine('args', JSON.stringify(args)).trimEnd()] : []),
    ...preserved,
  ];

  return before.trimEnd() + '\n\n' + lines.join('\n') + rest;
}

// ── OpenCode writer ────────────────────────────────────────────────
//
// Format: { "mcp": { "lynx": { "enabled": true, "type": "local",
//           "command": ["node", "cli.js", "serve"] } } }
// The command key is an array, not a string.

function writeOpenCodeMcp(agent: AgentInfo, command: string, args: string[], dryRun: boolean): string {
  const configPath = guardMcp(agent);
  if (!configPath) return `skipped (no MCP support for ${agent.label})`;

  const config = readJson(configPath);
  const mcpSection = (config.mcp as Record<string, unknown>) || {};

  const cmdArray = [command, ...args];
  const entry: Record<string, unknown> = {
    enabled: true,
    type: 'local',
    command: cmdArray,
  };

  if (mcpSection[LYNX_ENTRY_KEY]) {
    if (dryRun) {
      return `would refresh lynx → ${configPath} (opencode-json)`;
    }
    backupFile(configPath);
    // Preserve any extra keys from existing entry
    const existing = typeof mcpSection[LYNX_ENTRY_KEY] === 'object' && mcpSection[LYNX_ENTRY_KEY] !== null
      ? { ...(mcpSection[LYNX_ENTRY_KEY] as Record<string, unknown>) }
      : {};
    const merged = { ...existing, ...entry, command: cmdArray };
    mcpSection[LYNX_ENTRY_KEY] = merged;
    config.mcp = mcpSection;
    writeJson(configPath, config);
    return `refreshed lynx → ${configPath}`;
  }

  if (dryRun) {
    return `would add lynx → ${configPath} (opencode-json)`;
  }

  backupFile(configPath);
  mcpSection[LYNX_ENTRY_KEY] = entry;
  config.mcp = mcpSection;
  writeJson(configPath, config);
  return `added lynx → ${configPath}`;
}

// ── OpenClaw writer ────────────────────────────────────────────────
//
// Format: { "mcp": { "servers": { "lynx": { "enabled": true,
//           "command": "node", "args": ["cli.js", "serve"] } } } }
// Uses a nested mcp.servers structure.

function writeOpenClawMcp(agent: AgentInfo, command: string, args: string[], dryRun: boolean): string {
  const configPath = guardMcp(agent);
  if (!configPath) return `skipped (no MCP support for ${agent.label})`;

  const config = readJson(configPath);
  const mcpSection = (config.mcp as Record<string, unknown>) || {};
  const servers = (mcpSection.servers as Record<string, unknown>) || {};

  const entry: Record<string, unknown> = {
    enabled: true,
    command,
  };
  if (args.length > 0) entry.args = args;

  if (servers[LYNX_ENTRY_KEY]) {
    if (dryRun) {
      return `would refresh lynx → ${configPath} (opencode-json)`;
    }
    backupFile(configPath);
    const existing = typeof servers[LYNX_ENTRY_KEY] === 'object' && servers[LYNX_ENTRY_KEY] !== null
      ? { ...(servers[LYNX_ENTRY_KEY] as Record<string, unknown>) }
      : {};
    const merged = { ...existing, ...entry };
    servers[LYNX_ENTRY_KEY] = merged;
    mcpSection.servers = servers;
    config.mcp = mcpSection;
    writeJson(configPath, config);
    return `refreshed lynx → ${configPath}`;
  }

  if (dryRun) {
    return `would add lynx → ${configPath} (opencode-json)`;
  }

  backupFile(configPath);
  servers[LYNX_ENTRY_KEY] = entry;
  mcpSection.servers = servers;
  config.mcp = mcpSection;
  writeJson(configPath, config);
  return `added lynx → ${configPath}`;
}

// ── Public API ─────────────────────────────────────────────────────

export function writeMcpEntry(
  agent: AgentInfo,
  command: string,
  args: string[],
  dryRun: boolean,
): string {
  // OpenCode and OpenClaw need special handling (nested JSON structures)
  if (agent.key === 'opencode') {
    return writeOpenCodeMcp(agent, command, args, dryRun);
  }
  if (agent.key === 'openclaw') {
    return writeOpenClawMcp(agent, command, args, dryRun);
  }

  if (!agent.mcpConfigPath || !agent.mcpConfigFormat) {
    return `skipped (no MCP support for ${agent.label})`;
  }

  switch (agent.mcpConfigFormat) {
    case 'json':
    case 'vscode-json':
      return writeJsonMcp(agent, command, args, dryRun);
    case 'toml':
      return writeTomlMcp(agent, command, args, dryRun);
    default:
      return `unsupported format: ${agent.mcpConfigFormat}`;
  }
}

/** Remove LYNX MCP entry from this agent. Returns summary string. */
export function removeMcpEntry(agent: AgentInfo, dryRun: boolean): string {
  // Handle special formats
  if (agent.key === 'opencode') return removeOpenCodeMcp(agent, dryRun);
  if (agent.key === 'openclaw') return removeOpenClawMcp(agent, dryRun);

  if (!agent.mcpConfigPath || !agent.mcpConfigFormat) {
    return 'skipped (no MCP support)';
  }

  const configPath = agent.mcpConfigPath;

  switch (agent.mcpConfigFormat) {
    case 'json':
    case 'vscode-json': {
      const config = readJson(configPath);
      const servers = (config[agent.mcpKey!] as Record<string, unknown>) || {};
      if (!servers[LYNX_ENTRY_KEY]) {
        return dryRun
          ? `would skip (no lynx entry in ${configPath})`
          : 'skipped (no lynx entry)';
      }
      if (dryRun) {
        return `would remove lynx from ${configPath}`;
      }
      backupFile(configPath);
      delete servers[LYNX_ENTRY_KEY];
      if (Object.keys(servers).length === 0) {
        delete config[agent.mcpKey!];
      } else {
        config[agent.mcpKey!] = servers;
      }
      writeJson(configPath, config);
      return `removed lynx from ${configPath}`;
    }
    case 'toml': {
      const content = readTomlText(configPath);
      const sectionHeader = `[${agent.mcpKey}.${LYNX_ENTRY_KEY}]`;
      if (!content.includes(sectionHeader)) {
        return dryRun
          ? `would skip (no lynx section in ${configPath})`
          : 'skipped (no lynx section)';
      }
      if (dryRun) {
        return `would remove lynx from ${configPath}`;
      }
      backupFile(configPath);
      const idx = content.indexOf(sectionHeader);
      const after = content.slice(idx + sectionHeader.length);
      const nextSection = after.search(/\n\[/);
      const newContent =
        nextSection === -1
          ? content.slice(0, idx).trimEnd() + '\n'
          : content.slice(0, idx) + after.slice(nextSection);
      const tmp = configPath + '.tmp';
      fs.writeFileSync(tmp, newContent);
      fs.renameSync(tmp, configPath);
      return `removed lynx from ${configPath}`;
    }
    default:
      return `unsupported format: ${agent.mcpConfigFormat}`;
  }
}

function removeOpenCodeMcp(agent: AgentInfo, dryRun: boolean): string {
  const configPath = agent.mcpConfigPath!;
  const config = readJson(configPath);
  const mcpSection = (config.mcp as Record<string, unknown>) || {};
  if (!mcpSection[LYNX_ENTRY_KEY]) {
    return dryRun ? `would skip (no lynx in ${configPath})` : 'skipped (no lynx entry)';
  }
  if (dryRun) return `would remove lynx from ${configPath}`;
  backupFile(configPath);
  delete mcpSection[LYNX_ENTRY_KEY];
  if (Object.keys(mcpSection).length === 0) {
    delete config.mcp;
  } else {
    config.mcp = mcpSection;
  }
  writeJson(configPath, config);
  return `removed lynx from ${configPath}`;
}

function removeOpenClawMcp(agent: AgentInfo, dryRun: boolean): string {
  const configPath = agent.mcpConfigPath!;
  const config = readJson(configPath);
  const mcpSection = (config.mcp as Record<string, unknown>) || {};
  const servers = (mcpSection.servers as Record<string, unknown>) || {};
  if (!servers[LYNX_ENTRY_KEY]) {
    return dryRun ? `would skip (no lynx in ${configPath})` : 'skipped (no lynx entry)';
  }
  if (dryRun) return `would remove lynx from ${configPath}`;
  backupFile(configPath);
  delete servers[LYNX_ENTRY_KEY];
  if (Object.keys(servers).length === 0) {
    delete mcpSection.servers;
    if (Object.keys(mcpSection).length === 0) {
      delete config.mcp;
    } else {
      config.mcp = mcpSection;
    }
  } else {
    mcpSection.servers = servers;
    config.mcp = mcpSection;
  }
  writeJson(configPath, config);
  return `removed lynx from ${configPath}`;
}

/** Check if this agent has a LYNX MCP entry. */
export function hasMcpEntry(agent: AgentInfo): boolean {
  if (!agent.mcpConfigPath || !agent.mcpConfigFormat) return false;

  try {
    if (agent.key === 'opencode') {
      const config = readJson(agent.mcpConfigPath);
      const mcpSection = (config.mcp as Record<string, unknown>) || {};
      return LYNX_ENTRY_KEY in mcpSection;
    }
    if (agent.key === 'openclaw') {
      const config = readJson(agent.mcpConfigPath);
      const mcpSection = (config.mcp as Record<string, unknown>) || {};
      const servers = (mcpSection.servers as Record<string, unknown>) || {};
      return LYNX_ENTRY_KEY in servers;
    }

    switch (agent.mcpConfigFormat) {
      case 'json':
      case 'vscode-json': {
        const config = readJson(agent.mcpConfigPath);
        const servers = (config[agent.mcpKey!] as Record<string, unknown>) || {};
        return LYNX_ENTRY_KEY in servers;
      }
      case 'toml': {
        const content = readTomlText(agent.mcpConfigPath);
        const sectionHeader = `[${agent.mcpKey}.${LYNX_ENTRY_KEY}]`;
        return content.includes(sectionHeader);
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}
