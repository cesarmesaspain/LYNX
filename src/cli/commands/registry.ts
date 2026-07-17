/*
 * registry.ts — Command registry for LYNX CLI.
 *
 * Lazy-loads command handlers: only the dispatched command's module is imported.
 * This avoids loading the MCP server, dashboard, benchmarks, etc. at startup
 * when running a simple command like `lynx index`.
 */

export interface CommandEntry {
  name: string;
  description: string;
  /** Dynamic import: () => import('./foo-cmd.js').then(m => m.cmdXxx) */
  loader: () => Promise<(args: string[]) => void | Promise<void>>;
}

const COMMAND_DEFS: Array<{ name: string; description: string; loader: CommandEntry['loader'] }> = [
  {
    name: 'index',
    description: 'Index a repository into the code graph',
    loader: () => import('./index-cmd.js').then(m => m.cmdIndex),
  },
  {
    name: 'watch',
    description: 'Watch a project for file changes and re-index',
    loader: () => import('./watch-cmd.js').then(m => m.cmdWatch),
  },
  {
    name: 'status',
    description: 'Show index status for a project',
    loader: () => import('./status-cmd.js').then(m => m.cmdStatus),
  },
  {
    name: 'brief',
    description: 'Generate a project brief from the graph',
    loader: () => import('./brief-cmd.js').then(m => m.cmdBrief),
  },
  {
    name: 'detect',
    description: 'Detect projects in a directory',
    loader: () => import('./detect-cmd.js').then(m => m.cmdDetect),
  },
  {
    name: 'install',
    description: 'Install LYNX MCP config for detected agents',
    loader: () => import('./install-cmd.js').then(m => m.cmdInstall),
  },
  {
    name: 'config',
    description: 'Show or update LYNX configuration',
    loader: () => import('./config-cmd.js').then(m => m.cmdConfig),
  },
  {
    name: 'init',
    description: 'Initialize LYNX in a project (CLAUDE.md + AGENTS.md)',
    loader: () => import('./init-cmd.js').then(m => m.cmdInit),
  },
  {
    name: 'doctor',
    description: 'Run diagnostics on the LYNX installation',
    loader: () => import('./doctor-cmd.js').then(m => m.cmdDoctor),
  },
  {
    name: 'usage',
    description: 'Show usage metrics and savings summary',
    loader: () => import('./usage-cmd.js').then(m => m.cmdUsage),
  },
  {
    name: 'benchmark',
    description: 'Run the benchmark suite',
    loader: () => import('./benchmark-cmd.js').then(m => m.cmdBenchmark),
  },
  {
    name: 'ab',
    description: 'Alias for agent-ab',
    loader: () => import('./ab-cmd.js').then(m => m.cmdAB),
  },
  {
    name: 'agent-ab',
    description: 'Run agent A/B benchmark comparing LYNX vs baseline',
    loader: () => import('./agent-ab-cmd.js').then(m => m.cmdAgentAB),
  },
  {
    name: 'report',
    description: 'Generate HTML report for a project',
    loader: () => import('./report-cmd.js').then(m => m.cmdReport),
  },
  {
    name: 'dashboard',
    description: 'Open the LYNX dashboard',
    loader: () => import('./dashboard-cmd.js').then(m => m.cmdDashboard),
  },
  {
    name: 'hook-augment',
    description: 'Augment grep/glob hooks with graph results',
    loader: () => import('./hook-augment-cmd.js').then(m => m.cmdHookAugment),
  },
  {
    name: 'uninstall',
    description: 'Remove LYNX MCP config and hooks',
    loader: () => import('./uninstall-cmd.js').then(m => m.cmdUninstall),
  },
  {
    name: 'license',
    description: 'Manage LYNX license (login, status, refresh)',
    loader: () => import('./license-cmd.js').then(m => m.cmdLicense),
  },
  {
    name: 'metrics',
    description: 'Show detailed metrics for a project',
    loader: () => import('./metrics-cmd.js').then(m => m.cmdMetrics),
  },
  {
    name: 'upgrade',
    description: 'Upgrade LYNX to the latest version',
    loader: () => import('./upgrade-cmd.js').then(m => m.cmdUpgrade),
  },
  {
    name: 'rollback',
    description: 'Restore the last accepted packaged LYNX distribution',
    loader: () => import('./rollback-cmd.js').then(m => m.cmdRollback),
  },
  {
    name: 'serve',
    description: 'Start the LYNX MCP server',
    loader: () => import('./serve-cmd.js').then(m => m.cmdServe),
  },
  // ── Query tools (direct CLI wrappers around MCP handlers) ──────────
  {
    name: 'search',
    description: 'Search the code graph by keyword or name',
    loader: () => import('./query-cmd.js').then(m => m.cmdSearch),
  },
  {
    name: 'trace',
    description: 'Trace callers/callees through the code graph',
    loader: () => import('./query-cmd.js').then(m => m.cmdTrace),
  },
  {
    name: 'snippet',
    description: 'Read the source code of a symbol',
    loader: () => import('./query-cmd.js').then(m => m.cmdSnippet),
  },
  {
    name: 'tests',
    description: 'Find tests covering a symbol',
    loader: () => import('./query-cmd.js').then(m => m.cmdTests),
  },
  {
    name: 'dead',
    description: 'Find dead code candidates (zero callers)',
    loader: () => import('./query-cmd.js').then(m => m.cmdDead),
  },
  {
    name: 'hotspots',
    description: 'Show highest-complexity files and functions',
    loader: () => import('./query-cmd.js').then(m => m.cmdHotspots),
  },
  {
    name: 'semantic',
    description: 'Search code by natural-language intent',
    loader: () => import('./query-cmd.js').then(m => m.cmdSemantic),
  },
  {
    name: 'investigate',
    description: 'Deep-dive into a symbol: search, explain, trace, snippet, tests in one call',
    loader: () => import('./query-cmd.js').then(m => m.cmdInvestigate),
  },
  {
    name: 'evidence',
    description: 'Show why an edge exists: relationship, confidence, source location, evidence chain',
    loader: () => import('./query-cmd.js').then(m => m.cmdEvidence),
  },
];

const COMMAND_MAP = new Map<string, CommandEntry>();
for (const def of COMMAND_DEFS) {
  COMMAND_MAP.set(def.name, { name: def.name, description: def.description, loader: def.loader });
}

/** Look up a command by name. */
export function getCommand(name: string): CommandEntry | undefined {
  return COMMAND_MAP.get(name);
}

/** List all registered commands. */
export function listCommands(): ReadonlyArray<{ name: string; description: string }> {
  return COMMAND_DEFS.map(d => ({ name: d.name, description: d.description }));
}

/** Generate help text listing all commands. */
export function helpText(): string {
  const maxLen = Math.max(...COMMAND_DEFS.map(c => c.name.length));
  const lines = ['Commands:'];
  for (const cmd of COMMAND_DEFS) {
    lines.push(`  ${cmd.name.padEnd(maxLen + 2)}${cmd.description}`);
  }
  return lines.join('\n');
}

/**
 * Dispatch a command by name.
 * Only the dispatched command's module is loaded.
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

  const handler = await cmd.loader();
  await Promise.resolve(handler(args));
}
