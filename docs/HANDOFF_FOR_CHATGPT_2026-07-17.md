# LYNX Handoff — 2026-07-17

## Current state

LYNX is installed, indexed, healthy, and ready for live MCP use. The working branch is `codex/harden-and-operationalize`.

- `lynx doctor`: 11/11 checks passed.
- MCP runtime: 33/33 tools exposed.
- Dashboard: supervised service healthy at `http://127.0.0.1:9191`.
- Main suite: 132 files, 1098/1098 tests passed with process-isolated native runtimes.
- API suite: 5 files, 22/22 tests passed.
- Root and API typechecks passed.
- Full index at commit `406074c`: 446 files processed, 446 files with graph
  nodes, 6,487 nodes, 34,964 edges, 2.25 s.
- No-op incremental baseline at the same commit: 0 processed, 446 skipped,
  no graph mutations, identical 6,487/34,964 counts, 0.13 s.
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

TypeScript, C, Python, Go, Rust, Java, Ruby, C#, Swift, and Kotlin fixtures now run through the real indexing pipeline and report precision, recall, F1, and raw false-positive/false-negative sets without reshaping denominators. All ten current fixtures require 1.0. The Go wave exposed and closed package-directory resolution; Rust added canonical `crate`/`self` use-path normalization; Java now preserves qualified method names and exposes methods from an imported class file to call resolution. Ruby exposed and closed missing `require_relative` imports and a broader defect where ordinary Ruby calls could be recorded as import metadata. C# exposed and closed missing `using` module identity and imported-file method visibility. Swift freezes same-module cross-file calls without inventing a file import that Swift semantics do not require. Kotlin exposed a registry/grammar contract mismatch: the grammar emits `import_header` and `simple_identifier`, while the shared extractor expected `import_declaration` and generic identifiers. The shared AST contract now recognizes those real node identities and the Kotlin golden is green at 1.0; complete-suite validation and commit remain pending for this active slice.

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

Native preprocessing now evaluates object-like macro values with recursive-descent precedence for parentheses, unary operators, multiplication/division/modulo, addition/subtraction, shifts, comparisons, equality, bitwise operators, `&&`, `||`, ternary expressions, and `defined`. `#define` redefinition and `#undef` update the active environment. Local includes are evaluated recursively at their exact directive position with a shared macro environment, bounded depth, and normal include-guard behavior. All semantic extraction consumes the deterministically conditioned source, while active includes and macro directives remain visible to structural extraction. The regression fixture proves cross-header values, active declarations/calls, and zero inactive `#else`/post-`#undef` symbols. Remaining preprocessing partiality is textual/function-like macro expansion.

Native extraction batches now publish canonical `File` and `Module` nodes using the same qualified-name convention as managed extractors. This restores the standard resolver contract instead of bypassing it: C/C++ includes now create visible file-to-file `IMPORTS` edges while still feeding native call resolution evidence. The preprocessor regression freezes `main.c -> config.h`, `main.c -> api.h`, and the include-backed `main.run -> api.add` call.

## Remaining gaps

These are not release blockers for the current local installation, but they prevent a 10/10 claim:

1. Full-index call resolution is 5,706/27,560 (20.70%) after receiver-preserving extraction, owner-aware resolution, declared-parameter types, and scoped local-binding evidence. Unresolved calls now separate 9,810 unknown receiver targets, 6,830 external dependency targets, 2,029 dynamic local bindings, 1,818 absent targets, 774 native targets, 385 runtime built-in receivers, 152 missing internal-import targets, 30 ambiguous internal targets, 20 self-references, and 6 missing callers. The next root work is field/property assignment flow, broader alias-aware internal-import coverage, and native resolution. Do not restore the old ratio through bare-name matching or denominator shaping.
2. Native C/C++ object members, pointer members, namespace-qualified calls, nested-call identities, lexical function-pointer invocations, standard block/control-initializer shadowing, cross-include preprocessing with full integer precedence, and canonical include `IMPORTS` now have integration evidence. The remaining partial surface is template/dynamic member dispatch, non-lexical/imported function-pointer invocation, textual/function-like macro expansion, and compiler-specific lexical extensions.
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

