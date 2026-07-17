# Native Core Engineering Method and Handoff

## Objective

Make LYNX's C/C++ structural engine measurably equal to or better than Codebase
Memory without copying its false-positive behavior, and integrate the result into
the real MCP/CLI product behind validation and rollback boundaries.

## Method that produced the current results

1. **Use the mature competitor as an executable specification.** Inspect the
   exact resolver, registry, usage, preprocessing, and macro-table code before
   designing replacements. Record the order of resolution strategies and their
   confidence policy. Do not re-invent a subsystem until its proven design is
   understood.
2. **Build a reproducible 2x2 benchmark.** Index both the LYNX and Codebase
   repositories with both engines on fresh isolated databases. Record time,
   peak RSS, graph families, logical relationship sets, and raw evidence counts.
   Never compare warm and cold caches or different file sets.
3. **Separate identity, recall, and precision.** Compare symbols by stable
   semantic identity and relationships by source file/name, target file/name,
   and type. Report reference recall and native agreement separately. More edges
   are not automatically better.
4. **Audit disagreements, not just aggregate scores.** Sample both reference-only
   and native-only results against source. The ambiguous `arena.h` example proved
   that Codebase's fallback can select a same-named implementation from the wrong
   directory; LYNX therefore requires import evidence instead of optimizing for
   superficial agreement.
5. **Turn every discovered rule into a fixture oracle.** The fixture suite now
   covers header/implementation identity, same-file calls, include-backed calls,
   global unique calls, ambiguous include selection, semantic macro calls,
   parameters/locals, reads/writes, types/members, and C++ symbols. A fix is not
   accepted without a positive oracle and, where relevant, a negative
   false-positive assertion.
6. **Fix root algorithms.** Replace global SQL scans with an in-memory,
   same-language callable registry; distinguish declarations from
   implementations; resolve ambiguous candidates only through import reachability;
   expand macro call aliases semantically; and model lexical values rather than
   adding name-specific exceptions.
7. **Measure after every semantic expansion.** A change that retained every
   read/write occurrence increased runtime from roughly 4 seconds to 83 seconds.
   The graph needs one logical relation per function/value/type, so repeated
   evidence was compacted while initializer writes were retained. This preserved
   semantics and restored the performance envelope.
8. **Treat staging as an untrusted artifact.** The native worker writes a
   versioned SQLite database. TypeScript validates schema shape, project identity,
   completion, JSON, ranges, uniqueness, and referential integrity before any
   canonical write.
9. **Publish inside one existing product transaction.** Native entities and
   evidence are adapted into the canonical graph only after validation. Any
   publication failure rolls back nodes, edges, evidence, hashes, analysis, and
   SACG projection together.
10. **Activate with explicit degradation behavior.** Missing binary, crash,
    timeout, or invalid staging falls back safely. Unchanged incremental indexing
    remains a no-op; changed C/C++ currently forces a full relationship rebuild
    rather than publishing from an incomplete partial registry.
11. **Use layered gates.** Compile with strict warnings, run ASan/UBSan smoke,
    validate fixtures, run native-to-canonical integration and fault injection,
    run all unit/integration/MCP tests, build the packaged CLI, and finally index
    the fixture through that packaged executable.

## Current measured state

- Codebase logical `CALLS` recall: **92.91%**; native agreement: **98.60%**.
- Existing LYNX canonical `CALLS` recall: **96.83%**.
- Exact duplicate native observations: **0**.
- Codebase-repository native run: about **4.04 s**, **212 MiB peak RSS**.
- Comparison Codebase run: about **3.6 s**, **1.3 GiB peak RSS**.
- Full LYNX test suite: **124 files / 994 tests passed**.
- Packaged macOS ARM64 CLI fixture: **42 nodes / 16 edges**, including native
  evidence, matching the development CLI integration result.

## Implemented product path

`index_repository` uses the supervised CLI indexing worker. That pipeline now
dispatches C/C++ files to `native/lynx_native_core`, validates staging v3, maps
native node kinds into the canonical graph, publishes native `CALLS`, `READS`,
and `WRITES` with confidence/evidence, then performs normal analysis and SACG
projection. Direct CLI indexing uses the identical path. The macOS ARM64 bundle
includes and successfully executes the native core.

## Remaining work, in priority order

1. Receiver/type-backed C++ member and qualified-call resolution.
2. Indirect function-pointer target resolution.
3. Full preprocessor plus source mapping equivalent or superior to `simplecpp`.
4. Unique nested block identities and exact lexical shadowing.
5. Incremental native registry to avoid a full C/C++ rebuild after edits.
6. Recover the remaining wall-time gap and rerun the complete isolated 2x2.
7. Produce and verify separate native-core artifacts for every target in
   `bundle:all`; only macOS ARM64 is proven in this handoff.
8. Restart Codex and verify the live MCP transport. The previous process held an
   older build and its `stdio` transport was already closed; automated MCP tests
   pass, but a fresh client process is required for live confirmation.

## Continuation rule

Continue in the same order: inspect the exact Codebase mechanism, create a small
differential fixture, implement the root semantic model, run precision oracles,
then run performance/memory gates. Do not trade import/type evidence for a higher
agreement percentage, and do not activate a new relationship family until its
false-positive oracle and rollback behavior are proven.
