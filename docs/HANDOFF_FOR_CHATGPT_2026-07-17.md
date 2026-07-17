# LYNX Handoff — 2026-07-17

## Current state

LYNX is installed, indexed, healthy, and ready for live MCP use. The working branch is `codex/harden-and-operationalize`.

- `lynx doctor`: 11/11 checks passed.
- MCP runtime: 33/33 tools exposed.
- Dashboard: supervised service healthy at `http://127.0.0.1:9191`.
- Main suite: 128 files, 1054/1054 tests passed.
- API suite: 5 files, 22/22 tests passed.
- Root and API typechecks passed.
- Full index: 415 files processed, 415 files with graph nodes, 5,934 nodes, 29,645 edges, 2.11 s.
- No-op incremental: 0 processed, 415 skipped, no graph mutations, 0.13 s.
- GitHub is synchronized through the handoff commit on `codex/harden-and-operationalize`; the coverage and dashboard commits listed below are published.

## Work completed

### Canonical project and health semantics

- A unique checkout basename resolves case-insensitively to the canonical indexed project.
- Ambiguous same-basename roots fail instead of guessing.
- `doctor` and index status use graph drift rather than treating a recent timestamp as proof of freshness.

### Coverage accounting root fix

Commit: `c192073 fix: count indexed source files from canonical registry`

`files_with_nodes` previously counted every distinct non-empty `nodes.file_path`. Folder nodes also store their path there, so 71 folders inflated 415 files to 486. The metric now joins graph node paths to the canonical `file_hashes.rel_path` registry. Full and no-op paths share the same helper and regression tests.

Verified live result: `files_discovered=415`, `files_with_nodes=415`.

### Dashboard supervision root fix

Commit: `6ee530d fix: supervise dashboard across MCP restarts`

`auto_dashboard=true` used to be persisted but was only consumed during installation. A dead detached child left a stale PID and later MCP starts never repaired it.

The service now:

- is ensured from normal `lynx serve` startup as well as installation;
- uses an atomic startup lock to serialize concurrent MCP processes;
- validates that the PID belongs to `dashboard --service` on Unix and Windows;
- requires two successful `/api/health` checks before persisting the PID;
- rejects PID reuse and unrelated live processes;
- clears failed or early-exit startup state;
- replaces dead services without coupling dashboard lifetime to MCP stdin.

Live recovery proof:

1. Service PID 27174 was healthy.
2. PID 27174 was terminated.
3. A fresh `lynx serve </dev/null` started PID 27284.
4. `/api/health` returned HTTP 200 from PID 27284.

### Ten-out-of-ten objective

`docs/TEN_OUT_OF_TEN_STANDARD.md` is the authoritative product-quality contract. It defines ten scored domains, hard gates, reproducible evidence requirements, and the 9.0 → 9.5 → 10.0 path. Scores must not be rounded up because features exist; every claim requires repeatable proof.

## Remaining gaps

These are not release blockers for the current local installation, but they prevent a 10/10 claim:

1. Full-index call resolution is currently 5,516/26,278 (20.99%). The metric includes unresolved lexical candidates, so first separate extractor noise from genuinely unresolved calls, then improve resolution without denominator shaping.
2. Native C/C++ extraction still reports partial handling for member/qualified calls, function pointers, preprocessing, and lexical shadowing.
3. `tree-sitter-extractor.ts` and `discover.ts` are classified as generated and receive partial semantic extraction; verify whether that classification is intentional.
4. Team security and cross-platform installation gates still need reproducible clean-machine evidence.
5. Tool contracts, failure envelopes, performance budgets, and privacy/telemetry gates must be exercised as a single release matrix.
6. ChatGPT/FreeGPT is producing an independent evidence-backed ranking of the five highest-value remaining 10/10 gaps. Incorporate it only after checking its evidence against the graph and tests.

## Working methodology to preserve

1. Start broad work with `pack_context`; resolve the canonical project before deeper calls.
2. Use graph search, snippets, traces, tests, and impact in that order. Read raw files only when graph evidence is insufficient or the target is configuration/non-indexed content.
3. Reproduce the failure before editing and identify the authoritative state source.
4. Correct identity, lifecycle, or persistence at its owner; never cap, hide, or reshape an incorrect output.
5. Add a regression that fails for the original cause, including concurrency and recovery cases where relevant.
6. Run focused tests and typecheck, then the complete affected workspace suites.
7. Validate the installed runtime, not only source code: build, link/install, `doctor`, real MCP exposure, live dashboard, full index, and no-op incremental.
8. Use ChatGPT through FreeGPT for slow independent investigation and review. Codex owns the critical path, integration, final validation, commits, and publication.
9. Keep benchmark source projects read-only and preserve full sanitized evidence.
10. Record unresolved facts explicitly; never convert estimates or partial coverage into measured claims.

## Immediate continuation

1. Review the independent ChatGPT 10/10 audit.
2. Restart Codex so the new installed MCP process is loaded.
3. In the new session, resolve `lynx-project`, run representative tool batches, and confirm live runtime behavior.
4. Begin the highest-ranked remaining 10/10 gap with a benchmark and acceptance test fixed before implementation.