## Autonomous continuation queue for ChatGPT

This section is the operational backlog if Codex is unavailable. Work top to
bottom. Do not start a later item while an earlier acceptance gate is red. Keep
each change root-cause focused, add the failing regression first, and commit
coherent slices separately. Never weaken a truth set, reshape a denominator, or
restore bare-name resolution to make a metric look better.

### P0 — close and publish the current validated slice

Local closure completed in commit `406074c feat: propagate native macro
environments`. Its full-index/no-op evidence is recorded in Current state.
Rebuild/install, installed-runtime diagnosis, agent restart, GitHub publication,
and remote CI remain the outstanding publication steps.

1. Confirm the working tree contains only the intended native preprocessing,
   Swift golden, documentation, and rebuilt native-binary changes.
2. Preserve the cross-include macro-environment design in
   `native/core/lynx_native_core.c`: includes are evaluated at directive order,
   share the caller environment, respect include guards, and stop at bounded
   recursion depth. Do not replace it with a fixture-specific macro preload.
3. Required evidence: root typecheck, native build, focused native pipeline,
   Swift golden wave, complete main suite, and `git diff --check` all green.
4. Commit, run a non-incremental LYNX index, then an incremental no-op. The
   latter must process zero files without changing graph counts.
5. Rebuild/install the linked runtime, run `lynx doctor`, verify all 33 MCP
   tools and dashboard health, then restart Codex once so the new MCP process is
   loaded. Record exact commit, index counts, timings, and doctor result here.

### P1 — advertised-language golden completion

Owner: new directories below `tests/golden/languages/` and the existing golden
evaluation suites. First derive the advertised language list from the canonical
runtime/configuration source; do not infer it from file extensions in tests.

For each missing language, create a minimal multi-file real-pipeline fixture
that freezes definitions, same/cross-file calls, and the language's real import
semantics. Reports must retain raw FP/FN sets and require node and relationship
precision, recall, and F1 of 1.0. Fix extractor/resolver ownership defects at
their shared boundary, not by special-casing fixture paths or expected names.

Acceptance: every advertised language has a frozen truth set; the complete
golden suite and main suite pass; the capability matrix explicitly distinguishes
unsupported constructs from extraction failures.

Active slice at handoff time: Kotlin fixture and shared extractor correction.
Files are `tests/golden/languages/kotlin/{App.kt,MathLib.kt}`,
`tests/golden/languages/language-golden-wave2.test.ts`,
`src/extraction/language-registry.ts`, and
`src/extraction/tree-sitter-extractor.ts`. Reproduction before the fix produced
zero methods and relations. Root cause: Kotlin's actual grammar uses
`function_declaration`, `import_header`, `simple_identifier`, and
`type_identifier`; the registry named the wrong import node and shared name,
scope, usage, and enclosing-class discovery omitted `simple_identifier`.
Focused golden evidence after the fix: 8/8 wave-two cases pass, Kotlin node and
relation FP/FN are empty at precision/recall/F1 1.0. Root typecheck, 40/40
extractor/registry unit tests, and the 132-file 1,098-test main suite pass.
Commit, rebuild/reinstall, reindex, and installed-runtime doctor remain.

### P1 — remaining native C/C++ semantic gaps

Workstreams, in recommended order:

1. Textual and function-like macro expansion, including argument substitution,
   nested expansion, recursion suppression, token/string operators, and source
   provenance. Extend the preprocessor expression fixture; never invoke an
   uncontrolled system preprocessor as hidden truth.
2. Imported/non-lexical function pointers and callbacks. Preserve declaration,
   assignment, parameter, and invocation evidence; resolve only when type and
   scope identify one target.
3. Template, overload, namespace alias, and dynamic member dispatch. Represent
   ambiguity explicitly rather than selecting a short-name candidate.
4. Compiler-specific lexical extensions only after standard C/C++ cases are
   frozen. Unsupported syntax must retain an honest partial reason.

