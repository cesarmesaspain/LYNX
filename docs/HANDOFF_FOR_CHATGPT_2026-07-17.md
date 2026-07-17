# LYNX Handoff — 2026-07-17

## Current state

LYNX is installed, indexed, healthy, and ready for live MCP use. The working branch is `codex/harden-and-operationalize`.

- `lynx doctor`: 11/11 checks passed.
- MCP runtime: 33/33 tools exposed.
- Dashboard: supervised service healthy at `http://127.0.0.1:9191`.
- Main suite: 132 files, 1095/1095 tests passed twice consecutively with process-isolated native runtimes.
- API suite: 5 files, 22/22 tests passed.
- Root and API typechecks passed.
- Full index: 440 files processed, 440 files with graph nodes, 6,241 nodes, 31,110 edges, 2.41 s.
- No-op incremental baseline: 0 processed, 436 skipped, no graph mutations, 0.06 s; revalidation at 438 files is required after the current documentation commit.
- The local branch contains newer validated commits than the last published GitHub state; do not claim synchronization until the branch is pushed.

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

TypeScript, C, Python, Go, Rust, Java, Ruby, and C# fixtures now run through the real indexing pipeline and report precision, recall, F1, and raw false-positive/false-negative sets without reshaping denominators. All eight current fixtures require 1.0. The Go wave exposed and closed package-directory resolution; Rust added canonical `crate`/`self` use-path normalization; Java now preserves qualified method names and exposes methods from an imported class file to call resolution. Ruby exposed and closed missing `require_relative` imports and a broader defect where ordinary Ruby calls could be recorded as import metadata. C# exposed and closed missing `using` module identity and imported-file method visibility.

### Deterministic performance budget foundation

CI now runs a deterministic synthetic 40-module TypeScript workload, enforces p95 budgets for graph search and no-op incremental indexing, and always uploads the sanitized report with raw samples. The methodology is documented in `docs/PERFORMANCE_BUDGETS.md`. Full-index time, peak RSS, database growth, and large-repository budgets remain open.

### Authoritative no-op resolution coverage

No-op incremental indexing previously counted persisted `CALLS` edges as both extracted and resolved calls, discarded unresolved calls and their causes, and therefore reported a fabricated 100% resolution rate. Full and incremental runs now persist the complete resolution summary in `index_runs.coverage_json`; no-op responses reuse that authoritative snapshot exactly. Schema migration 4 adds the column idempotently.

Partial incremental runs also used to replace project-wide coverage with statistics from only the changed files. Schema migration 5 adds `file_call_coverage`, including zero-call files and partial-resolution reasons. Changed, deleted, and renamed files update that table transactionally, and every non-no-op run recomposes the project summary from all current per-file rows before writing `index_runs`. A legacy database without a complete snapshot or one coverage row per indexed file performs one full rebuild instead of guessing; subsequent partial updates and no-ops remain truthful.

### Receiver-preserving call identity

The tree-sitter extractor previously discarded the receiver of member calls before resolution. Calls such as `db.prepare()`, `items.map()`, and `expect(value).toBe()` became the misleading bare names `prepare`, `map`, and `toBe`. This both inflated `target_absent` and allowed accidental cross-file matches to look resolved. Member and chained calls now retain their complete receiver expression. On the current full index, `target_absent` fell from 14,219 to 1,807 and `ambiguous_internal_target` from 1,858 to 29, while 11,936 calls are now honestly classified as `receiver_target_unknown`. Resolved calls fell from 5,527 to 5,414 because 113 unsupported name-only matches are no longer reported as graph evidence.

The first evidence-based receiver wave resolves `this/self` calls only against the caller's exact lexical owner and resolves `ImportedClass.method()` only when one imported class identity and one child callable agree. It does not fall back to a global method-name match. On the live repository this raised confirmed resolutions from 5,414 to 5,610 and reduced missing internal-import targets from 331 to 152.

Declared parameter names and types are now preserved for functions and methods across TypeScript, Python, Java, Go, and Rust syntax orders. The resolver uses that evidence for `parameter.method()` only when one concrete local/imported owner and one child callable agree. Runtime-owned typed receivers and dynamic local receiver bindings are classified separately without creating graph edges. This reduced the remaining unknown-receiver bucket from 11,968 to 9,799 while identifying 2,001 dynamic local bindings and 386 runtime built-ins.

