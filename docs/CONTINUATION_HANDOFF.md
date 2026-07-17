# LYNX Continuation Handoff

## Mission

Continue until the 33 LYNX MCP tools are functionally consistent, performant, installed, reindexed and verified against the installed Codex runtime. Fix causes rather than hiding symptoms. Code and documentation remain in English; the dashboard remains bilingual.

## Repository and branch

- Repository: `/Users/admin/Desktop/LYNX`
- Branch: `codex/harden-and-operationalize`
- Remote: `origin git@github.com:cesarmesaspain/LYNX.git`
- Last pushed commit at handoff creation: `6a87ec7`
- Earlier relevant commits: `c5275ef`, `20eac49`, `48d169d`, `21c7d6a`, `6a87ec7`
- Primary audit: `docs/TOOL_AUDIT_2026-07-16.md`
- Native-core method: `docs/NATIVE_CORE_METHOD.md` and `docs/NATIVE_CORE_BLUEPRINT.md`

## Mandatory working method

1. For code work, call the smallest relevant LYNX tool before shell/file tools, as required by `AGENTS.md`.
2. For broad work use `pack_context`, then exact `search_graph`/`get_code_snippet`/`trace_path` evidence.
3. Reproduce every suspected defect against the installed MCP or database before editing.
4. Cross-check overlapping tools instead of trusting a single response.
5. Add a regression test for each confirmed root cause.
6. Run focused tests, TypeScript validation, then all tests.
7. Commit and push before reinstalling.
8. Rebuild TypeScript and native core, link/install, run doctor, full-index, then a no-op incremental pass.
9. Restart Codex only after installation is complete, then repeat functional MCP batches against the newly loaded server.

## Completed and verified

- 33/33 tools are visible after restart; `tool_catalog` now lists all 33 with safety metadata.
- Dashboard UTC parsing and manifest file count are fixed.
- Project selection persists; dashboard card layout, tooltips, labels and metric alignment were improved earlier.
- Native C/C++ evidence-preserving core is integrated and documented.
- Session startup fast-mode degradation was identified.
- `smart_review` coverage now uses `TESTS`/`TESTS_FILE`; it agrees with `find_tests`.
- `smart_review` LLM enrichment is opt-in; isolated deterministic latency is ~2 ms tool time / ~49 ms MCP wall time.
- `trace_path` aggregates repeated call sites and preserves all evidence locations. Verified with three `cmdConfig → readLynxConfig` occurrences at lines 59, 92 and 117.
- Tool-facing hard-coded Spanish fragments were converted to English.
- `pack_context(mode=decision)` now distinguishes uncommitted working-tree changes from committed branch changes.
- `index_status` uses the actual last-run mode for its coverage denominator and bounds the ratio.
- All hotspot sections use the same `include_tests` policy.
- Invariant output supports a bounded limit and reports discovered/returned/truncated counts without truncating violations.
- Before the final two changes, full suite passed 124 files and 999/999 tests; doctor passed 11/11.

## Current uncommitted changes at the latest checkpoint

Inspect `git status` first. At handoff creation, the following work is intentionally uncommitted:

1. `src/install/hooks.ts`, `src/install/doctor.ts`, `tests/unit/install/codex-hooks.test.ts`, and audit docs:
   - The SessionStart command must be exactly:
     `lynx index "$PWD" --mode full --incremental`
   - Reason: the CLI defaults to fast. The previous implicit-mode fix was wrong and a restart again degraded 624-file full graph to a 370-file fast graph.
   - Doctor must recognize the explicit full command.
2. `src/mcp/handlers/check_invariants.ts`:
   - The per-pair SQL loop was replaced by one self-join aggregation.
   - Measured result: 96 invariants unchanged; latency reduced from about 6,100 ms to 81 ms.
3. `src/store/edges.ts`, `src/watcher/file-watcher.ts`, and watcher/store tests:
   - Re-resolved batches replace their outbound relationships.
   - Exact edge identities are deduplicated by the persistence API while distinct call-site properties remain preserved.
4. `docs/CONTINUATION_HANDOFF.md` itself.

## Immediate next actions

### 1. Validate invariant optimization semantically and for speed

Run:

```bash
npm run typecheck
npx vitest run tests/unit/mcp/check_invariants.test.ts tests/unit/install/codex-hooks.test.ts tests/unit/cli/doctor-cmd.test.ts
```

Add a regression/performance-shape test if practical. At minimum, existing invariant tests must prove lock/unlock semantics are unchanged. Then build the current code and benchmark through a direct handler test or, after restart, MCP:

```text
check_invariants(project="LYNX", files=["src/config/runtime.ts"], limit=5)
```

Acceptance achieved in source runtime: same 96 invariants, zero scoped violations, 81 ms. Reconfirm through MCP after reinstall/restart.

### 2. Run the complete suite

```bash
npm test
```

Expected baseline is at least 999 passing tests. Any new regression tests increase that number.

### 3. Update the audit and commit/push

