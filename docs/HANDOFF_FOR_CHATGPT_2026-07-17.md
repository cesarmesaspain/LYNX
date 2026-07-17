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

The same canonical counter is now shared by the indexing pipeline and `index_status`. This removes a second contradiction where status counted only explicit `File` nodes and reported 405/416 even though native and other extractors had produced graph nodes for all 416 registered files.

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

### No-op freshness acknowledgement

The incremental fast path used to return without refreshing filesystem metadata or the indexed commit. A content-identical mtime change or an empty/documentation commit could therefore leave `doctor` reporting drift after a successful no-op. The fast path now updates only canonical file metadata and the indexed commit in one transaction; graph nodes, edges, analysis, and run history remain untouched. A regression covers an mtime-only change plus an empty commit.

### CLI help safety

`lynx index --help` previously treated `--help` as an omitted path and indexed the current repository. It now returns dedicated subcommand usage before project resolution, locking, database access, or pipeline execution. Both `--help` and `-h` are side-effect free.

### Ten-out-of-ten objective

`docs/TEN_OUT_OF_TEN_STANDARD.md` is the authoritative product-quality contract. It defines ten scored domains, hard gates, reproducible evidence requirements, and the 9.0 → 9.5 → 10.0 path. Scores must not be rounded up because features exist; every claim requires repeatable proof.

### Cross-tool contract foundation

The generated cross-tool contract derives the public surface from the canonical `TOOLS` registry instead of hard-coding a tool count. Registry/handler parity is enforced at MCP startup, including duplicate, missing-handler, and unpublished-handler failures. Valid arguments are generated from every one of the 33 schemas and exercise required fields, `anyOf` branches, and wrong-type rejection. Shared project identity, graph counts, canonical file coverage, bounded deterministic change analysis, scoped impact agreement, and structured failure envelopes remain covered. Domain-specific semantic scenarios for every tool are still broader than this schema/dispatch matrix.

### Language golden truth sets and Go package resolution

TypeScript, C, Python, Go, Rust, and Java fixtures now run through the real indexing pipeline and report precision, recall, F1, and raw false-positive/false-negative sets without reshaping denominators. All six current fixtures require 1.0. The Go wave exposed and closed package-directory resolution; Rust added canonical `crate`/`self` use-path normalization; Java now preserves qualified method names and exposes methods from an imported class file to call resolution.

### Deterministic performance budget foundation

CI now runs a deterministic synthetic 40-module TypeScript workload, enforces p95 budgets for graph search and no-op incremental indexing, and always uploads the sanitized report with raw samples. The methodology is documented in `docs/PERFORMANCE_BUDGETS.md`. Full-index time, peak RSS, database growth, and large-repository budgets remain open.

## Remaining gaps

These are not release blockers for the current local installation, but they prevent a 10/10 claim:

1. Full-index call resolution is 5,649/26,815 (21.07%) after causal classification. Raw totals remain unchanged. Unresolved calls now separate 13,974 absent targets, 4,545 external dependency targets, 1,598 ambiguous internal targets, 774 native targets, 188 dynamic local bindings, 59 unknown receivers, 19 self-references, 6 missing callers, and 3 missing relative-import targets. Caller attribution and relative-import coverage are healthy; the next root work is built-in/framework classification for absent targets plus ambiguity and native resolution, without denominator shaping.
2. Native C/C++ extraction still reports partial handling for member/qualified calls, function pointers, preprocessing, and lexical shadowing.
3. ~~`tree-sitter-extractor.ts` and `discover.ts` are classified as generated.~~ Closed: generated-source detection now reads only the continuous leading metadata/comment preamble. Phrases inside executable code, regexes, strings, or comments after code no longer suppress semantic extraction; legitimate generated headers remain supported and regressions cover both boundaries.
4. Team security and cross-platform installation gates still need reproducible clean-machine evidence.
5. Tool semantic contracts, failure envelopes, expanded performance budgets, and privacy/telemetry gates must be exercised as a single release matrix.
6. The highest remaining integral gates are: (1) extend golden truth sets to every advertised language, (2) expand performance budgets beyond search/no-op incremental, (3) clean-machine install/upgrade/reinstall/rollback/uninstall across macOS, Linux, and Windows, and (4) adversarial Team tenant-isolation and webhook-replay security. These are stronger priorities than adding isolated unit tests.

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

1. Restart Codex so the new installed MCP process is loaded.
2. In the new session, resolve `lynx-project`, run representative tool batches, and confirm live runtime behavior.
3. Expand schema/dispatch coverage into domain-specific functional scenarios for every registry entry; retain the canonical fixture and require zero contradictory shared claims.
4. Add golden truth sets for the remaining advertised languages and expand the documented performance-budget matrix with thresholds fixed before implementation.
