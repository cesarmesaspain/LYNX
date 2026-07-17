# LYNX MCP Tool Audit — 2026-07-16

## Objective

Exercise the complete 33-tool MCP surface against the LYNX repository, identify contradictions and operational regressions, fix their causes, and validate the installed runtime rather than only the source tree.

## Method

1. Start from a clean, full repository index and record its manifest, node and edge counts.
2. Use `pack_context` for the broad audit, then obtain the installed catalog with `tool_catalog`.
3. Exercise representative tools in parallel by capability group: discovery, source retrieval, traversal, evidence, architecture, change analysis, quality, memory, metrics and runtime operations.
4. Cross-check tools that make the same claim. Examples: `find_tests` versus `smart_review`, `index_status` versus `compare_runs`, and trace occurrence evidence versus stored edge rows.
5. Treat an inconsistency as a product defect only after reproducing it from the graph or runtime state.
6. Fix the data contract or lifecycle that produced the defect. Do not hide inconsistent results in the dashboard or response formatting.
7. Add focused regression tests, run TypeScript validation and the complete test suite, rebuild the native core, reinstall all agent integrations, perform a full index, and repeat the MCP smoke tests against the installed runtime.

## Confirmed root causes and corrections

### Session startup degraded full indexes

The installed SessionStart hook forced `--mode fast --incremental`. A full index had 623 manifest files, while fast discovery selected 370. On the next Codex startup, the mode mismatch made the richer inputs appear deleted and replaced the graph (6,101 nodes / 29,064 edges) with a smaller fast graph (5,545 / 28,219).

The hook now invokes `--mode full --incremental` explicitly because the CLI default is fast. An unchanged full index is a low-cost no-op and retains its discovery depth. The installer also recognizes and replaces legacy hook forms.

### Review coverage contradicted `find_tests`

`smart_review` inferred coverage from test functions located in the production source directory. LYNX correctly linked `tests/unit/config/runtime.test.ts` to `readLynxConfig`, but the review still reported no tests because the test lived under `tests/`.

Review coverage now queries `TESTS` and `TESTS_FILE` graph relationships for the symbol and its source file. Directory proximity is no longer used as a coverage proxy.

### Trace output lost repeated call-site evidence

Three stored `CALLS` edges from `cmdConfig` to `readLynxConfig` were three real call sites, not duplicate graph rows. The trace response repeated the same symbol pair three times and attached only the first edge's evidence to every row.

Trace responses now aggregate the relationship, expose `occurrence_count`, fetch every underlying edge ID in one batch, and retain all evidence locations. This preserves information while removing misleading visual duplication.

### English runtime returned Spanish fragments

Several advanced responses contained hard-coded Spanish even when `locale=en`: architecture omission notes, hotspot component explanations and summaries, complexity trends, and one tool description.

Those tool-facing contracts are now English and consistent with the project's requested default. Dashboard localization remains independently bilingual.

### Tool catalog omitted part of the active surface

The full-profile catalog described only core tools and selected advanced groups, so it could not serve as an authoritative inventory. It now returns `tool_count` and all available tool names with read-only and destructive safety metadata. Full mode reports 33 tools; core mode reports its intentional 10-tool subset.

### Decision context mixed branch and working-tree changes

The shared Git collector intentionally combines committed branch changes with local changes for impact analysis. `pack_context(mode="decision")` reused it while describing the result as uncommitted work. The collector now has an explicit committed-change policy: impact analysis retains branch comparison, while decision context requests only working-tree changes.

### Coverage and quality scopes were inconsistent

`index_status` always used fast discovery as its coverage denominator, even after a full index, which allowed impossible ratios above 1. It now uses the last run's actual mode and bounds the ratio. Hotspot analysis also applied its test exclusion only to the primary ranking; project averages, largest files, complexity, coupling and god components could still be dominated by tests. Every section now follows the same `include_tests` policy.

### Deterministic tools performed implicit LLM work

`smart_review` could spend several seconds attempting smell classification even when the caller had not requested an LLM. The deterministic graph review is now local by default; `enable_llm=true` explicitly opts into classification.

### Invariant responses were unnecessarily large

Scoped invariant checks returned every discovered global invariant, even when the actionable result was the scoped violation list. The response now exposes discovered, returned and truncated counts, defaults to 30 returned invariants, supports a bounded `limit`, and never truncates violations.

The discovery implementation also issued one SQLite query for every callee pair. It now computes all co-occurrences in one relational self-join. On the installed LYNX graph, the same 96-invariant result dropped from about 6,100 ms to 81 ms.

### Watcher updates accumulated exact relationships

Partial watcher resolution recalculated unchanged dependent files and global passes without first replacing all relationships they produced. Repeated edits therefore inflated edge counts. The watcher now replaces outbound relationships for every re-resolved batch, including deleted-target recovery. The edge persistence API also deduplicates exact structural identities against both the existing graph and the current batch. Distinct call sites remain distinct because their line-bearing properties differ.

### Dashboard timestamp and file count

SQLite timestamps are UTC. The dashboard previously parsed them as local time, creating a two-hour freshness error in Spain (UTC+2). It also counted graph `File` nodes rather than the indexed file manifest.

Dashboard freshness now parses stored timestamps as UTC and manifest cards count `file_hashes`. A fresh full index reports 623 files and zero elapsed hours.

## Validation evidence

- Focused regression suite: 30/30 tests passed.
- Complete suite after the first audit fixes: 124 files, 997/997 tests passed.
- Complete suite after the final contract fixes: 124 files, 999/999 tests passed.
- Complete suite after watcher idempotency and invariant optimization: 124 files, 1,001/1,001 tests passed.
- TypeScript validation passed.
- MCP runtime before the final reinstall exposed 33/33 tools.
- Installer doctor before this audit passed 11/11 checks.

## Tool groups exercised

- Context and catalog: `pack_context`, `tool_catalog`.
- Discovery and retrieval: `search_graph`, `search_code`, `semantic_search`, `get_code_snippet`, `batch_get_code`, `explain_symbol`, `investigate_symbol`.
- Relationships and evidence: `trace_path`, `get_edge_evidence`, `find_tests`, `query_graph`, `get_graph_schema`.
- Architecture and quality: `get_architecture`, `analyze_hotspots`, `find_dead_code`, `smart_review`, `check_invariants`, `check_rules`.
- Change and history: `detect_changes`, `assess_impact`, `compare_runs`, `pack_memory`.
- Runtime and operations: `diagnose`, `index_status`, `index_repository`, `watch_project`, `list_projects`, `usage_summary`, `manage_adr` read operations.
- State-changing tools (`delete_project`, `ingest_traces`, ADR updates) are validated through contracts and automated tests; the production LYNX project is never used as a destructive test fixture.

## Interpretation rules

- Token and file savings are estimates of avoided exploration, not provider billing.
- Dead-code results are candidates; exported APIs and dynamic dispatch require review.
- Hotspot scores identify blast radius and maintenance risk, not proof of defects.
- Different index modes are not structurally comparable. `compare_runs` correctly reports this warning.
- A clean Git worktree and a clean graph-drift result do not imply that committed branch changes relative to `main` are empty; tools must label which comparison basis they use.

## Final operational checklist

- Build TypeScript and native core.
- Install the global CLI link and agent MCP configurations.
- Confirm 33/33 MCP tools and all doctor checks.
- Run a full non-incremental LYNX index.
- Run an isolated incremental no-op and ensure node/edge counts remain stable.
- Verify dashboard health, 623 manifest files and UTC freshness.
- Verify Git is clean and push the audit documentation.
