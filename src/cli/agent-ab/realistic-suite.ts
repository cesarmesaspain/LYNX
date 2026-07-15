/*
 * agent-ab/realistic-suite.ts — Realistic developer workflow suite.
 *
 * Selected only via --suite realistic. Does NOT affect default/core behavior
 * or historical comparability. Exercises all 20 agent-relevant LYNX MCP tools plus read_file.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import type { AgentToolDefinition, EvaluationKind } from './types.js';
import { EVIDENCE_DISCIPLINE, TOOLS, withEvidenceDiscipline } from '../../mcp/tools.js';

// ── All agent handler imports ─────────────────────────────────

import { handleSearchGraph } from '../../mcp/handlers/search_graph.js';
import { handleTracePath } from '../../mcp/handlers/trace_path.js';
import { handleExplainSymbol } from '../../mcp/handlers/explain_symbol.js';
import { handleFindTests } from '../../mcp/handlers/find_tests.js';
import { handleGetArchitecture } from '../../mcp/handlers/get_architecture.js';
import { handleAnalyzeHotspots } from '../../mcp/handlers/analyze_hotspots.js';
import { handleFindDeadCode } from '../../mcp/handlers/find_dead_code.js';
import { handleGetGraphSchema } from '../../mcp/handlers/get_graph_schema.js';
import { handleSemanticSearch } from '../../mcp/handlers/semantic_search.js';
import { handleBatchGetCode } from '../../mcp/handlers/batch_get_code.js';
import { handleGetCodeSnippet } from '../../mcp/handlers/get_code_snippet.js';
import { handleSearchCode } from '../../mcp/handlers/search_code.js';
import { handleSmartReview } from '../../mcp/handlers/smart_review.js';
import { handleDetectChanges } from '../../mcp/handlers/detect_changes.js';
import { handlePackMemory } from '../../mcp/handlers/pack_memory.js';
import { handleQueryGraph } from '../../mcp/handlers/query_graph.js';
import { handleCompareRuns } from '../../mcp/handlers/compare_runs.js';
import { handlePackContext } from '../../mcp/handlers/pack_context.js';
import { handleGetEdgeEvidence } from '../../mcp/handlers/get_edge_evidence.js';
import { handleInvestigateSymbol } from '../../mcp/handlers/investigate_symbol.js';

// ── Coverage manifest ──────────────────────────────────────────

/**
 * Authoritative 26-tool coverage manifest.
 *
 * Classification key:
 *   agent       — usable by an LLM agent to explore/understand code
 *   admin/infra — project setup, indexing, maintenance (not agent tasks)
 *
 * Coverage statuses:
 *   executable       — deterministic fixture + assertion exercise the handler
 *   designed-only    — task defined but expected={} / no seeded state guarantees
 *   excluded         — admin/infra tool, not eligible for agent benchmark
 */
export interface ToolCoverageEntry {
  tool_name: string;
  classification: 'agent' | 'admin/infra';
  coverage: 'executable' | 'designed-only' | 'excluded';
  task_id?: string;
  direct_deterministic_test: boolean;
  required_seeded_state: string;
  executable_now: boolean;
  exclusion_rationale: string;
}

