/*
 * agents.ts — Agent detection for LYNX onboarding.
 *
 * Detects installed coding agents by checking for their config directories
 * and binaries. Returns structured info so the installer can write the
 * right MCP config format and instruction files for each agent.
 *
 * Supports 11 agents:
 *   Claude Code, Codex CLI, VS Code, Cursor, Zed, Gemini CLI, OpenCode,
 *   Antigravity, Aider, KiloCode, OpenClaw, Kiro.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { getProjectRoot } from '../paths.js';

const HOME = os.homedir();

export type AgentFormat = 'json' | 'toml' | 'vscode-json' | 'opencode-json';

export interface AgentInfo {
  /** Short key, e.g. 'claude-code', 'codex' */
  key: string;
  /** Human-readable label */
  label: string;
  /** Path to the config directory (~/.claude, ~/.codex, etc.) */
  configDir: string;
  /** Path to the MCP config file (absolute). Optional — agents without MCP (Aider) skip. */
  mcpConfigPath?: string;
  /** Format of the MCP config file. Optional if mcpConfigPath is not set. */
  mcpConfigFormat?: AgentFormat;
  /**
   * JSON: top-level key where MCP servers live.
   * TOML: section prefix, e.g. "mcp_servers".
   * vscode-json: "servers".
   * Optional if mcpConfigPath is not set.
   */
  mcpKey?: string;
  /** Path to an instruction file that supports managed blocks (optional) */
  instructionsPath?: string;
  /** Whether this agent supports Claude-style hooks */
  hooksSupported: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────

function exists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function binaryOnPath(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ── Detectors ─────────────────────────────────────────────────────

function detectClaudeCode(): AgentInfo | null {
  const dir = path.join(HOME, '.claude');
  if (!exists(dir)) return null;
  return {
    key: 'claude-code',
    label: 'Claude Code',
    configDir: dir,
    mcpConfigPath: path.join(dir, '.mcp.json'),
    mcpConfigFormat: 'json',
    mcpKey: 'mcpServers',
    instructionsPath: undefined, // Uses hooks + SKILL.md instead
    hooksSupported: true,
  };
}

function detectCodex(): AgentInfo | null {
  const dir = path.join(HOME, '.codex');
  if (!exists(dir)) return null;
  return {
    key: 'codex',
    label: 'Codex CLI',
    configDir: dir,
    mcpConfigPath: path.join(dir, 'config.toml'),
    mcpConfigFormat: 'toml',
    mcpKey: 'mcp_servers',
    instructionsPath: path.join(dir, 'AGENTS.md'),
    hooksSupported: false,
  };
}

function detectVsCode(): AgentInfo | null {
  const dirs = [
    path.join(HOME, 'Library', 'Application Support', 'Code', 'User'),
    path.join(HOME, '.config', 'Code', 'User'),
  ];
  const dir = dirs.find(exists);
  if (!dir) return null;
  return {
    key: 'vscode',
    label: 'VS Code',
    configDir: dir,
    mcpConfigPath: path.join(dir, 'mcp.json'),
    mcpConfigFormat: 'vscode-json',
    mcpKey: 'servers',
    instructionsPath: undefined,
    hooksSupported: false,
  };
}

function detectCursor(): AgentInfo | null {
  const dirs = [
    path.join(HOME, '.cursor'),
    path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User'),
  ];
  const dir = dirs.find(exists);
  if (!dir) return null;
  return {
    key: 'cursor',
    label: 'Cursor',
    configDir: dir,
    mcpConfigPath: path.join(dir, '.mcp.json'),
    mcpConfigFormat: 'json',
    mcpKey: 'mcpServers',
    instructionsPath: undefined,
    hooksSupported: false,
  };
}

function detectZed(): AgentInfo | null {
  const dir = path.join(HOME, '.zed');
  if (!exists(dir)) return null;
  return {
    key: 'zed',
    label: 'Zed',
    configDir: dir,
    mcpConfigPath: path.join(dir, 'settings.json'),
    mcpConfigFormat: 'json',
    mcpKey: 'context_servers',
    instructionsPath: undefined,
    hooksSupported: false,
  };
}

function detectGemini(): AgentInfo | null {
  const dir = path.join(HOME, '.gemini');
  if (!exists(dir)) return null;
  return {
    key: 'gemini',
    label: 'Gemini CLI',
    configDir: dir,
    mcpConfigPath: path.join(dir, 'settings.json'),
    mcpConfigFormat: 'json',
    mcpKey: 'mcpServers',
    instructionsPath: path.join(dir, 'GEMINI.md'),
    hooksSupported: false,
  };
}

function detectOpenCode(): AgentInfo | null {
  const dir = path.join(HOME, '.config', 'opencode');
  if (!exists(dir)) return null;
  return {
    key: 'opencode',
    label: 'OpenCode',
    configDir: dir,
    mcpConfigPath: path.join(dir, 'opencode.json'),
    mcpConfigFormat: 'opencode-json',
    mcpKey: 'mcp',
    instructionsPath: path.join(dir, 'AGENTS.md'),
    hooksSupported: false,
  };
}

function detectAntigravity(): AgentInfo | null {
  const dir = path.join(HOME, '.gemini', 'antigravity-cli');
  if (!exists(dir)) return null;
  return {
    key: 'antigravity',
    label: 'Antigravity',
    configDir: dir,
    mcpConfigPath: path.join(HOME, '.gemini', 'config', 'mcp_config.json'),
    mcpConfigFormat: 'json',
    mcpKey: 'mcpServers',
    instructionsPath: path.join(dir, 'AGENTS.md'),
    hooksSupported: false,
  };
}

function detectAider(): AgentInfo | null {
  if (!binaryOnPath('aider')) return null;
  return {
    key: 'aider',
    label: 'Aider',
    configDir: HOME,
    // No MCP support — instructions only
    instructionsPath: undefined, // project-level CONVENTIONS.md, handled by init
    hooksSupported: false,
  };
}

function detectKiloCode(): AgentInfo | null {
  const dirs = [
    path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'kilocode.kilo-code'),
    path.join(HOME, '.config', 'Code', 'User', 'globalStorage', 'kilocode.kilo-code'),
  ];
  const dir = dirs.find(exists);
  if (!dir) return null;
  return {
    key: 'kilocode',
    label: 'KiloCode',
    configDir: dir,
    mcpConfigPath: path.join(dir, 'settings', 'mcp_settings.json'),
    mcpConfigFormat: 'json',
    mcpKey: 'mcpServers',
    instructionsPath: path.join(HOME, '.kilocode', 'rules', 'lynx.md'),
    hooksSupported: false,
  };
}

