# LYNX Native Structural Core

## Decision

LYNX will replace the existing lexical `lynx_ts_extractor` with a native,
evidence-preserving structural engine. The native core owns the hot deterministic
path: parsing, observations, symbol registries, relationship resolution, and
staging persistence. TypeScript continues to own MCP, product policy, SACG,
dashboard, fallback languages, and publication validation.

The lexical extractor is not an acceptable production foundation. It may remain
only as a test fixture until the native core passes every activation gate.

## Why a hybrid architecture

A full product rewrite in C would recreate stable product code without improving
the measured bottleneck. A parser-only binding also fails: the previous native
Node Tree-sitter experiment made indexing slower because millions of boundary
operations remained in JavaScript. The native boundary must therefore encompass
the complete structural phase and return one compact artifact.

## Process boundary

The supervised native worker receives a manifest containing repository identity,
file paths, sizes, hashes, languages, mode, worker budget, and cancellation path.
It writes a temporary SQLite staging database and atomically marks `native_run`
complete. It never writes the canonical project database directly.

The parent validates schema version, project identity, completion, referential
integrity, line ranges, qualified-name uniqueness, JSON validity, coverage, and
precision oracles. Only a valid artifact may be adapted into the canonical graph.
A crash or invalid artifact leaves the previous graph untouched.

## Execution model

1. Discover and hash files once.
2. Dispatch work through an atomic work-stealing counter.
3. Give every worker a parser, arena, observation buffer, and error list.
4. Parse each file once and retain compact observations, not source text.
5. Merge worker-local symbol buffers deterministically.
6. Build read-only per-language and per-module registries once.
7. Resolve calls, imports, usages, tests, and semantic relationships in parallel
   into worker-local edge/evidence buffers.
8. Merge deterministically and write one staging transaction.
9. Validate in TypeScript and publish atomically.

## Precision invariants

- No cross-language name-only relationship.
- Header declarations and source implementations have distinct identities.
- Ambiguous C/C++ includes remain unresolved.
- Receiver-qualified calls require receiver/type/import evidence.
- Unexported symbols never resolve across files without explicit evidence.
- Test relationships originate only from verified test files/functions.
- Every published edge has source evidence and confidence provenance.
- Partial extraction is visible per file; no silent truncation.

## Production integration status (2026-07-16)

The native core is now connected to the normal indexing pipeline for C, C++,
and their header variants. The CLI and MCP `index_repository` path share the
same supervised pipeline, so no separate product mode is required.

- The worker writes schema-v3 staging and the parent validates identity,
  completion, table shape, JSON, line ranges, unique identities, and orphaned
  relationships before publication.
- Native nodes and evidence-backed `CALLS`, `READS`, and `WRITES` relationships
  are adapted into the canonical graph inside its existing atomic transaction.
- A native crash, timeout, missing binary, or invalid staging artifact falls
  back to the safe extractor before canonical state is changed.
- Publication failure rolls back the whole graph update; this is covered by an
  end-to-end native pipeline fault-injection test.
- Unchanged incremental runs remain no-op. A changed C/C++ file currently
  triggers a safe full relationship rebuild so a partial native registry can
  never create an incomplete cross-file graph.
- `LYNX_DISABLE_NATIVE_CORE=1` is the emergency fallback switch;
  `LYNX_NATIVE_CORE_PATH` selects a reviewed custom binary; and
  `LYNX_NATIVE_CORE_TIMEOUT_MS` bounds worker execution.
- Release builds support strict warnings-as-errors and an AddressSanitizer plus
  UndefinedBehaviorSanitizer verification mode.

Latest isolated Codebase Memory repository measurement: 92.91% recall of
Codebase's logical `CALLS` set with 98.60% agreement, 96.83% recall against the
existing LYNX canonical call graph, zero duplicate exact observations, about
4.04 seconds native execution, and about 212 MiB peak resident memory. The
comparison Codebase run was about 3.6 seconds and 1.3 GiB peak resident memory.
These are engineering measurements, not a claim that either graph is ground
truth; audited ambiguous-include examples show cases where LYNX deliberately
rejects or corrects Codebase's name-based target.

## Activation gates

The native path cannot become the default until all gates pass on fresh isolated
caches:

1. Exact fixture precision and recall are at least equal to the TypeScript engine.
2. All known LYNX false-positive regression fixtures remain at zero.
3. C/C++ implementation preservation exceeds Codebase Memory.
4. Full-index wall time is no worse than Codebase on both benchmark repositories.
5. Peak memory is no worse on the C-heavy repository.
6. Unchanged incremental latency remains below the documented SLO.
7. Worker crash, timeout, corrupt staging, and cancellation preserve the previous
   canonical graph and permit immediate recovery.
8. The full MCP and agent outcome suites show no regression.

The core is active for supported C/C++ files with validation, rollback, timeout,
and fallback protection. The following improvements remain explicitly open and
must not be hidden by the activation:

1. Complete receiver/type-backed C++ member and qualified-call resolution.
2. Resolve indirect function-pointer targets beyond the pointer symbol itself.
3. Replace partial macro expansion with a full preprocessor and source map at
   least equivalent to Codebase's `simplecpp` path.
4. Give nested lexical declarations distinct block-scoped identities and model
   shadowing without name collapse.
5. Add a native incremental registry so C/C++ edits do not require the current
   safe full relationship rebuild.
6. Close the remaining wall-time gap, rerun the isolated 2x2 A/B on both LYNX
   and Codebase Memory, and add platform-specific native artifacts to the
   multi-platform release pipeline.
7. Restore and verify the live LYNX MCP transport; a closed transport observed
   during development is separate from the now-tested CLI/MCP indexing code.

## Codebase Memory reuse policy

Codebase Memory is MIT licensed. LYNX may reuse selected implementation ideas or
source with the required copyright and license notices. Reused code must be
isolated, pinned to a reviewed upstream commit, covered by LYNX tests, and changed
where its behavior conflicts with LYNX precision invariants. Graph volume alone
is never evidence of correctness.
