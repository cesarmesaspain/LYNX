# LYNX — Code Analysis & Exploration with Semantic Architecture Reasoning

MCP server that builds a knowledge graph of codebases for AI assistants.
33 MCP tools backed by one canonical registry, with 159 active language configs.

LYNX gives AI coding agents a local code intelligence layer: index once, query the graph
instead of grep/read loops. Persistent SQLite knowledge graph with 20+ edge types covering
definitions, calls, imports, data flow, HTTP routes, channels, dependencies, and more.

## Architecture

```
Query → MCP Server (stdio JSON-RPC, 33 registry-verified handlers)
          ↓
     SQLite Graph Store
     (~/.lynx/dbs/{project}.db)
          ↑
Index → Pipeline 4 phases (discover → extract → resolve → analyze)
```

## Quick start

```bash
cd LYNX && npm install && npm run build
```

### MCP client config

```json
{
  "mcpServers": {
    "lynx": {
      "command": "node",
      "args": ["/path/to/LYNX/dist/index.js"]
    }
  }
}
```

### CLI

```bash
lynx install      # detect agents, write MCP config and hooks
lynx init          # project stats → CLAUDE.md
lynx doctor        # diagnostic: binary, DB, MCP, hooks, license
lynx index /path/to/project --mode fast --name my-project
lynx status my-project
lynx serve
lynx agent-ab --project-dir /path --tasks external_project_overview --seed 42
lynx agent-ab --project-dir /path --tasks t1,t2 --chained --seed 42  # multi-turn
lynx agent-ab --history  # historical hygiene, aggregate savings and Wilson intervals
lynx agent-ab --history --history-index /path/to/_index.jsonl  # analyze an alternate or missing history index
```

## Tools (33)

| Tool | Description |
|------|-------------|
| `pack_context` | Task-aware context builder — use early when scope or safety constraints are unclear |
| `search_graph` | BM25 + graph search with pagination and LLM rerank |
| `semantic_search` | Natural-language fuzzy token matching with graph-aware scoring |
| `trace_path` | BFS callers/callees with risk labels and pagination |
| `get_code_snippet` | Symbol source + callers + callees |
| `batch_get_code` | Read multiple symbols in one call |
| `tool_catalog` | Canonical tool inventory, profiles, and safety metadata |
| `get_architecture` | Languages, hotspots, clusters, file tree |
| `query_graph` | Cypher-to-SQL queries with MATCH support |
| `explain_symbol` | Deep-dive: source, callers, callees, complexity, risk, findings |
| `smart_review` | Automated code review with graph intelligence |
| `find_tests` | Find test functions covering a symbol |
| `find_dead_code` | Graph-verified dead-code candidates |
| `index_repository` | Full pipeline with SHA256 incremental mode |
| `index_status` | Node/edge counts + git info |
| `diagnose` | Runtime, freshness, lock, and configuration health |
| `detect_changes` | Git diff → scoped impact analysis and structured diagnostics |
| `assess_impact` | Cross-reference changes, graph dependencies, tests, and rules |
| `check_invariants` | Discover sibling-call invariants and flag violations |
| `check_rules` | Enforce architecture rules from `lynx-rules.json` |
| `compare_runs` | Delta between last two index runs |
| `pack_memory` | Persistent findings CRUD |
| `analyze_hotspots` | Risk ranking with narrative explanations |
| `search_code` | grep + graph enrichment |
| `get_edge_evidence` | Explain the captured evidence behind a graph edge |
| `investigate_symbol` | One-call symbol search, explanation, trace, source, and tests |
| `usage_summary` | Local usage and clearly labelled savings estimates |
| `manage_adr` | Architecture Decision Records |
| `ingest_traces` | Runtime trace ingestion for graph enhancement |
| `delete_project` | Delete index |
| `list_projects` | List indexed projects |
| `get_graph_schema` | Schema introspection |
| `watch_project` | Start/stop/status real-time file watcher |

## Project structure