function detectOpenClaw(): AgentInfo | null {
  const dir = path.join(HOME, '.openclaw');
  if (!exists(dir)) return null;
  return {
    key: 'openclaw',
    label: 'OpenClaw',
    configDir: dir,
    mcpConfigPath: path.join(dir, 'openclaw.json'),
    mcpConfigFormat: 'opencode-json',
    mcpKey: 'mcp.servers',
    instructionsPath: undefined,
    hooksSupported: false,
  };
}

function detectKiro(): AgentInfo | null {
  const dir = path.join(HOME, '.kiro');
  if (!exists(dir)) return null;
  return {
    key: 'kiro',
    label: 'Kiro',
    configDir: dir,
    mcpConfigPath: path.join(dir, 'settings', 'mcp.json'),
    mcpConfigFormat: 'json',
    mcpKey: 'mcpServers',
    instructionsPath: undefined,
    hooksSupported: false,
  };
}

// ── Aggregate ──────────────────────────────────────────────────────

export function detectAgents(): AgentInfo[] {
  const detectors = [
    detectClaudeCode,
    detectCodex,
    detectVsCode,
    detectCursor,
    detectZed,
    detectGemini,
    detectOpenCode,
    detectAntigravity,
    detectAider,
    detectKiloCode,
    detectOpenClaw,
    detectKiro,
  ];
  const results: AgentInfo[] = [];
  for (const fn of detectors) {
    const info = fn();
    if (info) results.push(info);
  }
  return results;
}

export function detectProjectInstructionPaths(root: string): string[] {
  const candidates = [
    path.join(root, 'CLAUDE.md'),
    path.join(root, '.github', 'copilot-instructions.md'),
    path.join(root, 'AGENTS.md'),
    path.join(root, 'CONVENTIONS.md'),
  ];
  return candidates.filter(fileExists);
}

// ── Binary path helpers ────────────────────────────────────────────

export function getLynxCommand(): { command: string; args: string[] } {
  if ((process as NodeJS.Process & { pkg?: unknown }).pkg) {
    // pkg launches the embedded CLI itself; an extra argument is interpreted
    // as a snapshot entry path instead of a CLI command.
    return { command: process.execPath, args: [] };
  }
  const nodeBin = process.execPath;
  const cliPath = process.argv[1];
  if (cliPath && path.basename(cliPath) === 'cli.js') {
    return { command: nodeBin, args: [cliPath, 'serve'] };
  }

  const projectRoot = getProjectRoot();
  const sourceCli = path.join(projectRoot, 'src', 'cli.ts');
  const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(sourceCli) && fs.existsSync(tsxCli)) {
    return { command: nodeBin, args: [tsxCli, sourceCli, 'serve'] };
  }

  const bundledCli = path.join(projectRoot, 'dist', 'cli.js');
  return { command: nodeBin, args: [bundledCli, 'serve'] };
}