Update `docs/TOOL_AUDIT_2026-07-16.md` with:

- explicit `--mode full --incremental` correction;
- invariant query before/after latency;
- latest full-suite count.

Then:

```bash
git diff --check
git status --short
git add <only the intended files>
git commit -m "fix: preserve full startup indexes and optimize invariants"
git push origin codex/harden-and-operationalize
```

Do not include unrelated user changes.

### 4. Rebuild and reinstall

```bash
npm run build
npm run build:native-core
npm link
lynx install
lynx doctor
```

Acceptance:

- MCP runtime: 33/33 tools.
- Doctor: 11/11.
- Installed Claude and Codex SessionStart hooks contain `--mode full --incremental`.

### 5. Restore the full graph

The current installed graph was degraded by the last restart to approximately 5,548 nodes / 28,245 edges / 370 discovered fast files. Restore it:

```text
index_repository(
  repo_path="/Users/admin/Desktop/LYNX",
  name="LYNX",
  mode="full",
  incremental=false
)
```

Immediately follow with:

```text
index_repository(
  repo_path="/Users/admin/Desktop/LYNX",
  name="LYNX",
  mode="full",
  incremental=true
)
```

Expected full scale is roughly 624 files, 6,100+ nodes and 29,000+ edges. The second call must process zero files, skip all manifest files, add/remove zero nodes and edges, and finish in roughly 0.1–0.2 seconds.

### 6. Restart Codex once and prove the startup hook no longer degrades

After reinstalling, ask the user to restart Codex. On the new session, call `index_status` first.

Acceptance:

- `last_run.mode` remains `full`.
- The startup incremental run skips all ~624 files.
- Node and edge totals remain identical to the pre-restart full index.
- Coverage mode is `full` and ratio is at most 1.
- Graph drift is clean.

This is the most important remaining lifecycle proof.

## Final tool batches after the next restart

Run small parallel groups, but benchmark expensive tools in isolation so synchronous work in one promise does not inflate another tool's reported latency.

### Discovery and source

- `pack_context` compact and decision modes.
- `search_graph` exact and natural-language query.
- `search_code` literal/regex.
- `semantic_search` intent query.
- `get_code_snippet` with neighbors.
- `batch_get_code` with two known qualified names.
- `explain_symbol` and `investigate_symbol` on `config.runtime.readLynxConfig`.

Acceptance: correct symbol, clean index context, bounded output, no implicit LLM unless requested.

### Relationships, evidence and tests

- `trace_path` with evidence.
- `get_edge_evidence` for a known edge.
- `find_tests` for `config.runtime.readLynxConfig`.
- `query_graph` for the same relationship.
- `get_graph_schema`.

Acceptance: trace aggregates occurrences, keeps every evidence line, and test coverage agrees across tools.

### Architecture and quality

- `get_architecture` with selected aspects.
- `analyze_hotspots(include_god_components=true)`.
- `find_dead_code` with a small limit.
- `smart_review(enable_llm=false)` in isolation.
- `check_invariants(limit=5)` in isolation.
- `check_rules` (expected no rules file unless one is intentionally added).

Acceptance: English output, no tests in production-only hotspot lists, bounded invariant response, deterministic review remains fast.

### Change, memory and runtime

- `detect_changes(include_committed=false)` and `pack_context(mode=decision)` must both report clean working tree after commit.
- `assess_impact` with a file not in Git diff must state that uncertainty rather than invent impact.
- `compare_runs` must warn when modes differ and be comparable after two full runs.
- `pack_memory`, `usage_summary`, `diagnose`, `list_projects`, `index_status`, `watch_project(status)`, `manage_adr(sections)`.

### State-changing tools

Do not delete LYNX or inject fake production traces just to claim runtime coverage. Validate `delete_project`, `ingest_traces`, and ADR update behavior through their existing unit/integration tests or a disposable temporary project. Confirm destructive metadata in `tool_catalog`.

## Dashboard final checks

Verify:

```bash
curl -fsS http://localhost:9191/api/health
curl -fsS http://localhost:9191/api/projects
```

Acceptance:

- Health is OK.
- LYNX is ready.
- `filesIndexed` equals the full manifest count (~624), not graph File nodes.
- `hoursSinceIndex` is 0 immediately after indexing in Europe/Madrid UTC+2.
- Node/edge totals match `index_status`.

If dashboard code was rebuilt while the old service remained alive, restart the standalone dashboard service so it loads current `dist`.

## Final completion audit

Before declaring completion, prove all of the following from current state:

- Git working tree clean.
- All intended commits pushed.
- TypeScript validation passes.
- Complete tests pass.
- Native core builds.
- Installer and doctor pass 11/11.
- MCP catalog reports 33 tools.
- Full index survives a Codex restart without becoming fast.
- Full index followed by incremental no-op is count-stable.
- Cross-tool claims agree for changes, tests and evidence.
- Dashboard matches the graph and manifest.
- Audit and handoff documents reflect final measured evidence.

Only then mark the persistent goal complete.
