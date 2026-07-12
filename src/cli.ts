#!/usr/bin/env node
/*
 * cli.ts — LYNX command-line interface.
 *
 * Provides direct CLI commands for indexing and status without MCP.
 *
 * Usage:
 *   npx lynx index /path/to/repo    # Index a repository
 *   npx lynx status <project>       # Show index status
 *   npx lynx serve                  # Start MCP server (same as npx lynx)
 */

import { dispatchCommand, helpText } from './cli/commands/index.js';

const args = process.argv.slice(2);
const command = args[0];

if (command === '--help' || command === '-h' || command === 'help') {
  console.log('LYNX — Code Intelligence Graph\n');
  console.log('Usage: lynx <command> [args]\n');
  console.log(helpText());
  process.exit(0);
}

dispatchCommand(command, args.slice(1)).catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