Primary owners are `native/core/lynx_native_core.c`, the native staging contract,
and resolver utilities. Every slice needs FP=0/FN=0 fixture evidence, exact
callee locations, repeated-call preservation, and a complete-suite run. Compare
against Codebase Memory only with identical repositories and saved sanitized
outputs; copy ideas, not implementation or claims.

### P1 — receiver and data-flow resolution

Close field/property assignment flow and alias-aware internal imports without
polluting global symbol indexes. Local/field evidence must remain separate from
graph definitions, carry owner and scope, and influence resolution only after
its declaration and within its valid container. Add adversarial homonym,
shadowing, reassignment, and cross-function leakage regressions. Acceptance is
better confirmed resolution with no new ambiguous or false edges and unchanged
honest unresolved denominators.

### P1 — clean-machine installation lifecycle

Create a reproducible matrix for clean install, upgrade, same-version reinstall,
rollback, uninstall, and interrupted recovery on macOS, Linux, and Windows.
Validate the actual CLI build identity, MCP handshake and 33-tool catalog,
native artifact, hooks/config preservation, dashboard supervision, index/restart,
and complete cleanup. Test in disposable machines/containers; never mutate a
developer machine as the only proof. Save logs as sanitized CI artifacts.

ChatGPT source audit received 2026-07-17 (not yet an end-to-end acceptance
result): `install.sh` detects Linux/macOS on x64/arm64, downloads a GitHub release,
makes it executable, and performs a CLI smoke test. It does not verify a checksum
or signature and has no native Windows path. The TypeScript installer configures
the supported agents, hooks, runtime config, skill, and supervised dashboard;
uninstall removes those integrations, stops the dashboard, and deliberately
retains indexed databases. `lynx upgrade` currently runs migrations, snapshot
health, freshness, and doctor, but does not download or atomically replace the
installed distribution. There is no install rollback owner. CI is Ubuntu-only
and does not execute install/reinstall/upgrade/rollback/uninstall. Therefore
idempotence is an implementation claim, not a completed gate.

Root implementation order for this front: (1) define a signed/checksummed release
manifest and build identity; (2) implement atomic version replacement with the
previous artifact retained until post-install MCP/doctor acceptance succeeds;
(3) make rollback restore binary, native artifact, and compatible configuration
without deleting user indexes; (4) make `upgrade` own distribution replacement
before migrations; (5) add same-version reinstall and v1→v2→rollback lifecycle
fixtures; (6) add macOS and Windows CI, with a PowerShell-native installation
strategy rather than pretending `install.sh` covers Windows. Do not implement
download/rollback as shell-only behavior: the lifecycle contract must be shared
by CLI and platform entry points.

Active lifecycle slice after the audit: `src/install/distribution.ts` now owns
the platform-neutral filesystem transaction, and
`tests/unit/install/distribution.test.ts` freezes it. An already-downloaded
artifact is SHA-256 verified before any installed file moves; copied to a unique
sibling stage and verified again; published with a same-filesystem rename; then
accepted through an injected real-runtime callback. The accepted current build
is retained as `.previous`. Acceptance failure restores the original build and
removes transaction debris. Explicit rollback swaps current/previous, runs the
same acceptance boundary, restores the pre-rollback state on failure, and keeps
the displaced build available. Root typecheck and 4/4 focused lifecycle tests
pass. Still required before this slice is complete: manifest schema/signature
owner, download adapter, real MCP/doctor acceptance adapter, integration into
`lynx upgrade`, explicit `lynx rollback`, source-linked runtime protection,
complete suite, commit, install/reindex/doctor, and cross-platform acceptance.

CLI rollback is now wired as the first consumer in
`src/cli/commands/rollback-cmd.ts` and the canonical CLI registry. It refuses a
source-linked checkout before filesystem mutation, restores only the packaged
`process.execPath`, and accepts the restored artifact only after the real MCP
handshake exposes all 33 canonical tools. A failed handshake propagates through
the transaction so the pre-rollback build is restored. The distribution and CLI
focused suites pass 7/7 with typecheck. Complete-suite validation and commit are
pending for this sub-slice. `upgrade` download/manifest integration remains the
next owner; do not duplicate the rollback transaction inside that command.