export const TOOL_COVERAGE: ToolCoverageEntry[] = [
  // ── Core: executable via original 5-task default suite ──
  {
    tool_name: 'search_graph', classification: 'agent', coverage: 'executable',
    task_id: 'find_definition', direct_deterministic_test: true,
    required_seeded_state: 'lynxHome symbol indexed in graph',
    executable_now: true,
    exclusion_rationale: '',
  },
  {
    tool_name: 'trace_path', classification: 'agent', coverage: 'executable',
    task_id: 'find_callers', direct_deterministic_test: true,
    required_seeded_state: 'readConfig CALLS edges → openDb, dbPath',
    executable_now: true,
    exclusion_rationale: '',
  },
  {
    tool_name: 'explain_symbol', classification: 'agent', coverage: 'executable',
    task_id: 'change_impact', direct_deterministic_test: true,
    required_seeded_state: 'Config interface with IMPORTS/USAGE edges',
    executable_now: true,
    exclusion_rationale: '',
  },
  {
    tool_name: 'find_tests', classification: 'agent', coverage: 'executable',
    task_id: 'find_tests', direct_deterministic_test: true,
    required_seeded_state: 'TESTS edges from test fns → lynxHome',
    executable_now: true,
    exclusion_rationale: '',
  },
  {
    tool_name: 'get_edge_evidence', classification: 'agent', coverage: 'executable',
    task_id: 'edge_evidence', direct_deterministic_test: true,
    required_seeded_state: 'CALLS edge with captured edge_evidence records (lynxConfigPath → lynxHome)',
    executable_now: true,
    exclusion_rationale: '',
  },
  {
    tool_name: 'read_file', classification: 'agent', coverage: 'executable',
    task_id: 'locate_definitions', direct_deterministic_test: true,
    required_seeded_state: 'fixture files on disk (runtime.ts, db.ts, helpers.ts)',
    executable_now: true,
    exclusion_rationale: '',
  },
  // ── Realistic suite: executable via seeded fixture ──
  {
    tool_name: 'get_architecture', classification: 'agent', coverage: 'executable',
    task_id: 'architecture_languages', direct_deterministic_test: true,
    required_seeded_state: 'indexed project with TypeScript files',
    executable_now: true,
    exclusion_rationale: '',
  },
  {
    tool_name: 'analyze_hotspots', classification: 'agent', coverage: 'executable',
    task_id: 'top_hotspots', direct_deterministic_test: true,
    required_seeded_state: 'isolated fixture with lynxHome call graph fan-in',
    executable_now: true,
    exclusion_rationale: '',
  },
  {
    tool_name: 'batch_get_code', classification: 'agent', coverage: 'executable',
    task_id: 'batch_get_code', direct_deterministic_test: true,
    required_seeded_state: 'lynxHome and openDb in graph',
    executable_now: true,
    exclusion_rationale: '',
  },
  {
    tool_name: 'get_code_snippet', classification: 'agent', coverage: 'executable',
    task_id: 'batch_get_code', direct_deterministic_test: true,
    required_seeded_state: 'symbols indexed in graph',
    executable_now: true,
    exclusion_rationale: 'Exercised via batch_get_code task (same handler path)',
  },
  {
    tool_name: 'search_code', classification: 'agent', coverage: 'executable',
    task_id: 'search_code', direct_deterministic_test: true,
    required_seeded_state: 'LYNX_DEEPSEEK_KEY string in fixture credentials.ts',
    executable_now: true,
    exclusion_rationale: '',
  },
  {
    tool_name: 'get_graph_schema', classification: 'agent', coverage: 'executable',
    task_id: 'graph_schema', direct_deterministic_test: true,
    required_seeded_state: 'indexed project with node labels and edge types',
    executable_now: true,
    exclusion_rationale: '',
  },
  {
    tool_name: 'semantic_search', classification: 'agent', coverage: 'executable',
    task_id: 'semantic_search', direct_deterministic_test: true,
    required_seeded_state: 'fixture getApiKey indexed in credentials.ts with semantic vectors',
    executable_now: true,
    exclusion_rationale: '',
  },
  // ── Realistic suite: designed-only (no deterministic assertion possible) ──
  {
    tool_name: 'smart_review', classification: 'agent', coverage: 'designed-only',
    task_id: 'smart_review', direct_deterministic_test: false,
    required_seeded_state: 'indexed file with complexity/coupling/test-coverage data',
    executable_now: false,
    exclusion_rationale: 'Output is ranked suggestions with no stable deterministic anchor; LLM must summarize qualitative review findings.',
  },
  {
    tool_name: 'detect_changes', classification: 'agent', coverage: 'designed-only',
    task_id: 'detect_changes', direct_deterministic_test: false,
    required_seeded_state: 'dirty git working tree at known revision',
    executable_now: false,
    exclusion_rationale: 'Working tree state is non-deterministic across CI runs and dev machines; no stable assertion possible without git snapshot seeding.',
  },
  {
    tool_name: 'pack_memory', classification: 'agent', coverage: 'designed-only',
    task_id: 'pack_memory', direct_deterministic_test: false,
    required_seeded_state: 'persistent memory saved from prior analyze_hotspots or smart_review runs',
    executable_now: false,
    exclusion_rationale: 'Depends on prior analysis results being persisted in memory store; empty in fresh index.',
  },
  {
    tool_name: 'query_graph', classification: 'agent', coverage: 'designed-only',
    task_id: 'query_graph', direct_deterministic_test: false,
    required_seeded_state: 'complexity metrics stored as node properties',
    executable_now: false,
    exclusion_rationale: 'Cypher query results depend on index state; assertion shape is known but exact counts vary across index runs.',
  },
  // ── Cross-exercised with batch_get_code (not a separate task) ──
  {
    tool_name: 'pack_context', classification: 'agent', coverage: 'designed-only',
    task_id: undefined, direct_deterministic_test: false,
    required_seeded_state: 'indexed project + task description',
    executable_now: false,
    exclusion_rationale: 'Pack context output is advisory (suggested areas/tools); no verifiable deterministic assertion.',
  },
  {
    tool_name: 'compare_runs', classification: 'agent', coverage: 'designed-only',
    task_id: undefined, direct_deterministic_test: false,
    required_seeded_state: 'at least 2 index runs in history',
    executable_now: false,
    exclusion_rationale: 'Requires prior index runs; fresh projects have single run. Non-deterministic across environments.',
  },
  // ── Admin/infra (excluded from benchmark) ──
  {
    tool_name: 'index_repository', classification: 'admin/infra', coverage: 'excluded',
    task_id: undefined, direct_deterministic_test: false,
    required_seeded_state: '',
    executable_now: false,
    exclusion_rationale: 'Admin tool: creates/rebuilds index. Not an agent exploration task.',
  },
  {
    tool_name: 'index_status', classification: 'admin/infra', coverage: 'excluded',
    task_id: undefined, direct_deterministic_test: false,
    required_seeded_state: '',
    executable_now: false,
    exclusion_rationale: 'Admin tool: queries index health. Not an agent exploration task.',
  },
  {
    tool_name: 'list_projects', classification: 'admin/infra', coverage: 'excluded',
    task_id: undefined, direct_deterministic_test: false,
    required_seeded_state: '',
    executable_now: false,
    exclusion_rationale: 'Admin tool: lists indexed projects. Not an agent exploration task.',
  },
  {
    tool_name: 'delete_project', classification: 'admin/infra', coverage: 'excluded',
    task_id: undefined, direct_deterministic_test: false,
    required_seeded_state: '',
    executable_now: false,
    exclusion_rationale: 'Admin tool: destructive. Not an agent exploration task.',
  },
  {
    tool_name: 'manage_adr', classification: 'admin/infra', coverage: 'excluded',
    task_id: undefined, direct_deterministic_test: false,
    required_seeded_state: '',
    executable_now: false,
    exclusion_rationale: 'Admin tool: Architecture Decision Records management. Not a code exploration task.',
  },
  {
    tool_name: 'ingest_traces', classification: 'admin/infra', coverage: 'excluded',
    task_id: undefined, direct_deterministic_test: false,
    required_seeded_state: '',
    executable_now: false,
    exclusion_rationale: 'Admin tool: runtime trace ingestion. Not an agent exploration task.',
  },
  {
    tool_name: 'watch_project', classification: 'admin/infra', coverage: 'excluded',
    task_id: undefined, direct_deterministic_test: false,
    required_seeded_state: '',
    executable_now: false,
    exclusion_rationale: 'Admin tool: file watcher automation. Not an agent exploration task.',
  },
];

