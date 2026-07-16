/*
 * tools.ts — LYNX MCP tool registry.
 *
 * Defines all tools with their input schemas.
 * Each tool maps to a handler function in handlers/.
 */

export interface LynxToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * MCP tool safety metadata. Hosts that support MCP annotations can use this
   * to approve discovery calls without treating them as filesystem writes.
   */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

export const EVIDENCE_DISCIPLINE =
  ' Use the smallest sufficient call; reuse evidence; broaden only if needed; stop when supported.';

const EVIDENCE_TOOLS = new Set([
  'pack_context', 'search_graph', 'trace_path', 'get_code_snippet',
  'get_architecture', 'query_graph', 'get_graph_schema', 'search_code',
  'detect_changes', 'assess_impact', 'pack_memory', 'analyze_hotspots',
  'find_dead_code', 'compare_runs', 'explain_symbol', 'smart_review',
  'semantic_search', 'find_tests', 'batch_get_code',
  'diagnose', 'usage_summary', 'get_edge_evidence',
  'investigate_symbol',
]);

/** Tools which only inspect an already indexed project or its working tree. */
export const READ_ONLY_TOOL_NAMES = new Set([
  'tool_catalog', 'pack_context', 'search_graph', 'trace_path',
  'get_code_snippet', 'get_architecture', 'query_graph', 'index_status',
  'list_projects', 'get_graph_schema', 'search_code', 'get_edge_evidence', 'detect_changes',
  'assess_impact', 'pack_memory', 'analyze_hotspots', 'find_dead_code',
  'compare_runs', 'explain_symbol', 'smart_review', 'semantic_search',
  'find_tests', 'batch_get_code', 'diagnose', 'usage_summary',
  'investigate_symbol',
]);

const DESTRUCTIVE_TOOL_NAMES = new Set(['delete_project']);

export function withSafetyAnnotations(tool: LynxToolDef): LynxToolDef {
  const readOnlyHint = READ_ONLY_TOOL_NAMES.has(tool.name);
  return {
    ...tool,
    annotations: {
      readOnlyHint,
      destructiveHint: DESTRUCTIVE_TOOL_NAMES.has(tool.name),
      idempotentHint: readOnlyHint,
      ...tool.annotations,
    },
  };
}

export function withEvidenceDiscipline(tool: LynxToolDef): LynxToolDef {
  if (!EVIDENCE_TOOLS.has(tool.name)) return tool;
  return { ...tool, description: tool.description + EVIDENCE_DISCIPLINE };
}

