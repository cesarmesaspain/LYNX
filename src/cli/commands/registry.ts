/*
 * registry.ts — Command registry for LYNX CLI.
 *
 * Replaces the 21-case switch in dispatchCommand with a data-driven registry.
 * Each command declares its name, description, handler, and whether it's async.
 * Help text and dispatch are derived from the registry.
 */

import { cmdIndex } from './index-cmd.js';
import { cmdWatch } from './watch-cmd.js';
import { cmdStatus } from './status-cmd.js';
import { cmdBrief } from './brief-cmd.js';
import { cmdDetect } from './detect-cmd.js';
import { cmdInstall } from './install-cmd.js';
import { cmdConfig } from './config-cmd.js';
import { cmdInit } from './init-cmd.js';
import { cmdDoctor } from './doctor-cmd.js';
import { cmdUsage } from './usage-cmd.js';
import { cmdBenchmark } from './benchmark-cmd.js';
import { cmdReport } from './report-cmd.js';
import { cmdDashboard } from './dashboard-cmd.js';
import { cmdHookAugment } from './hook-augment-cmd.js';
import { cmdUninstall } from './uninstall-cmd.js';
import { cmdServe } from './serve-cmd.js';
import { cmdLicense } from './license-cmd.js';
import { cmdMetrics } from './metrics-cmd.js';
import { cmdAB } from './ab-cmd.js';
import { cmdAgentAB } from './agent-ab-cmd.js';
import { cmdUpgrade } from './upgrade-cmd.js';

export interface CommandEntry {
  name: string;
  description: string;
  handler: (args: string[]) => void | Promise<void>;
  /** If true, the handler returns a Promise. If false, it's synchronous. */
  isAsync: boolean;
}

const COMMANDS: CommandEntry[] = [
  { name: 'index',        description: 'Index a repository into the code graph',                    handler: cmdIndex,        isAsync: true  },
  { name: 'watch',        description: 'Watch a project for file changes and re-index',              handler: cmdWatch,        isAsync: true  },
  { name: 'status',       description: 'Show index status for a project',                           handler: cmdStatus,       isAsync: false },
  { name: 'brief',        description: 'Generate a project brief from the graph',                   handler: cmdBrief,        isAsync: true  },
  { name: 'detect',       description: 'Detect projects in a directory',                            handler: cmdDetect,       isAsync: false },
  { name: 'install',      description: 'Install LYNX MCP config for detected agents',               handler: cmdInstall,      isAsync: true  },
  { name: 'config',       description: 'Show or update LYNX configuration',                         handler: cmdConfig,       isAsync: false },
  { name: 'init',         description: 'Initialize LYNX in a project (CLAUDE.md + AGENTS.md)',      handler: cmdInit,         isAsync: false },
  { name: 'doctor',       description: 'Run diagnostics on the LYNX installation',                  handler: cmdDoctor,       isAsync: true  },
  { name: 'usage',        description: 'Show usage metrics and savings summary',                    handler: cmdUsage,        isAsync: false },
  { name: 'benchmark',    description: 'Run the benchmark suite',                                   handler: cmdBenchmark,    isAsync: true  },
  { name: 'ab',           description: 'Alias for agent-ab',                                        handler: cmdAB,           isAsync: true  },
  { name: 'agent-ab',     description: 'Run agent A/B benchmark comparing LYNX vs baseline',        handler: cmdAgentAB,      isAsync: true  },
  { name: 'report',       description: 'Generate HTML report for a project',                        handler: cmdReport,       isAsync: false },
  { name: 'dashboard',    description: 'Open the LYNX dashboard',                                   handler: cmdDashboard,    isAsync: false },
  { name: 'hook-augment', description: 'Augment grep/glob hooks with graph results',                 handler: cmdHookAugment,  isAsync: true  },
  { name: 'uninstall',    description: 'Remove LYNX MCP config and hooks',                          handler: cmdUninstall,    isAsync: false },
  { name: 'license',      description: 'Manage LYNX license (login, status, refresh)',              handler: cmdLicense,      isAsync: false },
  { name: 'metrics',      description: 'Show detailed metrics for a project',                       handler: cmdMetrics,      isAsync: false },
  { name: 'upgrade',      description: 'Upgrade LYNX to the latest version',                        handler: cmdUpgrade,      isAsync: true  },
  { name: 'serve',        description: 'Start the LYNX MCP server',                                 handler: cmdServe,        isAsync: true  },
];

const COMMAND_MAP = new Map<string, CommandEntry>();
for (const cmd of COMMANDS) {
  COMMAND_MAP.set(cmd.name, cmd);
}

/** Look up a command by name. */
export function getCommand(name: string): CommandEntry | undefined {
  return COMMAND_MAP.get(name);
}

/** List all registered commands. */
export function listCommands(): ReadonlyArray<CommandEntry> {
  return COMMANDS;
}

/** Generate help text listing all commands. */
export function helpText(): string {
  const maxLen = Math.max(...COMMANDS.map(c => c.name.length));
  const lines = ['Commands:'];
  for (const cmd of COMMANDS) {
    lines.push(`  ${cmd.name.padEnd(maxLen + 2)}${cmd.description}`);
  }
  return lines.join('\n');
}

/**
 * Dispatch a command by name.
 * Returns a Promise that resolves when the command completes.
 * Unknown commands print an error and exit.
 * An empty/undefined command maps to 'serve'.
 */
export async function dispatchCommand(command: string | undefined, args: string[]): Promise<void> {
  const name = command || 'serve';
  const cmd = COMMAND_MAP.get(name);

  if (!cmd) {
    console.error(`Unknown command: ${name}`);
    console.error(helpText());
    process.exit(1);
  }

  await Promise.resolve(cmd.handler(args));
}