Signed-manifest foundation is active in `src/install/release-manifest.ts` with
tests in `tests/unit/install/release-manifest.test.ts`. Schema
`lynx.release-manifest.v1` declares version, creation time, and one unique HTTPS
asset per platform with positive byte size and SHA-256. Trust is established by
Ed25519 verification of the exact raw manifest bytes before parsing or trusting
any URL/checksum. Duplicate platforms, insecure URLs, malformed hashes, changed
signed bytes, and absent running platforms fail closed. Together with
distribution and rollback tests, typecheck and 11/11 focused lifecycle tests
pass. Still pending: complete suite/commit, an embedded release public key and
rotation policy, bounded downloader with exact size enforcement, and upgrade
integration. Never accept a public key fetched only from the same untrusted
release response.

Bounded download is active in `src/install/release-download.ts` with focused
tests in `tests/unit/install/release-download.test.ts`. It refuses signed assets
above the configured resource ceiling before network activity, disables redirect
following, requires a successful response/body, checks `Content-Length` when
present, streams to a private partial file while enforcing the signed size,
rejects truncation/overflow, verifies SHA-256, and only then publishes the
download. All failure paths remove partial state. Typecheck and 4/4 focused tests
pass; complete-suite validation and commit are pending. The upgrade adapter must
compose signed manifest → bounded download → atomic distribution transaction;
it must not reimplement or bypass any of those owners.

Trusted upgrade composition is active in `src/install/release-client.ts` with
tests in `tests/unit/install/release-client.test.ts`. It maps only the supported
OS/architecture pairs, fetches the manifest/signature as small HTTPS-only trust
documents with redirects disabled and strict size ceilings, verifies Ed25519,
selects one signed platform asset, performs the bounded download, then calls the
atomic distribution transaction and always removes its temporary directory.
The real composition test proves v1→v2 publication, runtime acceptance, and v1
retention; platform mapping is fail-closed. Typecheck and 2/2 focused tests pass.
Still pending: complete suite/commit, production release endpoints and embedded
key/rotation, then a thin packaged-only `upgrade` adapter. Keep the existing
database maintenance steps after successful distribution acceptance; a failed
distribution must never run forward migrations.

Hot-swap prerequisite is active in `src/build-identity.ts` and
`src/mcp/server.ts`. MCP `initialize.serverInfo.version` no longer lies with a
hard-coded `1.0.0`; it uses the canonical LYNX package version. Internal request
`lynx/buildIdentity` returns schema `lynx.build-identity.v1`, version, source
commit, distribution/native hashes, build timestamp, and packaged/source mode.
Missing or malformed provenance remains `null`, never invented. The first test
exposed that generic asset lookup could select Vitest's package and report
`4.1.10`; package identity now accepts only `package.json` with canonical name
`lynx`. Closed in commit `30bb016 fix: publish canonical MCP build identity`.
Typecheck, 21/21 focused identity/MCP tests, and the 138-file 1,117-test suite
pass. A fresh built MCP process proves `initialize` reports `0.2.0` and
`lynx/buildIdentity` reports schema/version/source runtime with unknown provenance
as null. Build-time commit/hash/timestamp injection and supervisor generation
activation remain pending.

Hot-swap Stage 2 core is active in
`src/mcp/supervisor/generation-router.ts` with focused tests in
`tests/unit/mcp/generation-router.test.ts`. The pure router owns generation state
(`preparing/active/draining/retired/failed`) and external JSON-RPC request IDs.
Promotion atomically sends new requests/notifications to the new active worker
while old requests and their cancellations remain routed to the old owner until
its final response retires it. External host IDs are never forwarded directly:
each receives a monotonically unique supervisor ID, responses translate only
through their generation-qualified owner, and cancellations use the same mapping.
This prevents host/internal/cross-generation collisions and rejects a response
from the wrong worker. Failed preparation never changes active state; external
request-ID reuse while in flight is rejected. Typecheck and 5/5 focused tests
pass. Still pending: complete suite/commit, child process framing/backpressure,
candidate handshake/build-identity verification, control channel, drain timeout,
and end-to-end no-Codex-restart proof.