/**
 * Returns counts of executable / designed-only / excluded tools.
 */
export function coverageSummary(): { executable: number; designed_only: number; excluded: number; total: number } {
  const executable = TOOL_COVERAGE.filter(e => e.coverage === 'executable').length;
  const designedOnly = TOOL_COVERAGE.filter(e => e.coverage === 'designed-only').length;
  const excluded = TOOL_COVERAGE.filter(e => e.coverage === 'excluded').length;
  return { executable, designed_only: designedOnly, excluded, total: TOOL_COVERAGE.length };
}

/**
 * Returns tools that are classified as designed-only (unsupported/unseeded),
 * for reporting in benchmark warnings.
 */
export function designedOnlyTools(): string[] {
  return TOOL_COVERAGE.filter(e => e.coverage === 'designed-only').map(e => e.tool_name);
}

// ── Expanded tool definitions (20 agent-relevant tools) ────────

export function makeLynxToolsRealistic(): AgentToolDefinition[] {
  const benchmarkToolNames = new Set([
    'search_graph', 'trace_path', 'explain_symbol', 'find_tests',
    'get_architecture', 'analyze_hotspots', 'find_dead_code', 'get_graph_schema',
    'semantic_search', 'batch_get_code', 'get_code_snippet', 'search_code',
    'smart_review', 'detect_changes', 'pack_memory', 'query_graph',
    'compare_runs', 'pack_context', 'get_edge_evidence', 'investigate_symbol',
  ]);
  const catalogTools = TOOLS
    .map(withEvidenceDiscipline)
    .filter((tool) => benchmarkToolNames.has(tool.name))
    .map((tool) => {
      const inputSchema = tool.inputSchema as {
        type: string;
        properties: Record<string, unknown>;
        required?: string[];
      };
      const { project: _project, ...properties } = inputSchema.properties;
      return {
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            ...inputSchema,
            properties,
            required: (inputSchema.required || []).filter((name) => name !== 'project'),
          },
        },
      };
    });
  const readFileTool: AgentToolDefinition = {
    type: 'function',
    function: {
      name: 'read_file',
      description: `Read a project file only when graph/snippet tools cannot provide the required evidence. Prefer focused LYNX reads over full-file reads.${EVIDENCE_DISCIPLINE}`,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative file path in the project' } },
        required: ['path'],
      },
    },
  };
  return [...catalogTools, readFileTool];
}

