/*
 * investigate_symbol.ts — Meta-tool that packages search + explain + trace + snippet
 * into a single context pack. Eliminates 3 sequential round-trips for the common
 * "what is this symbol and how does it work?" agent workflow.
 *
 * Improvement #5: cognitive capability for LLM agents.
 */
import { handleSearchGraph } from './search_graph.js';
import { handleExplainSymbol } from './explain_symbol.js';
import { handleTracePath } from './trace_path.js';
import { handleGetCodeSnippet } from './get_code_snippet.js';
import { handleFindTests } from './find_tests.js';

const INTERNAL_METRICS_KEYS = new Set([
  'value_metrics', 'llm_usage', 'index_context', 'agent_response_preference',
  'complexity_trend', 'edge_counts', 'latency_breakdown', 'observed_savings',
  'exploration_potential', 'structural_confidence', 'full_file_potential_tokens',
  'estimated_files_avoided', 'estimated_tokens_saved', 'potential_basis',
  'measurement', 'latency_ms', 'graph_query_latency_ms', 'llm_rerank_latency_ms',
  'local_processing_ms', 'no_match_guidance',
]);

function stripInternalMetrics(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stripInternalMetrics);
  if (typeof obj !== 'object') return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (INTERNAL_METRICS_KEYS.has(k)) continue;
    out[k] = stripInternalMetrics(v);
  }
  return out;
}

export async function handleInvestigateSymbol(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const project = String(args.project || '');
  const symbolName = String(args.symbol || args.name || args.qualified_name || '');
  const depth = Number(args.depth || 2);
  const includeEvidence = args.include_evidence !== false;
  const verbose = args.verbose === true;

  if (!project || !symbolName) {
    return { error: 'project and symbol (name or qualified_name) are required' };
  }

  const errors: string[] = [];
  let searchResult: unknown;
  let explainResult: unknown;
  let traceResult: unknown;
  let snippetResult: unknown;
  let testsResult: unknown;

  // 1. search_graph — resolve the symbol
  try {
    searchResult = await handleSearchGraph({
      project,
      query: symbolName,
      limit: 3,
      include_snippets: false,
    });
  } catch (e) {
    errors.push(`search_graph: ${String(e)}`);
  }

  // 2. explain_symbol — deep dive
  try {
    explainResult = await handleExplainSymbol({
      project,
      qualified_name: symbolName,
      name: symbolName,
    });
  } catch (e) {
    errors.push(`explain_symbol: ${String(e)}`);
  }

  // 3. trace_path — evidence-annotated traversal
  try {
    traceResult = await handleTracePath({
      project,
      function_name: symbolName,
      direction: 'both',
      depth,
      include_edges: true,
      include_evidence: includeEvidence,
      mode: 'auto',
    });
  } catch (e) {
    errors.push(`trace_path: ${String(e)}`);
  }

  // 4. get_code_snippet — source code
  try {
    snippetResult = await handleGetCodeSnippet({
      project,
      qualified_name: symbolName,
      include_neighbors: true,
    });
  } catch (e) {
    errors.push(`get_code_snippet: ${String(e)}`);
  }

  // 5. find_tests — test coverage
  try {
    testsResult = await handleFindTests({
      project,
      qualified_name: symbolName,
      name: symbolName,
    });
  } catch (e) {
    errors.push(`find_tests: ${String(e)}`);
  }

  const layers = {
    search: verbose ? searchResult : stripInternalMetrics(searchResult),
    explain: verbose ? explainResult : stripInternalMetrics(explainResult),
    trace: verbose ? traceResult : stripInternalMetrics(traceResult),
    snippet: verbose ? snippetResult : stripInternalMetrics(snippetResult),
    tests: verbose ? testsResult : stripInternalMetrics(testsResult),
  };

  const layerResults = [searchResult, explainResult, traceResult, snippetResult, testsResult];
  const successfulCount = layerResults.filter(r => r !== undefined && !(r as Record<string, unknown>)?.error).length;
  const operationsCollapsed = successfulCount + (includeEvidence && traceResult && !(traceResult as Record<string, unknown>)?.error ? 1 : 0);

  return {
    symbol: symbolName,
    project,
    layers,
    ...(verbose ? {} : { hint: 'Pass verbose:true for full metrics, llm_usage, and index context.' }),
    errors: errors.length > 0 ? errors : undefined,
    meta: {
      description: 'Unified investigation of a single symbol. Combines search → explain → trace (with evidence) → snippet → tests in one call.',
      operations_collapsed: operationsCollapsed,
      layers_succeeded: successfulCount,
      layers_attempted: 5,
      tool: 'investigate_symbol',
      mode: verbose ? 'verbose' : 'compact',
    },
  };
}
