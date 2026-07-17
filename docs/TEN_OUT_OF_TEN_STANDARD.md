# LYNX 10/10 Engineering Standard

> Living product-quality contract. A 10/10 score is earned through repeatable
> evidence, not feature count or subjective confidence.

## Objective

LYNX must be the most reliable and useful local-first code-intelligence engine
for software agents. It should outperform alternatives in evidence quality,
working-tree awareness, operational simplicity, and useful context per token,
while remaining competitive in indexing speed and language coverage.

The target is not to claim that every possible feature exists. The target is
that every advertised capability is correct, discoverable, bounded, tested,
and operationally dependable.

## Scoring model

The product has ten quality domains worth one point each. A domain earns its
point only when every mandatory gate in that domain is green on the current
release candidate. Partial implementation does not round up.

No release may be described as 10/10 when any P0 defect is open, the working
tree is not reproducible, the installed runtime differs from source, or a
mandatory gate lacks saved evidence.

## 1. Tool-contract consistency

- All 33 MCP tools are visible, documented, and represented in `tool_catalog`.
- Every project-taking tool uses the same canonical project resolver.
- Canonical names, absolute roots, case variants, and unique checkout basenames
  resolve identically; ambiguous aliases fail explicitly.
- Errors share a stable structured contract with recovery guidance.
- Read-only and destructive annotations are accurate and tested.
- Default output is deterministic, bounded, and does not invoke an LLM unless
  the caller opts in.
- Overlapping tools agree on project identity, changes, tests, freshness,
  coverage, evidence, and counts.

**Gate:** a generated cross-tool contract suite exercises all tools against a
fixed fixture and reports zero contradictory claims.

## 2. Index lifecycle reliability

- A full index remains full after Codex, Claude, CLI, watcher, and MCP restarts.
- A no-op incremental run processes zero files and preserves exact node, edge,
  evidence, and manifest counts.
- Changed and deleted files replace their relationships idempotently without
  losing distinct call-site evidence.
- Drift detection covers HEAD, tracked changes, untracked discoverable source,
  deletions, and incomplete metadata.
- `doctor`, `diagnose`, `index_status`, dashboard, and project listing use the
  same health semantics.
- Interrupted indexing is recoverable and never publishes a half-built graph.

**Gate:** a restart-and-mutation matrix passes repeatedly on real Git fixtures
and on the installed runtime.

## 3. Evidence correctness

- Every structural relationship can explain its extractor, source location,
  confidence, and evidence chain.
- Repeated call sites are aggregated without discarding locations.
- Tools distinguish confirmed graph evidence, heuristics, searched-not-found,
  and unknown information.
- No tool turns absence of evidence into a positive claim.
- Test coverage uses verified `TESTS` or `TESTS_FILE` relationships and handles
  newly indexed tests correctly.
- Golden repositories validate precision and recall for each supported language.

**Gate:** curated truth sets meet documented precision/recall thresholds and
all cross-tool evidence assertions agree.

## 4. Performance and resource discipline

- Performance budgets are measured in isolation and under parallel agent load.
- Responses remain bounded independently of repository size.
- Indexing adapts to host resources without saturating interactive machines.
- Watcher updates are incremental and do not trigger hidden full rebuilds.
- Expensive graph operations use set-based queries, pagination, and cancellation.
- Memory, CPU, database growth, and cold-start time have regression budgets.

Initial Apple M4 reference budgets for a medium project:

| Operation                      | Target p95 |
| ------------------------------ | ---------: |
| Exact graph search             |  <= 100 ms |
| Code snippet / evidence lookup |  <= 100 ms |
| Depth-3 trace                  |  <= 250 ms |
| Compact context pack           |  <= 500 ms |
| Bounded invariant check        |  <= 200 ms |
| No-op incremental index        |  <= 250 ms |

**Gate:** benchmark CI fails on a statistically significant regression beyond
the agreed tolerance, with raw sanitized results retained for inspection.

Current foundation: `docs/PERFORMANCE_BUDGETS.md` defines and CI enforces the
first deterministic budgets for exact graph search and no-op incremental
indexing. Additional snippet, trace, context-pack, resource, and parallel-load
budgets remain required before this domain gate is complete.

## 5. Extraction depth and language parity

- TypeScript/JavaScript, Python, C, C++, Swift, and other advertised languages
  have explicit capability matrices rather than a generic “supported” label.
- The native C/C++ core must be equivalent or superior to Codebase Memory on
  qualified calls, member access, macros, conditional compilation, function
  pointers, lexical shadowing, overloads, and evidence preservation.
- Unsupported or ambiguous constructs are surfaced honestly.
- Native and TypeScript projections preserve one canonical semantic identity.
- Incremental native extraction and multi-platform artifacts are reproducible.

**Gate:** frozen A/B truth sets and real-repository tasks show no material
regression against the strongest available comparator, with full responses and
methodology saved.

## 6. Installation and operational trust

- Clean install, upgrade, reinstall, rollback, and uninstall are idempotent.
- `lynx doctor` validates the installed binary, actual MCP handshake, hooks,
  graph drift, locks, dashboard, native core, and configuration safety.
- `lynx --version` and build identity expose the exact installed release.
- Source, linked CLI, MCP server, native binary, and dashboard cannot silently
  run different builds.
- Dashboard startup is supervised and its advertised automatic mode is real.