export const TOOLS: LynxToolDef[] = [
  {
    name: 'tool_catalog',
    description: 'Show the core workflow and advanced LYNX tools available on demand. Use when the task needs a capability not exposed in the current profile.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pack_context',
    description:
      'Build a compact, task-oriented context pack for broad or uncertain code tasks. ' +
      'Returns likely areas, safety constraints, recommended graph/search calls, ' +
      'and validation steps. Use early for non-trivial tasks when the relevant scope or safety constraints are not already clear.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The user task or intended change.' },
        project: { type: 'string', description: 'Indexed project name. Optional.' },
        mode: {
          type: 'string',
          enum: ['compact', 'full', 'decision'],
          description: 'compact: minimal guidance. full: include extra rationale. decision: include a change-risk summary for an indexed project.',
        },
        enable_llm: { type: 'boolean', description: 'Opt in to LLM re-ranking for ambiguous candidate ordering. Default false.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'search_graph',
    description:
      'Search the code knowledge graph for functions, classes, routes, and variables. ' +
      'Use for indexed code definitions, implementations, and structural relationships when graph evidence is useful. ' +
      'Three search modes: (1) query for BM25 ranked full-text search with camelCase splitting, ' +
      '(2) name_pattern/qn_pattern for the supported regex subset, or name_like/qn_like for explicit SQL LIKE matching, ' +
      '(3) semantic_query for vector cosine search. ' +
      'Request include_snippets when source previews would help choose the next symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword full-text search.' },
        project: { type: 'string' },
        label: { type: 'string', description: 'Filter by node kind: Function, Class, Method, Route, etc.' },
        name_pattern: { type: 'string', description: 'Regex on name.' },
        qn_pattern: { type: 'string', description: 'Regex on qualified_name.' },
        name_like: { type: 'string', description: 'SQL LIKE pattern on name (% and _ wildcards).' },
        qn_like: { type: 'string', description: 'SQL LIKE pattern on qualified_name (% and _ wildcards).' },
        file_pattern: { type: 'string', description: 'Glob pattern on file_path.' },
        min_degree: { type: 'integer', description: 'Minimum total degree (in+out edges).' },
        max_degree: { type: 'integer', description: 'Maximum total degree.' },
        exclude_entry_points: { type: 'boolean', description: 'Exclude entry points (CLI commands, HTTP handlers).' },
        include_connected: { type: 'boolean', description: 'Include nodes connected to matches.' },
        limit: { type: 'integer', description: 'Max results (compact default in maximum-savings mode).' },
        offset: { type: 'integer', description: 'Pagination offset.' },
        semantic_query: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of keywords for semantic search.',
        },
        enable_llm: { type: 'boolean', description: 'Opt in to LLM re-ranking for ambiguous searches. Default false.' },
        include_snippets: { type: 'boolean', description: 'Include source previews. In maximum-savings mode this is opt-in.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'trace_path',
    description:
      'Trace callers/callees and labelled references through the code graph in one call. Each entry identifies whether its evidence is a direct call or a reference. ' +
      'Use mode=calls for control flow, references for bindings/state usage, data_flow for both, or auto for Swift-aware fallback when direct calls are absent.',
    inputSchema: {
      type: 'object',
      properties: {
        function_name: { type: 'string', description: 'Function qualified name or name to trace from.' },
        project: { type: 'string' },
        direction: { type: 'string', enum: ['inbound', 'outbound', 'both'], description: 'outbound for end-to-end workflow/callee tracing; inbound for callers/impact; both only when both directions are required.' },
        depth: { type: 'integer', description: 'Max BFS depth (default 3). Use 4 for representative end-to-end workflows.' },
        mode: { type: 'string', enum: ['calls', 'references', 'data_flow', 'cross_service', 'auto'], description: 'calls keeps direct control-flow semantics; references includes READS/USAGE; auto expands only for a Swift symbol with no direct calls.' },
        risk_labels: { type: 'boolean', description: 'Add CRITICAL/HIGH/MEDIUM/LOW risk labels based on hop distance.' },
        include_tests: { type: 'boolean', description: 'Include test files in results.' },
        edge_types: { type: 'array', items: { type: 'string' }, description: 'Optional explicit edge-type override (for example CALLS, READS, USAGE).' },
        include_edges: { type: 'boolean', description: 'Include a compact labelled edge page.' },
        include_evidence: { type: 'boolean', description: 'Annotate each edge with its captured evidence (file, line, extractor, confidence). Eliminates a separate get_edge_evidence round-trip.' },
      },
      required: ['function_name', 'project'],
    },
  },
  {
    name: 'get_code_snippet',
    description:
      'Read source code for a function/class/symbol. When include_neighbors=true, also returns enriched callers/callees with file_path+signature and test coverage — eliminating separate trace_path+find_tests calls. ' +
      'For 3+ symbols at once, prefer batch_get_code.',
    inputSchema: {
      type: 'object',
      properties: {
        qualified_name: { type: 'string', description: 'Full qualified_name from search_graph.' },
        project: { type: 'string' },
        include_neighbors: { type: 'boolean', description: 'Include caller/callee names.' },
        max_lines: { type: 'integer', description: 'Expand source beyond the compact default when needed.' },
      },
      required: ['qualified_name', 'project'],
    },
  },
  {
    name: 'get_architecture',
    description:
      'Get high-level architecture overview: languages, hotspots, clusters, file tree, node/edge counts. ' +
      'For a first overview, use the compact default, then request only a missing aspect. Treat returned sections as reusable evidence; do not read every source file after an overview—use get_code_snippet only for the one or two symbols that need verification.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        path: { type: 'string', description: 'Optional directory prefix to scope analysis.' },
        aspects: {
          type: 'array',
          items: { type: 'string', enum: ['languages', 'hotspots', 'clusters', 'file_tree', 'entry_points', 'brief', 'narrative', 'node_labels', 'edge_types'] },
          description: 'Which sections to include. Omit for all. Use to control token budget.',
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'query_graph',
    description:
      'Execute a Cypher-like query against the knowledge graph for complex multi-hop patterns and aggregations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Cypher query.' },
        project: { type: 'string' },
        max_rows: { type: 'integer', description: 'Maximum rows. Default is compact in maximum-savings mode.' },
      },
      required: ['query', 'project'],
    },
  },
  {
    name: 'index_repository',
    description:
      'Index a repository into the knowledge graph. ' +
      'Incremental mode (default) skips files whose SHA256 hash matches the last indexed run, ' +
      'making re-indexes orders of magnitude faster.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string', description: 'Path to the repository.' },
        mode: {
          type: 'string',
          enum: ['full', 'moderate', 'fast'],
          description: 'Index mode. moderate is default.',
        },
        name: { type: 'string', description: 'Override the derived project name.' },
        incremental: {
          type: 'boolean',
          description: 'Skip files whose SHA256 has not changed since last run. Default true.',
        },
        force_lock: {
          type: 'boolean',
          description: 'Override a stale lock. Use only when a previous index run crashed.',
        },
      },
      required: ['repo_path'],
    },
  },
  {
    name: 'index_status',
    description: 'Get the indexing status of a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
      },
      required: ['project'],
    },
  },
  {
    name: 'get_edge_evidence',
    description: 'Get the evidence backing a graph edge and explain why the relationship exists in the code graph.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        edge_id: { type: 'integer', description: 'Direct edge ID if known.' },
        source_name: { type: 'string', description: 'Source symbol name.' },
        target_name: { type: 'string', description: 'Target symbol name.' },
        type: { type: 'string', description: 'Optional edge type filter.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'investigate_symbol',
    description:
      'Meta-tool: deep-dive into a single symbol in one call. Internally orchestrates search_graph → explain_symbol → trace_path (with evidence) → get_code_snippet → find_tests. ' +
      'Returns a unified context pack. Use instead of chaining 4-5 separate discovery tools when the agent needs a complete picture of a function, class, or method.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        symbol: { type: 'string', description: 'Symbol name or qualified_name to investigate.' },
        name: { type: 'string', description: 'Alias for symbol.' },
        qualified_name: { type: 'string', description: 'Alias for symbol.' },
        depth: { type: 'integer', description: 'Max BFS depth for trace_path (default 2).' },
        include_evidence: { type: 'boolean', description: 'Include edge evidence in traces (default true).' },
        verbose: { type: 'boolean', description: 'Include value_metrics, llm_usage, and index context (default false — compact agent-friendly output).' },
      },
      required: ['project', 'symbol'],
    },
  },
  {
    name: 'diagnose',
    description: 'Run fast local LYNX health checks: runtime availability, index freshness, orphaned locks, and safe configuration status. Does not make network calls or expose credentials.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'usage_summary',
    description: 'Summarize locally recorded LYNX usage and estimated savings for one project or all projects. Estimates are clearly separated from provider billing and graph confidence.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Optional indexed project name.' },
        limit: { type: 'integer', description: 'Maximum recent events to include (default 1000, maximum 10000).' },
      },
    },
  },
  {
    name: 'list_projects',
    description: 'List all indexed projects.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'delete_project',
    description: 'Delete a project from the index.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
      },
      required: ['project'],
    },
  },
  {
    name: 'get_graph_schema',
    description: 'Get the schema of the knowledge graph (node labels, edge types).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
      },
      required: ['project'],
    },
  },
  {
    name: 'search_code',
    description:
      'Graph-augmented code search. Finds text patterns via grep, then enriches results with the knowledge graph. ' +
      'Modes: compact (default, signatures), full (with source), files (just file paths). Combine alternative spellings or file conventions for the same hypothesis into one regex search instead of serial equivalent searches; after a conclusive no-match, stop unless new evidence identifies a materially different scope.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex to search for.' },
        project: { type: 'string' },
        file_pattern: { type: 'string', description: 'Glob for file filtering (e.g. *.go).' },
        path_filter: { type: 'string', description: 'Regex filter on result file paths.' },
        mode: { type: 'string', enum: ['compact', 'full', 'files'], description: 'Output mode.' },
        regex: { type: 'boolean', description: 'Treat pattern as regex.' },
        limit: { type: 'integer', description: 'Max results (default 10).' },
        context: { type: 'integer', description: 'Lines of context around each match.' },
      },
      required: ['pattern', 'project'],
    },
  },
  {
    name: 'detect_changes',
    description: 'Detect code changes and their impact. Returns categorised output: staged, unstaged, untracked, deleted, renamed files. Impact tiers: confirmed (CALLS/IMPORTS edges), probable (same-module), nominal (name-only). Use --files to scope analysis to specific paths.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        base_branch: { type: 'string', description: 'Base branch for diff (default main).' },
        since: { type: 'string', description: 'Git ref or tag to compare from (e.g. HEAD~5, v0.5.0).' },
        include_committed: { type: 'boolean', description: 'Include changes already committed relative to the base. In maximum-savings mode, local worktree changes are the default unless a ref is supplied.' },
        scope: { type: 'string', enum: ['files', 'symbols'], description: 'files: just paths, symbols: paths + impacted functions.' },
        depth: { type: 'integer', description: 'Call depth for impact analysis (default 2).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Comma-separated or array of file paths to scope analysis. Only these files appear in primary results; dependencies outside scope go in related_dependencies.' },
        include_diff: { type: 'boolean', description: 'Include git diff content. Omitted in maximum-savings mode unless requested.' },
        enable_llm: { type: 'boolean', description: 'Opt in to LLM risk assessment. Default false.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'assess_impact',
    description: 'Cross-reference git changes with graph and tests. Runs 5 queries: tests covering changes, untested changes, new symbols without callers, deleted symbols with live references, unindexed modified files. Returns structured findings with evidence and confidence per finding.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional file list to scope analysis. If omitted, all git-diff files are analyzed.' },
        base_branch: { type: 'string', description: 'Base branch for git diff (default main).' },
      },
      required: ['project'],
    },
  },
  {
    name: 'manage_adr',
    description: 'Create or update Architecture Decision Records.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        mode: { type: 'string', enum: ['get', 'update', 'sections'], description: 'get: read ADR, update: write ADR, sections: list headers.' },
        content: { type: 'string', description: 'Markdown content for update mode.' },
        sections: { type: 'array', items: { type: 'string' }, description: 'Section names for sections mode.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'ingest_traces',
    description: 'Ingest runtime traces to enhance the knowledge graph.',
    inputSchema: {
      type: 'object',
      properties: {
        traces: { type: 'array', items: { type: 'object' }, description: 'Array of trace objects.' },
        project: { type: 'string' },
      },
      required: ['traces', 'project'],
    },
  },
  {
    name: 'pack_memory',
    description:
      'Retrieve persistent analysis findings for a file or function. ' +
      'Returns past hotspots, complexity assessments, and review notes.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        target_qn: { type: 'string', description: 'Qualified name of function/class to look up.' },
        target_file: { type: 'string', description: 'File path to look up findings for.' },
        category: { type: 'string', description: 'Filter by category: hotspot, complexity, cluster, review.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'analyze_hotspots',
    description:
      'Get a complete scalability snapshot: largest files, complexity, coupling, hotspots, project averages, and genuinely large components. Use only when the task is specifically about quality, complexity, scalability, or risk—not as the first general project overview. For small projects, prefer get_architecture plus targeted get_code_snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        limit: { type: 'integer', description: 'Max results (default 10).' },
        include_god_components: { type: 'boolean', description: 'Include only classes/modules of at least 300 lines. Default true.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'find_dead_code',
    description:
      'Find graph-verified dead-code candidates in one call. Returns exact function/method/class definitions with zero incoming CALLS, USAGE, READS, or TESTS edges, excluding tests and entry points. Use instead of query_graph plus per-symbol search_code/trace_path loops. Results are candidates; exported symbols include a public-API caveat.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['Function', 'Method', 'Class'] },
          description: 'Symbol kinds to inspect. Defaults to all three.',
        },
        path: { type: 'string', description: 'Optional repository-relative path prefix.' },
        limit: { type: 'integer', description: 'Max candidates (default 30, max 100).' },
      },
      required: ['project'],
    },
  },
  {
    name: 'compare_runs',
    description:
      'Compare the last two index runs for a project. Returns deltas (nodes, edges, hotspots, ' +
      'avg complexity) and a narrative summary of what changed between indexing runs.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
      },
      required: ['project'],
    },
  },
  {
    name: 'explain_symbol',
    description:
      'Get a detailed explanation of a code symbol (function, class, method). Returns source code, ' +
      'callers, callees, complexity metrics, risk assessment, related findings, and a Spanish narrative.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        qualified_name: { type: 'string', description: 'Full qualified name from search_graph.' },
        name: { type: 'string', description: 'Short name fallback if qualified_name not known.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'smart_review',
    description:
      'Automated code review using graph intelligence. Analyzes a file or function for ' +
      'complexity, size, coupling, test coverage, and performance risk signals. Returns heuristic findings that require verification before claiming runtime impact or Big-O complexity.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        file: { type: 'string', description: 'File path to review (all functions in file).' },
        qualified_name: { type: 'string', description: 'Single function/class to review.' },
        limit: { type: 'integer', description: 'Max issues (default 20).' },
      },
      required: ['project'],
    },
  },
  {
    name: 'semantic_search',
    description:
      'Natural-language code search with fuzzy name matching and graph-aware scoring. ' +
      'Scores by token overlap, graph importance, and memory findings. Better than search_graph ' +
      'when you describe intent rather than exact names.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        query: { type: 'string', description: 'Natural language query (e.g. "user authentication handler").' },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Alternative: array of keyword tokens.',
        },
        kind: { type: 'string', description: 'Filter by kind: Function, Method, Class, Interface, Variable, Route.' },
        file_pattern: { type: 'string', description: 'Glob pattern to narrow files.' },
        limit: { type: 'integer', description: 'Max results (default 10).' },
      },
      required: ['project'],
    },
  },
  {
    name: 'watch_project',
    description:
      'Start/stop/status the real-time file watcher for a project. The watcher re-indexes ' +
      'changed files automatically so the code graph stays up-to-date without manual re-indexing.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status'],
          description: 'start: begin watching, stop: stop watcher, status: get current state.',
        },
        mode: { type: 'string', enum: ['full', 'moderate', 'fast'], description: 'Index mode for watcher (default fast).' },
      },
      required: ['project'],
    },
  },
  {
    name: 'find_tests',
    description:
      'Find test functions that cover a given symbol. Queries TESTS edges ' +
      '(test function → production function) in reverse to return all test functions ' +
      'that exercise the target. Saves multiple grep/read round-trips vs searching test ' +
      'files manually.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        qualified_name: { type: 'string', description: 'Full qualified name from search_graph.' },
        name: { type: 'string', description: 'Short name fallback if qualified_name not known.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'batch_get_code',
    description:
      'Read source code for multiple relevant symbols in one call. Prefer this over separate get_code_snippet calls when three or more returned symbols all need inspection; do not fetch additional symbols merely to fill a batch. ' +
      'Each snippet capped at 60 lines. Dramatically reduces round-trips.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        qualified_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of qualified names to fetch (max 30).',
        },
        limit: { type: 'integer', description: 'Max results (default 20, max 30).' },
      },
      required: ['project', 'qualified_names'],
    },
  },
];