// ── Realistic task set ─────────────────────────────────────────

function safeReadFileRealistic(fixtureDir: string, requestedPath: string): string {
  const resolved = path.resolve(fixtureDir, requestedPath);
  const normalizedFixture = path.resolve(fixtureDir) + path.sep;
  if (!resolved.startsWith(normalizedFixture)) {
    return `Error: path traversal denied for "${requestedPath}"`;
  }
  try {
    return fs.readFileSync(resolved, 'utf-8');
  } catch {
    return `Error: cannot read file "${requestedPath}"`;
  }
}

// ── Tool dispatcher (data-driven) ───────────────────────────────

type ToolHandler = (
  args: Record<string, unknown>,
  project: string,
) => Promise<unknown>;

const TOOL_DISPATCHERS: Record<string, ToolHandler> = {
  search_graph: (a, p) => handleSearchGraph({ project: p, query: String(a.query || ''), label: a.label ? String(a.label) : undefined, limit: a.limit ? Number(a.limit) : 10, enable_llm: false }),
  trace_path: (a, p) => handleTracePath({ project: p, function_name: String(a.function_name || ''), direction: (a.direction as string) || 'both', depth: a.depth ? Number(a.depth) : 3, include_tests: false }),
  explain_symbol: (a, p) => handleExplainSymbol({ project: p, name: String(a.name || ''), qualified_name: a.qualified_name ? String(a.qualified_name) : undefined }),
  find_tests: (a, p) => handleFindTests({ project: p, name: String(a.name || '') }),
  get_architecture: (a, p) => handleGetArchitecture({ project: p, aspects: a.aspects as string[] | undefined }),
  analyze_hotspots: (a, p) => handleAnalyzeHotspots({ project: p, limit: a.limit ? Number(a.limit) : 10 }),
  find_dead_code: (a, p) => handleFindDeadCode({ project: p, kinds: a.kinds, path: a.path, limit: a.limit }),
  get_graph_schema: (_a, p) => handleGetGraphSchema({ project: p }),
  semantic_search: (a, p) => handleSemanticSearch({ project: p, query: String(a.query || ''), kind: a.kind ? String(a.kind) : undefined, limit: a.limit ? Number(a.limit) : 10 }),
  batch_get_code: (a, p) => handleBatchGetCode({ project: p, qualified_names: (a.qualified_names as string[]) || [] }),
  get_code_snippet: (a, p) => handleGetCodeSnippet({ project: p, qualified_name: String(a.qualified_name || '') }),
  search_code: (a, p) => handleSearchCode({ project: p, pattern: String(a.pattern || ''), file_pattern: a.file_pattern ? String(a.file_pattern) : undefined, limit: a.limit ? Number(a.limit) : 10 }),
  smart_review: (a, p) => handleSmartReview({ project: p, file: a.file ? String(a.file) : undefined, qualified_name: a.qualified_name ? String(a.qualified_name) : undefined }),
  detect_changes: (a, p) => handleDetectChanges({ project: p, scope: (a.scope as string) || 'files' }),
  pack_memory: (a, p) => handlePackMemory({ project: p, target_file: a.target_file ? String(a.target_file) : undefined, target_qn: a.target_qn ? String(a.target_qn) : undefined }),
  query_graph: (a, p) => handleQueryGraph({ project: p, query: String(a.query || '') }),
  compare_runs: (_a, p) => handleCompareRuns({ project: p }),
  pack_context: (a, p) => handlePackContext({ task: String(a.task || ''), project: p }),
  get_edge_evidence: (a, p) => handleGetEdgeEvidence({ project: p, edge_id: a.edge_id, source_name: a.source_name, target_name: a.target_name, type: a.type }),
  investigate_symbol: (a, p) => handleInvestigateSymbol({ project: p, symbol: String(a.symbol || a.name || a.qualified_name || ''), depth: a.depth ? Number(a.depth) : 2 }),
};