**Gate:** a clean-machine acceptance script installs LYNX, indexes fixtures,
restarts every supported agent, verifies 33 tools, and removes LYNX cleanly.

## 7. Team and security readiness

- Shared graph access is read-only by construction.
- Authentication, repository authorization, and result post-filtering fail closed.
- Remote transport requires TLS except for explicit local development.
- Tokens are stored and displayed safely and are never written to logs.
- Membership and roles have supported management flows and audit records.
- Synchronization, webhook validation, replay protection, and tenant isolation
  have adversarial tests.
- Cross-repository traces retain provenance and authorization at every hop.

**Gate:** threat-model review, API contract tests, tenant-isolation tests, and
dependency/security scans are green.

## 8. Agent and human usability

- A new agent discovers the smallest useful tool without guessing names.
- Tool descriptions teach routing and stopping conditions concisely.
- English is the canonical tool/API language; the dashboard remains complete in
  English and Spanish.
- Dashboard values, provenance, tooltips, persistence, layout, and live updates
  remain stable without flicker.
- CLI output is actionable and consistent with MCP and dashboard output.

**Gate:** scripted first-use tasks and human usability checks complete without
hidden setup knowledge or contradictory terminology.

## 9. Quality engineering and release discipline

- Every confirmed defect receives a root-cause regression test.
- Main, API, native core, installer, dashboard, and real-Git integration suites
  run in their actual workspaces.
- Property, fuzz, concurrency, cancellation, corruption, and recovery tests
  cover high-risk parsers and persistence paths.
- Release candidates have a clean tree, reviewed diff, reproducible build,
  changelog, migration notes, and rollback instructions.
- Generated benchmark artifacts are separated from versioned methodology and
  curated results.

**Gate:** the release checklist is entirely green and the pushed commit is the
same commit installed and tested locally.

## 10. Honest value measurement and privacy

- Measured, estimated, and scenario metrics are mutually exclusive and visibly
  labelled.
- Savings claims are conservative, reproducible, and never presented as direct
  measurements when inferred.
- Local-only operation performs no network call without an explicit feature or
  user action enabling it.
- Usage data, prompts, code, secrets, and repository paths have documented
  retention and redaction rules.
- A/B comparisons freeze model, temperature, seed, order, project state, and
  instructions, and preserve full sanitized responses without artificial caps.

**Gate:** privacy audit and metric-reconstruction tests reproduce every value
shown by CLI, MCP, CSV export, and dashboard.

## Execution roadmap

### Stage A — 9.0: operational consistency

1. Close canonical identity and alias inconsistencies.
2. Unify drift and freshness semantics across every surface.
3. Prove full-index persistence across restarts.
4. Make dashboard supervision reliable.
5. Consolidate, document, push, reinstall, and verify the current Team slice.

### Stage B — 9.5: evidence and extraction leadership

1. ✅ Build the generated 33-tool cross-contract matrix: registry/handler parity
   is startup-enforced and schemas generate required-field, branch, and type contracts.
2. ◐ Establish language truth sets and precision/recall reports: TypeScript, C,
   Python, Go, Rust, Java, Ruby, and C# now run through the real pipeline with
   raw FP/FN and fixed 1.0 thresholds; the remaining advertised languages still
   need equivalent fixtures.
3. Close remaining native C/C++ gaps against Codebase Memory.
4. ◐ Add performance regression CI and resource budgets: deterministic search
   and no-op incremental p95 budgets run in CI and retain raw samples; full-index
   wall time, peak RSS, database growth, and large-repository budgets remain.
5. Add corruption, concurrency, and recovery campaigns.

### Stage C — 10.0: product-grade proof

1. Complete secure Team deployment and tenant-isolation gates.
2. Run clean-machine installation and restart matrices on macOS, Linux, and Windows.
3. Complete independent security and privacy reviews.
4. Run realistic unbounded A/B tasks and publish the reproducible methodology.
5. Require every domain gate above for the release candidate, installed commit,
   and saved evidence bundle.

## Working method

1. Start with the smallest LYNX query that can establish evidence.
2. Reproduce a defect before editing.
3. Trace the cause to the earliest incorrect contract or state transition.
4. Add a regression test at that boundary.
5. Persist denominators and unresolved classifications per file when later fast
   paths cannot reconstruct them from graph edges. Recompose project-wide
   coverage from the complete current file set; never infer extracted work from
   successful edges or from only the changed-file batch.
6. Run focused validation, workspace validation, and the complete suite.
7. Commit coherent changes before rebuild/reinstall operations.
8. Rebuild TypeScript and native artifacts, reinstall, and run `lynx doctor`.
9. Full-index once, run an incremental no-op, restart the agent, and verify again.
9. Save measured evidence and update this standard when a gate evolves.

## Current baseline — 2026-07-17

Current practical assessment: **8.5/10**.

Strongest areas are compact graph-guided discovery, local-first architecture,
evidence inspection, working-tree analysis, and breadth of MCP workflows. The
largest deductions are lifecycle consistency, project identity, diagnostic
agreement, operational supervision, native extraction parity gaps, and the
unfinished production Team surface.

The native baseline now distinguishes nested call observations by exact callee
position and has frozen integration evidence for C++ object-member,
pointer-member, namespace-qualified, and nested calls. Native parity remains
open for template/dynamic dispatch, function-pointer invocation, broader
preprocessing, and complete lexical shadowing.

This score must be recalculated from the gates above after each release; it must
not rise merely because new features were added.