Protocol translation is active in `src/mcp/supervisor/protocol-router.ts` with
tests in `tests/unit/mcp/protocol-router.test.ts`. Host requests are validated,
assigned internal IDs, and translated back only for the owning generation.
`notifications/cancelled` follows the original request to a draining worker and
rewrites its ID; unknown cancellations are dropped. Ordinary host notifications
go only to active; worker notifications are forwarded only from active/draining,
so probe/failed generations cannot leak output to Codex. Typecheck and the
combined generation/protocol suite pass 8/8. Complete-suite validation and
commit remain before child-process transport work.

Continuous ChatGPT coordination is part of the active objective. Current task
ID `20260717T213513Z-5db6be68bc7d`: read-only Windows PowerShell lifecycle and
cross-platform CI acceptance design matching this root contract. It must not
edit repository files or overlap Codex's manifest/transaction slice. Review its
claims against source and tests before turning any proposal into code.

### P1 — full functional MCP contract matrix

The 33/33 registry, handler, and generated argument contracts are complete.
Do not rebuild them. Add one domain-semantic success case and stable structured
failure case per tool against a canonical fixture. Cross-tool assertions must
agree on project identity, counts, drift, changes, evidence, tests, bounds, LLM
opt-in, and destructive/read-only annotations. Acceptance is zero contradictory
claims and deterministic bounded output across repeated runs.

### P2 — performance and resource budgets

Keep the existing exact-search and no-op incremental CI gates. Before measuring,
freeze thresholds and methodology for snippet/evidence lookup, depth-3 trace,
compact context pack, invariant checks, full index wall time, peak RSS, database
growth, cold start, watcher updates, cancellation, and parallel agent load.
Collect multiple isolated samples and retain raw sanitized data. A regression
must fail CI statistically; never discard slow samples after seeing results.

### P2 — corruption, concurrency, and recovery campaigns

Exercise interrupted full/partial indexing, stale/live locks, malformed or
partially migrated databases, concurrent MCP/index/watcher/dashboard starts,
cancellation, process death, and disk-full/write-failure boundaries. The graph
must remain last-known-good or recover transactionally; no half-published state.
Each discovered defect gets a deterministic recovery regression.

### P2 — Team security and privacy

Build the threat model first. Then freeze fail-closed repository authorization,
tenant result post-filtering, TLS requirements, token/log redaction, webhook
signature and replay protection, membership/role audit trails, and provenance on
cross-repository traces. Add adversarial cross-tenant and metric reconstruction
tests. Network, prompt, code, usage, and path retention must be documented and
opt-in behavior verified. This gate requires independent review before 10/10.

### P2 — dashboard and human usability regression matrix

Automate English/Spanish labels, compact tooltips, persistent filters, one-row
responsive cards, aligned values, overflow handling, stable live counters and
non-flickering tooltips. Reconcile dashboard, CSV, CLI, and MCP metrics from the
same underlying records, preserving Measured/Estimated labels. Include narrow
viewport and refresh/reconnect tests rather than screenshot-only approval.

### P2 — reproducible A/B evidence against Codebase Memory

Index both LYNX and Codebase Memory repositories with both engines from clean
state. Freeze versions, hardware, repository commits, warm/cold conditions,
queries, timeouts, and scoring truth. Measure precision/recall, evidence quality,
index/no-op/update latency, RSS, database size, and useful context per token.
Publish full sanitized prompts/responses and limitations. No product superiority
claim is valid until this reproducible bundle exists.

### Release closure checklist

A 10/10 release requires: all ten gates in `TEN_OUT_OF_TEN_STANDARD.md` green;
no P0 defects; clean tree; source commit equals built, installed, tested, and
pushed commit; migrations and rollback documented; full/no-op/restart evidence
saved; and GitHub CI green. If any item is missing, report the exact evidence gap
and retain the current score rather than rounding upward.