```
src/
├── index.ts, cli.ts, types.ts
├── extraction/          # native TS/TSX path + tree-sitter fallback
│   ├── extractor.ts, tree-sitter-extractor.ts
│   └── language-registry.ts (159 languages)
├── pipeline/            # 4-phase indexing
│   ├── orchestrator.ts
│   └── phases/          # discover, extract (parallel), resolve (cross-file), analyze
├── store/               # SQLite graph store
│   ├── database.ts, nodes.ts, edges.ts
│   ├── search.ts, traverse.ts, memory.ts, schema.ts
├── mcp/                 # MCP server
│   ├── server.ts, tools.ts
│   └── handlers/        # canonical handlers for all 33 public tools
├── server/              # Dashboard + API server
├── llm/                 # Hybrid LLM (heuristic + optional DeepSeek)
├── install/             # Onboarding (install, init, doctor, uninstall)
├── usage/               # Local value measurement
├── intelligence/        # hotspots, complexity, clustering, narrative
└── git/context.ts
```

## Edge types (resolved in Phase 3)

- **CONTAINS_FOLDER** — parent dir → child dir
- **CONTAINS_FILE** — dir → file
- **DEFINES** — file → each symbol
- **DEFINES_METHOD** — class → method
- **INHERITS** — class → base class/interface
- **IMPORTS** — file → imported symbol (cross-file)
- **CALLS** — caller → callee (cross-file, 4 resolution strategies)
- **USAGE** — function → referenced variable (cross-file)
- **READS** — function → read variable
- **WRITES** — function → written variable
- **RAISES/THROWS** — function → exception
- **CONFIGURES** — function → config key
- **LISTENS_ON/EMITS** — function → channel
- **DEPENDS_ON** — project → external dependency
- **TESTS** — test → production function
- **HAS_BRANCH** — function → git branch
- **HTTP_CALLS** — function → HTTP endpoint
- **DECORATES** — decorator → decorated symbol

## Design decisions

1. **Native C hot path for TS/TSX** — optional, with JS/WASM fallback for portability
2. **Tree-sitter instead of TS compiler API** — compiler API was too slow
3. **Worker pool extraction** — real worker_threads pool for parallel extraction
4. **Resolver passes with in-memory indexes** — high edge density without re-walking ASTs
5. **Global QN/name indexes** — cross-file CALLS/IMPORTS/USAGE resolution
6. **Narrative explanations** — every handler returns human-readable summaries
7. **Persistent memory** — findings survive across sessions and index runs
8. **SHA256 incremental** — skip unchanged files on re-index
9. **No artificial edge inflation** — all relationships target real graph nodes
10. **Onboarding parity** — install/init/doctor/uninstall for 11 agent platforms
11. **Local value measurement** — usage.jsonl with token savings tracking (no cloud)

## Validation

```bash
npm run typecheck   # 0 errors
npm run build       # 0 errors
npm test            # all tests pass
node dist/cli.js doctor  # 11/11 checks
```

### Agent A/B benchmark results

Agent A/B benchmark runs are automatically persisted under `benchmarks/results/` as a full JSON result, a side-by-side responses artifact, and an index entry. External project labels use the project directory name; when the configured path ends in /source, the parent directory name is used so DEEPCODEX/source is stored as DEEPCODEX. Passing --out still creates the requested additional copy. Dry runs are not auto-saved.

`--chained` mode pairs tasks into a single shared conversation, simulating a real multi-turn session where LYNX's tool definition cost is paid once and amortized across questions. This closes the gap between benchmark methodology and real-world usage.

`--history` reads the benchmark index without running paid evaluations. Its JSON report includes index hygiene, whether the selected index exists, independent cost, wall-time, and quality coverage, weighted and macro savings rates, Wilson win-rate intervals, and a per-project breakdown. The `quality_runs` field counts history records with actual functional evaluation, while `evaluated_runs` counts the evaluated executions contained in those records. The `cost_coverage_rate`, `wall_time_coverage_rate`, and `quality_coverage_rate` fields report the fraction of included history records supporting each metric; zero quality coverage means quality was not measured and must not be interpreted as a 0% success result. Negative `wall_time_savings_rate` values indicate that LYNX was slower than the baseline. Use `--history-index <path>` to inspect another index; a missing file produces a stable empty report, while other read errors remain visible.