Scoped local-binding evidence is now carried separately from graph nodes. Explicit annotations and constructor assignments record their owner QN, declaration line, complete scope range, type, and evidence origin. They never enter global name indexes, imports, search, or traversal. A local receiver can resolve only after its declaration, inside the same owner and range, against one concrete local/imported class and one method. The live graph currently contains 10 `scoped-local-type`, 27 `declared-parameter-type`, 34 `lexical-receiver`, and 181 `imported-owner` resolutions.

The full suite intermittently completed every assertion and then exited with `SIGSEGV` under Vitest worker threads. Every test family and a single-worker full run passed; the complete thread-pooled run reproduced the crash; the complete fork-pooled run passed. Native SQLite and tree-sitter/WASM lifecycles are now isolated by worker process. Two consecutive complete 1,095-test runs pass with exit code 0.

Native call observations now use the exact callee token as their source location instead of the start of the complete call expression. This removes identity collisions between nested calls such as `label().size()`. The native integration fixture freezes object-member, pointer-member, namespace-qualified, and nested-call evidence; all resolve to their exact target and the nested inner call retains its distinct column.

Native function-pointer parameters and local variables now resolve only through an exact lexical child identity owned by the caller. A same-file function with the same short name cannot create a second edge, and the general same-file value fallback can no longer cross from one function into another function's locals or parameters. The remaining function-pointer partial reason is explicitly limited to non-lexical cases.

Native locals now retain their lexical scope range, repeated references are preserved by exact source position, and same-name declarations receive stable variant identities instead of being collapsed by the staging uniqueness constraint. Resolution selects the latest visible declaration whose block contains the observation, then restores the outer declaration after leaving the block. Fixtures freeze nested compound-block and `for`-initializer shadowing for both calls and value evidence. The residual lexical partial reason is limited to compiler/language extensions outside the modeled C/C++ grammar scopes.

Native preprocessing now evaluates object-like macro values with recursive-descent precedence for parentheses, unary operators, multiplication/division/modulo, addition/subtraction, shifts, comparisons, equality, bitwise operators, `&&`, `||`, ternary expressions, and `defined`. `#define` redefinition and `#undef` update the active environment. All semantic extraction now consumes the deterministically conditioned source, while active includes and macro directives remain visible to structural extraction. The regression fixture proves that active declarations and calls survive and inactive `#else`/post-`#undef` symbols produce zero false positives. Remaining preprocessing partiality is explicitly cross-include macro propagation and textual/function-like macro expansion.

Native extraction batches now publish canonical `File` and `Module` nodes using the same qualified-name convention as managed extractors. This restores the standard resolver contract instead of bypassing it: C/C++ includes now create visible file-to-file `IMPORTS` edges while still feeding native call resolution evidence. The preprocessor regression freezes `main.c -> config.h`, `main.c -> api.h`, and the include-backed `main.run -> api.add` call.

## Remaining gaps

These are not release blockers for the current local installation, but they prevent a 10/10 claim:

1. Full-index call resolution is 5,706/27,560 (20.70%) after receiver-preserving extraction, owner-aware resolution, declared-parameter types, and scoped local-binding evidence. Unresolved calls now separate 9,810 unknown receiver targets, 6,830 external dependency targets, 2,029 dynamic local bindings, 1,818 absent targets, 774 native targets, 385 runtime built-in receivers, 152 missing internal-import targets, 30 ambiguous internal targets, 20 self-references, and 6 missing callers. The next root work is field/property assignment flow, broader alias-aware internal-import coverage, and native resolution. Do not restore the old ratio through bare-name matching or denominator shaping.
2. Native C/C++ object members, pointer members, namespace-qualified calls, nested-call identities, lexical function-pointer invocations, standard block/control-initializer shadowing, full integer-precedence preprocessing expressions, and canonical include `IMPORTS` now have integration evidence. The remaining partial surface is template/dynamic member dispatch, non-lexical/imported function-pointer invocation, cross-include macro environments/textual macro expansion, and compiler-specific lexical extensions.
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
