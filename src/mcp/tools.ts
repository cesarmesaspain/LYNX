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
  'semantic_search', 'find_tests', 'batch_get_code', 'check_invariants',
  'diagnose', 'usage_summary', 'get_edge_evidence',
  'investigate_symbol', 'check_rules',
]);

/** Tools which only inspect an already indexed project or its working tree. */
export const READ_ONLY_TOOL_NAMES = new Set([
  'tool_catalog', 'pack_context', 'search_graph', 'trace_path',
  'get_code_snippet', 'get_architecture', 'query_graph', 'index_status',
  'list_projects', 'get_graph_schema', 'search_code', 'get_edge_evidence', 'detect_changes',
  'assess_impact', 'pack_memory', 'analyze_hotspots', 'find_dead_code',
  'compare_runs', 'explain_symbol', 'smart_review', 'semantic_search',
  'find_tests', 'batch_get_code', 'diagnose', 'usage_summary',
  'check_invariants', 'investigate_symbol', 'check_rules',
]);

const DESTRUCTIVE_TOOL_NAMES = new Set(['delete_project']);

export function withSafetyAnnotations(tool: LynxToolDef): LynxToolDef {
  const readOnlyHint = READ_ONLY_TOOL_NAMES.has(tool.name);
  const destructiveHint = DESTRUCTIVE_TOOL_NAMES.has(tool.name);
  return {
    ...tool,
    annotations: {
      ...(readOnlyHint ? { readOnlyHint: true } : { destructiveHint }),
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
    description: 'Show core workflow and advanced tools available on demand.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pack_context',
    description:
      'Build a task-oriented context pack with likely areas, safety constraints, recommended graph/search calls, and validation steps. ' +
      'Use early when scope or risks are still unclear.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task or intended change.' },
        project: { type: 'string', description: 'Optional indexed project.' },
        mode: {
          type: 'string',
          enum: ['compact', 'full', 'decision'],
          description: 'compact=minimal; full=detail; decision=change risk.',
        },
        enable_llm: { type: 'boolean', description: 'LLM rerank; default false.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'search_graph',
    description:
      'Search definitions and relationships: query=BM25; name/qn_pattern=regex; name/qn_like=SQL LIKE; semantic_query=vector. Use include_snippets for previews.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'BM25 query.' },
        project: { type: 'string' },
        label: { type: 'string', description: 'Kind filter.' },
        name_pattern: { type: 'string', description: 'Regex on name.' },
        qn_pattern: { type: 'string', description: 'Qualified-name regex.' },
        name_like: { type: 'string', description: 'Name SQL LIKE.' },
        qn_like: { type: 'string', description: 'Qualified-name SQL LIKE.' },
        file_pattern: { type: 'string', description: 'Path glob.' },
        min_degree: { type: 'integer', description: 'Min degree.' },
        max_degree: { type: 'integer', description: 'Max degree.' },
        exclude_entry_points: { type: 'boolean', description: 'Exclude entries.' },
        include_connected: { type: 'boolean', description: 'Include neighbors.' },
        limit: { type: 'integer', description: 'Max results.' },
        offset: { type: 'integer', description: 'Offset.' },
        semantic_query: {
          type: 'array',
          items: { type: 'string' },
          description: 'Semantic keywords.',
        },
        enable_llm: { type: 'boolean', description: 'LLM rerank; default false.' },
        include_snippets: { type: 'boolean', description: 'Source previews; opt-in.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'trace_path',
    description:
      'Trace callers, callees, and references. Modes: calls=control flow; references=bindings; data_flow=both; auto=fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        function_name: { type: 'string', description: 'Symbol or qualified name.' },
        project: { type: 'string' },
        direction: { type: 'string', enum: ['inbound', 'outbound', 'both'], description: 'outbound=callees; inbound=callers; both=both' },
        depth: { type: 'integer', description: 'BFS depth; default 3, use 4 for flows.' },
        mode: { type: 'string', enum: ['calls', 'references', 'data_flow', 'cross_service', 'auto'], description: 'calls=flow; references=bindings; data_flow=both; auto=fallback.' },
        risk_labels: { type: 'boolean', description: 'Risk labels by hop.' },
        include_tests: { type: 'boolean', description: 'Include tests.' },
        edge_types: { type: 'array', items: { type: 'string' }, description: 'Edge types.' },
        include_edges: { type: 'boolean', description: 'Include labelled edges.' },
        include_evidence: { type: 'boolean', description: 'Add file, line, extractor, and confidence evidence.' },
      },
      required: ['function_name', 'project'],
    },
  },
  {
    name: 'get_code_snippet',
    description:
      'Read one symbol. include_neighbors adds callers/callees with file paths, signatures, and test coverage, replacing separate trace_path and find_tests calls. ' +
      'For 3+ symbols, use batch_get_code.',
    inputSchema: {
      type: 'object',
      properties: {
        qualified_name: { type: 'string', description: 'Qualified name.' },
        project: { type: 'string' },
        include_neighbors: { type: 'boolean', description: 'Include neighbors.' },
        max_lines: { type: 'integer', description: 'Expand source lines.' },
      },
      required: ['qualified_name', 'project'],
    },
  },
  {
    name: 'get_architecture',
    description:
      'Get architecture: languages, hotspots, clusters, file tree, and node/edge counts. ' +
      'Start compact, request only missing aspects, reuse results, and verify only needed symbols with get_code_snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        path: { type: 'string', description: 'Directory prefix.' },
        aspects: {
          type: 'array',
          items: { type: 'string', enum: ['languages', 'hotspots', 'clusters', 'file_tree', 'entry_points', 'brief', 'narrative', 'node_labels', 'edge_types'] },
          description: 'Sections; token control.',
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
        max_rows: { type: 'integer', description: 'Max rows; compact default.' },
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
        repo_path: { type: 'string', description: 'Repository path.' },
        mode: {
          type: 'string',
          enum: ['full', 'moderate', 'fast'],
          description: 'Mode; moderate default.',
        },
        name: { type: 'string', description: 'Override project name.' },
        incremental: {
          type: 'boolean',
          description: 'Skip unchanged SHA256 files; default true.',
        },
        force_lock: {
          type: 'boolean',
          description: 'Override stale lock after crash.',
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
    description: 'Explain why a graph edge exists with evidence.',
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
      anyOf: [
        { required: ['edge_id'] },
        { required: ['source_name', 'target_name'] },
      ],
    },
  },
  {
    name: 'investigate_symbol',
    description:
      'Investigate one symbol via search, explain, trace, snippet, and tests; returns one context pack.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        symbol: { type: 'string', description: 'Symbol or qualified name.' },
        name: { type: 'string', description: 'Alias.' },
        qualified_name: { type: 'string', description: 'Alias.' },
        depth: { type: 'integer', description: 'Trace depth; default 2.' },
        include_evidence: { type: 'boolean', description: 'Trace evidence.' },
        verbose: { type: 'boolean', description: 'Include metrics, LLM usage, and index context; default false.' },
      },
      required: ['project'],
      anyOf: [
        { required: ['symbol'] },
        { required: ['name'] },
        { required: ['qualified_name'] },
      ],
    },
  },
  {
    name: 'diagnose',
    description: 'Run local health checks: runtime, index, locks, and safe config.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'usage_summary',
    description: 'Summarize usage and savings estimates; separate billing/confidence.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Optional indexed project name.' },
        limit: { type: 'integer', description: 'Recent event limit; max 10000.' },
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
      'Grep text, enriched by the graph. Modes: compact=signatures, full=source, files=paths. ' +
      'Combine equivalent spellings or conventions in one regex; after a conclusive miss, stop unless new evidence changes scope.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex.' },
        project: { type: 'string' },
        file_pattern: { type: 'string', description: 'File glob.' },
        path_filter: { type: 'string', description: 'Path regex.' },
        mode: { type: 'string', enum: ['compact', 'full', 'files'], description: 'Mode.' },
        regex: { type: 'boolean', description: 'Regex mode.' },
        limit: { type: 'integer', description: 'Max results; default 10.' },
        context: { type: 'integer', description: 'Context lines.' },
      },
      required: ['pattern', 'project'],
    },
  },
  {
    name: 'detect_changes',
    description:
      'Detect staged, unstaged, untracked, deleted, and renamed files plus impact tiers: confirmed=CALLS/IMPORTS, probable=same module, nominal=name only. ' +
      'Use files to scope analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        base_branch: { type: 'string', description: 'Diff base; default main.' },
        since: { type: 'string', description: 'Git ref/tag.' },
        include_committed: { type: 'boolean', description: 'Include committed changes.' },
        scope: { type: 'string', enum: ['files', 'symbols'], description: 'files=paths; symbols=paths plus impacted functions.' },
        depth: { type: 'integer', description: 'Impact depth; default 2.' },
        files: { type: 'array', items: { type: 'string' }, description: 'File scope.' },
        include_diff: { type: 'boolean', description: 'Include diff; opt-in.' },
        enable_llm: { type: 'boolean', description: 'LLM risk; default false.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'assess_impact',
    description:
      'Cross-reference changes with graph/tests: coverage, untested changes, missing callers, deleted live symbols, and unindexed files. Returns confidence-backed findings.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files scope.' },
        base_branch: { type: 'string', description: 'Diff base.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'check_invariants',
    description: 'Discover CALLS invariants and flag modified functions breaking learned patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional files; omit to return invariants only.' },
        min_confidence: { type: 'number', description: 'Minimum confidence threshold (0.0–1.0, default 0.8).' },
        limit: { type: 'integer', description: 'Maximum discovered invariants returned (default 30, max 100). Violations are not truncated.' },
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
        mode: { type: 'string', enum: ['get', 'update', 'sections'], description: 'get=read; update=write; sections=list headers.' },
        content: { type: 'string', description: 'Markdown content for update mode.' },
        sections: { type: 'array', items: { type: 'string' }, description: 'Section names.' },
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
        traces: { type: 'array', items: { type: 'object' }, description: 'Trace objects.' },
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
        target_qn: { type: 'string', description: 'Qualified symbol.' },
        target_file: { type: 'string', description: 'Finding file.' },
        category: { type: 'string', description: 'Category filter.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'analyze_hotspots',
    description:
      'Snapshot largest files, complexity, coupling, hotspots, averages, and large components. ' +
      'Use for quality, scalability, or risk, not as a first overview; for small projects prefer get_architecture plus targeted snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        limit: { type: 'integer', description: 'Max results (default 10).' },
        include_god_components: { type: 'boolean', description: 'Components >=300; default true.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'find_dead_code',
    description:
      'Find function, method, or class candidates with zero incoming CALLS, USAGE, READS, or TESTS edges, excluding tests and entry points. ' +
      'Prefer this to query_graph plus per-symbol loops; results remain candidates and exported symbols carry a public-API caveat.',
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
      'callers, callees, complexity metrics, risk assessment, related findings, and a concise narrative.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        qualified_name: { type: 'string', description: 'Qualified name.' },
        name: { type: 'string', description: 'Short name fallback.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'smart_review',
    description:
      'Review a file or symbol using graph signals for complexity, size, coupling, test coverage, and performance risk. ' +
      'Findings are heuristic; verify before claiming runtime impact or Big-O complexity.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        file: { type: 'string', description: 'Review file.' },
        qualified_name: { type: 'string', description: 'Review symbol.' },
        limit: { type: 'integer', description: 'Max issues (default 20).' },
        enable_llm: { type: 'boolean', description: 'Opt in to LLM smell classification. Default false; deterministic graph review remains local.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'semantic_search',
    description:
      'Search code from natural-language intent using fuzzy names plus graph-aware scoring. ' +
      'Prefer over search_graph when exact symbol names are unknown.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        query: { type: 'string', description: 'Natural-language query.' },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keyword tokens.',
        },
        kind: { type: 'string', description: 'Filter by symbol kind.' },
        file_pattern: { type: 'string', description: 'File glob.' },
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
          description: 'start/stop/status.',
        },
        mode: { type: 'string', enum: ['full', 'moderate', 'fast'], description: 'Watcher index mode; default fast.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'find_tests',
    description:
      'Find tests covering a symbol by reversing TESTS edges (test → production). ' +
      'Returns all matching test functions, avoiding manual grep/read loops.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        qualified_name: { type: 'string', description: 'Qualified name.' },
        name: { type: 'string', description: 'Short name fallback.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'batch_get_code',
    description:
      'Read multiple symbols at once when 3+ search results all need inspection; do not add symbols just to fill a batch. ' +
      'Each snippet is capped at 60 lines, reducing round-trips.',
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
  {
    name: 'check_rules',
    description:
      'Check architecture rules defined in lynx-rules.json against the indexed dependency graph. ' +
      'Detects forbidden cross-layer imports and returns violations with source/target file and symbol details. ' +
      'Use to enforce layer boundaries (e.g. domain must not import infrastructure).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional files; omit to check all indexed files.' },
      },
      required: ['project'],
    },
  },
];
