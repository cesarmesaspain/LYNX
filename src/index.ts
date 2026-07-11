#!/usr/bin/env node
/*
 * index.ts — LYNX MCP server entry point.
 *
 * Starts the JSON-RPC 2.0 server over stdio.
 * Compatible with any MCP client (Claude Desktop, Codex, etc.)
 *
 * Usage:
 *   npx tsx src/index.ts          # Development
 *   node dist/index.js            # Production (after tsc)
 *   lynx                        # Via npm link (bin)
 */

import { runServer } from './mcp/server.js';

runServer().catch((err) => {
  console.error('LYNX fatal error:', err);
  process.exit(1);
});