export async function executeLynxToolRealistic(
  toolName: string,
  args: Record<string, unknown>,
  project: string,
  fixtureDir: string
): Promise<string> {
  if (toolName === 'read_file') return safeReadFileRealistic(fixtureDir, String(args.path || ''));
  const handler = TOOL_DISPATCHERS[toolName];
  if (!handler) return `Unknown tool: ${toolName}`;
  return JSON.stringify(await handler(args, project));
}

// ── Baseline executor (realistic — identical to core baseline) ─

import { redactSecrets } from './api-client.js';

export function executeBaselineToolRealistic(
  toolName: string,
  args: Record<string, unknown>,
  fixtureDir: string
): string {
  switch (toolName) {
    case 'read_file': {
      return safeReadFileRealistic(fixtureDir, String(args.path || ''));
    }
    case 'grep': {
      const pattern = String(args.pattern || '');
      const include = args.include ? String(args.include) : '*.ts';
      const result = spawnSync(
        'grep',
        ['-rn', pattern, `--include=${include}`, fixtureDir],
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 10000 }
      );
      if (result.status === 1) return '(no matches)';
      if (result.error) return `Error: ${redactSecrets(result.error.message)}`;
      return result.stdout || '(no matches)';
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ── Task definitions ───────────────────────────────────────────

export interface RealisticTask {
  id: string;
  name: string;
  userPrompt: string;
  expected: Record<string, unknown>;
  evaluation_kind: EvaluationKind;
}

/** Core 5 tasks (identical to default suite for comparability). */
export const TASKS_CORE: RealisticTask[] = [
  {
    id: 'find_definition',
    name: 'Find lynxHome definition',
    userPrompt:
      'Find where the function "lynxHome" is defined. What file is it in? What does it return? ' +
      'Respond with JSON: {"found_file": "<relative path>", "function_name": "lynxHome", "returns_path": true/false}',
    expected: { found_file: 'runtime.ts', function_name: 'lynxHome', returns_path: true },
    evaluation_kind: 'deterministic',
  },
  {
    id: 'find_callers',
    name: 'Find callers of readConfig',
    userPrompt:
      'Find all functions that call "readConfig". List them as an array of {name, file_path} objects in JSON. ' +
      'Respond with JSON: {"callers": [{"name": "...", "file_path": "..."}]}',
    expected: { callers: [{ name: 'openDb' }, { name: 'dbPath' }] },
    evaluation_kind: 'deterministic',
  },
  {
    id: 'change_impact',
    name: 'Assess impact of Config change',
    userPrompt:
      'Determine what functions are impacted if the "Config" interface changes in the project. ' +
      'List the names of impacted functions. ' +
      'Respond with JSON: {"impacted_functions": ["func1", "func2"], "references": N}',
    expected: { impacted_functions: ['readConfig', 'openDb'], references: 2 },
    evaluation_kind: 'deterministic',
  },
  {
    id: 'find_tests',
    name: 'Find tests for lynxHome',
    userPrompt:
      'Find all test functions that test "lynxHome". List them as JSON: ' +
      '{"test_functions": [{"name": "...", "file_path": "..."}], "total_tests": N}',
    expected: {
      test_functions: [
        { name: 'testLynxHomeReturnsString' },
        { name: 'testLynxHomeRespectsEnv' },
      ],
    },
    evaluation_kind: 'deterministic',
  },
  {
    id: 'locate_definitions',
    name: 'Locate multiple definitions',
    userPrompt:
      'Find the source locations (file and start line) for these three functions: lynxHome, openDb, formatPath. ' +
      'Respond with JSON: {"definitions": [{"name": "...", "file_path": "...", "start_line": N}]}',
    expected: {
      definitions: [
        { name: 'lynxHome', file_path: 'runtime.ts' },
        { name: 'openDb', file_path: 'db.ts' },
        { name: 'formatPath', file_path: 'helpers.ts' },
      ],
    },
    evaluation_kind: 'deterministic',
  },
];

/** Workflow 10 tasks (exercising previously uncovered tools). */
export const TASKS_WORKFLOW: RealisticTask[] = [
  {
    id: 'architecture_languages',
    name: 'Architecture: languages overview',
    userPrompt:
      'Use get_architecture to discover what programming languages are used in this project. ' +
      'Respond with JSON: {"languages": ["lang1"], "primary_language": "lang1", "has_file_tree": true/false}',
    expected: {
      languages: ['TypeScript'],
      primary_language: 'TypeScript',
      has_file_tree: true,
    },
    evaluation_kind: 'deterministic',
  },
  {
    id: 'top_hotspots',
    name: 'Analyze top riskiest functions',
    userPrompt:
      'Use analyze_hotspots to find the top 5 riskiest functions by fan-in. ' +
      'Respond with JSON: {"hotspots": [{"name": "..."}], "top_name": "...", "critical_count": N}',
    expected: {
      hotspots: [{ name: 'lynxHome' }],
      top_name: 'lynxHome',
    },
    evaluation_kind: 'deterministic',
  },
  {
    id: 'graph_schema',
    name: 'Explore graph schema',
    userPrompt:
      'Use get_graph_schema to discover the node labels and edge types in the code knowledge graph. ' +
      'Respond with JSON: {"node_labels": ["Label1"], "has_calls_edge": true/false, "has_tests_edge": true/false}',
    expected: {
      node_labels: ['Function', 'File', 'Interface'],
      has_calls_edge: true,
      has_tests_edge: true,
    },
    evaluation_kind: 'deterministic',
  },
  {
    id: 'semantic_search',
    name: 'Semantic search: API key handling',
    userPrompt:
      'Use semantic_search to find code that handles API key resolution or credential management. ' +
      'Respond with JSON: {"found_symbols": [{"name": "..."}], "found_file": "...", "results_count": N}',
    expected: {
      found_symbols: [{ name: 'getApiKey' }],
      found_file: 'credentials',
    },
    evaluation_kind: 'deterministic',
  },
  {
    id: 'batch_get_code',
    name: 'Batch read multiple symbols',
    userPrompt:
      'Use batch_get_code to read the source of both lynxHome and openDb in a single call. ' +
      'Respond with JSON: {"functions": ["func1", "func2"], "snippets_returned": N}',
    expected: {
      functions: ['lynxHome', 'openDb'],
    },
    evaluation_kind: 'deterministic',
  },
  {
    id: 'search_code',
    name: 'Search code for env var references',
    userPrompt:
      'Use search_code to find all references to "LYNX_DEEPSEEK_KEY" in the codebase. ' +
      'Respond with JSON: {"pattern": "LYNX_DEEPSEEK_KEY", "matches_found": N, "found_in": ["file1.ts"]}',
    expected: {
      pattern: 'LYNX_DEEPSEEK_KEY',
      found_in: ['credentials'],
    },
    evaluation_kind: 'deterministic',
  },
  {
    id: 'edge_evidence',
    name: 'Verify relationship evidence',
    userPrompt:
      'Use get_edge_evidence to verify the relationship between lynxConfigPath and lynxHome. ' +
      'Respond with JSON: {"evidence_count": N, "verified": true/false}',
    expected: {
      evidence_count: 1,
      verified: true,
    },
    evaluation_kind: 'deterministic',
  },
  {
    id: 'investigate_symbol',
    name: 'Investigate symbol end-to-end context pack',
    userPrompt:
      'Use investigate_symbol on the symbol "lynxHome" to gather its definition, behavior, call relationships, source snippet, and related tests. ' +
      'Respond with JSON: {"symbol":"...", "has_definition":true/false, "has_trace":true/false, "has_snippet":true/false, "has_tests":true/false, "summary":"..."}',
    expected: {},
    evaluation_kind: 'designed-only',
  },
  // ── Designed-only tasks (no deterministic assertion possible) ──
  {
    id: 'smart_review',
    name: 'Smart review of api-client.ts',
    userPrompt:
      'Use smart_review on the file "src/cli/agent-ab/api-client.ts" to identify complexity, coupling, and test coverage issues. ' +
      'Respond with JSON: {"file_reviewed": "...", "issues_found": N, "top_category": "..."}',
    expected: {},
    evaluation_kind: 'designed-only',
  },
  {
    id: 'detect_changes',
    name: 'Detect code changes and impact',
    userPrompt:
      'Use detect_changes to find what files have changed in the working tree and assess their impact. ' +
      'Respond with JSON: {"has_changes": true/false, "changed_files": N, "impact_tier": "..."}',
    expected: {},
    evaluation_kind: 'designed-only',
  },
  {
    id: 'pack_memory',
    name: 'Retrieve analysis memory',
    userPrompt:
      'Use pack_memory to retrieve past analysis findings for api-client.ts. ' +
      'Respond with JSON: {"has_findings": true/false, "categories_found": ["cat1"]}',
    expected: {},
    evaluation_kind: 'designed-only',
  },
  {
    id: 'query_graph',
    name: 'Query graph for high-complexity functions',
    userPrompt:
      'Use query_graph with a Cypher query to find functions with high cyclomatic complexity (> 5) and their test coverage. ' +
      'Respond with JSON: {"functions_found": N, "top_function": "...", "has_results": true/false}',
    expected: {},
    evaluation_kind: 'designed-only',
  },
];

/** All 16 tasks: 5 core + 11 workflow. */
export const TASKS_REALISTIC: RealisticTask[] = [...TASKS_CORE, ...TASKS_WORKFLOW];

/** Task IDs whose expected={} are designed-only (no deterministic assertion). */
export const DESIGNED_ONLY_TASK_IDS = new Set(['smart_review', 'detect_changes', 'pack_memory', 'query_graph', 'investigate_symbol']);

/** Task IDs with partial expected (some fields deterministic). */
export const PARTIAL_EXPECTED_TASK_IDS = new Set<string>();

/** Canonical contract for architecture output: file extensions are normalized to language names. */
export function normalizeArchitectureLanguage(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'ts' || normalized === 'tsx' || normalized === 'typescript') return 'TypeScript';
  if (normalized === 'js' || normalized === 'jsx' || normalized === 'javascript') return 'JavaScript';
  return value;
}

export function taskEvaluationSummary(tasks: RealisticTask[] = TASKS_REALISTIC): Record<EvaluationKind, number> {
  return tasks.reduce<Record<EvaluationKind, number>>((summary, task) => {
    summary[task.evaluation_kind]++;
    return summary;
  }, { deterministic: 0, partial: 0, 'designed-only': 0 });
}

/**
 * Offline-only contract validation. It intentionally operates on the isolated
 * fixture, never reads the caller's repository or calls the LLM API.
 */
export function validateRealisticSuitePreflight(
  fixtureDir: string,
  exposedToolNames: string[]
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const taskById = new Map(TASKS_REALISTIC.map(task => [task.id, task]));
  if (taskById.size !== TASKS_REALISTIC.length) errors.push('duplicate realistic task IDs');

  for (const entry of TOOL_COVERAGE) {
    if (!entry.task_id) continue;
    const task = taskById.get(entry.task_id);
    if (!task) {
      errors.push(`coverage entry ${entry.tool_name} references missing task ${entry.task_id}`);
      continue;
    }
    if (entry.classification === 'agent' && !exposedToolNames.includes(entry.tool_name)) {
      errors.push(`required tool ${entry.tool_name} for task ${task.id} is not exposed`);
    }
    if (task.evaluation_kind === 'deterministic' && (entry.coverage !== 'executable' || Object.keys(task.expected).length === 0)) {
      errors.push(`deterministic task ${task.id} lacks executable deterministic expectations`);
    }
  }

  for (const task of TASKS_REALISTIC) {
    if (task.evaluation_kind === 'designed-only' && Object.keys(task.expected).length !== 0) {
      errors.push(`designed-only task ${task.id} must not have deterministic expectations`);
    }
  }

  const requiredFixtureEvidence: Record<string, Array<{ file: string; text: string }>> = {
    architecture_languages: [{ file: 'src/config/runtime.ts', text: 'export function lynxHome' }],
    top_hotspots: [{ file: 'src/config/runtime.ts', text: 'lynxHome' }],
    semantic_search: [{ file: 'src/config/credentials.ts', text: 'getApiKey' }],
    search_code: [{ file: 'src/config/credentials.ts', text: 'LYNX_DEEPSEEK_KEY' }],
    batch_get_code: [
      { file: 'src/config/runtime.ts', text: 'lynxHome' },
      { file: 'src/store/db.ts', text: 'openDb' },
    ],
  };
  for (const [taskId, evidence] of Object.entries(requiredFixtureEvidence)) {
    for (const requirement of evidence) {
      const resolved = path.resolve(fixtureDir, requirement.file);
      const root = path.resolve(fixtureDir) + path.sep;
      if (!resolved.startsWith(root)) {
        errors.push(`expected fixture path escapes isolation: ${requirement.file}`);
        continue;
      }
      if (!fs.existsSync(resolved) || !fs.readFileSync(resolved, 'utf-8').includes(requirement.text)) {
        errors.push(`task ${taskId} requires seeded ${requirement.text} in ${requirement.file}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
