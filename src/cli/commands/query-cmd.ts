/*
 * query-cmd.ts — CLI wrappers around LYNX MCP tools.
 *
 * Each command accepts simple positional arguments and prints compact JSON
 * to stdout. Designed for use via FreeGPT's run_command tool:
 *
 *   lynx search LYNX "store time"
 *   lynx trace LYNX handleSearchGraph inbound
 *   lynx snippet LYNX store.time.utcTodayDateString
 *   lynx tests LYNX store.time.utcTodayDateString
 *   lynx dead LYNX
 *   lynx hotspots LYNX
 *   lynx semantic LYNX "timestamp helpers"
 */

import { handleSearchGraph } from '../../mcp/handlers/search_graph.js';
import { handleTracePath } from '../../mcp/handlers/trace_path.js';
import { handleGetCodeSnippet } from '../../mcp/handlers/get_code_snippet.js';
import { handleFindTests } from '../../mcp/handlers/find_tests.js';
import { handleFindDeadCode } from '../../mcp/handlers/find_dead_code.js';
import { handleAnalyzeHotspots } from '../../mcp/handlers/analyze_hotspots.js';
import { handleSemanticSearch } from '../../mcp/handlers/semantic_search.js';
import { handleInvestigateSymbol } from '../../mcp/handlers/investigate_symbol.js';
import { handleGetEdgeEvidence } from '../../mcp/handlers/get_edge_evidence.js';

function printJson(result: unknown): void {
  process.stdout.write(JSON.stringify(result) + '\n');
}

// ── search ──────────────────────────────────────────────────────────

export async function cmdSearch(args: string[]): Promise<void> {
  const project = args[0];
  const query = args[1];
  if (!project || !query) {
    process.stderr.write('Usage: lynx search <project> <query> [limit]\n');
    process.exit(1);
  }
  const limit = args[2] ? Number(args[2]) : 10;
  const result = await handleSearchGraph({ project, query, limit, include_snippets: true });
  printJson(result);
}

// ── trace ───────────────────────────────────────────────────────────

export async function cmdTrace(args: string[]): Promise<void> {
  const project = args[0];
  const functionName = args[1];
  if (!project || !functionName) {
    process.stderr.write('Usage: lynx trace <project> <function_name> [inbound|outbound|both] [depth]\n');
    process.exit(1);
  }
  const direction = args[2] || 'outbound';
  const depth = args[3] ? Number(args[3]) : 3;
  const result = await handleTracePath({ project, function_name: functionName, direction, depth });
  printJson(result);
}

// ── snippet ─────────────────────────────────────────────────────────

export async function cmdSnippet(args: string[]): Promise<void> {
  const project = args[0];
  const qualifiedName = args[1];
  if (!project || !qualifiedName) {
    process.stderr.write('Usage: lynx snippet <project> <qualified_name>\n');
    process.exit(1);
  }
  const result = await handleGetCodeSnippet({ project, qualified_name: qualifiedName });
  printJson(result);
}

// ── tests ───────────────────────────────────────────────────────────

export async function cmdTests(args: string[]): Promise<void> {
  const project = args[0];
  const qualifiedName = args[1];
  if (!project || !qualifiedName) {
    process.stderr.write('Usage: lynx tests <project> <qualified_name>\n');
    process.exit(1);
  }
  const result = await handleFindTests({ project, qualified_name: qualifiedName });
  printJson(result);
}

// ── dead ────────────────────────────────────────────────────────────

export async function cmdDead(args: string[]): Promise<void> {
  const project = args[0];
  if (!project) {
    process.stderr.write('Usage: lynx dead <project> [limit]\n');
    process.exit(1);
  }
  const limit = args[1] ? Number(args[1]) : 30;
  const result = await handleFindDeadCode({ project, limit });
  printJson(result);
}

// ── hotspots ────────────────────────────────────────────────────────

export async function cmdHotspots(args: string[]): Promise<void> {
  const project = args[0];
  if (!project) {
    process.stderr.write('Usage: lynx hotspots <project>\n');
    process.exit(1);
  }
  const result = await handleAnalyzeHotspots({ project });
  printJson(result);
}

// ── semantic ────────────────────────────────────────────────────────

export async function cmdSemantic(args: string[]): Promise<void> {
  const project = args[0];
  const query = args[1];
  if (!project || !query) {
    process.stderr.write('Usage: lynx semantic <project> <query> [limit]\n');
    process.exit(1);
  }
  const limit = args[2] ? Number(args[2]) : 10;
  const result = await handleSemanticSearch({ project, query, limit });
  printJson(result);
}

// ── investigate ─────────────────────────────────────────────────────

export async function cmdInvestigate(args: string[]): Promise<void> {
  const project = args[0];
  const symbol = args[1];
  if (!project || !symbol) {
    process.stderr.write('Usage: lynx investigate <project> <symbol> [depth] [--verbose]\n');
    process.exit(1);
  }
  const depth = args[2] && !args[2].startsWith('--') ? Number(args[2]) : 2;
  const verbose = args.includes('--verbose');
  const result = await handleInvestigateSymbol({ project, symbol, depth, verbose });
  printJson(result);
}

// ── evidence ─────────────────────────────────────────────────────────

export async function cmdEvidence(args: string[]): Promise<void> {
  const project = args[0];
  const source = args[1];
  const target = args[2];
  if (!project || !source || !target) {
    process.stderr.write('Usage: lynx evidence <project> <source_name> <target_name>\n');
    process.exit(1);
  }
  const result = await handleGetEdgeEvidence({ project, source_name: source, target_name: target });
  printJson(result);
}
