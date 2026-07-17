# Performance regression budgets

LYNX enforces deterministic local performance budgets with
`npm run test:performance-budget`. The command builds the current source and
executes `scripts/performance-budget.mjs`; it does not use network services or an
LLM.

## Frozen fixture and measurements

The runner creates an isolated temporary repository containing 40 linked
TypeScript modules, indexes it into an in-memory LYNX database, warms the query
path, and measures:

| Operation | Samples | Required p95 |
| --- | ---: | ---: |
| Exact graph-backed full-text search | 100 | <= 100 ms |
| Incremental index with no changed files | 20 | <= 250 ms |

Every incremental sample must process exactly zero files. A run fails if this
semantic condition or either latency budget is violated. Measurements use the
monotonic Node.js performance clock and nearest-rank percentiles. Median, p95,
maximum, and every raw sample are retained; warm-up observations are excluded.

## CI evidence

The main CI job runs the budget after the complete validation suite. It uploads
`artifacts/performance-budget.json` even when the budget fails. The report
contains only the synthetic fixture label, runtime version, platform,
architecture, thresholds, aggregates, and raw durations. It contains no local
repository path, source code, prompt, token, or user data.

The absolute budgets are intentionally generous across shared CI hosts. They
catch severe regressions while reducing noise-based failures. Tightening a
budget requires retained evidence from multiple clean runs; a regression must
not be hidden by deleting samples, changing the percentile, shrinking the
fixture, or excluding slow measurements.

## Local reference

On the Apple M4 development host on 2026-07-17, the first accepted run measured:

- exact search p95: 0.111 ms;
- no-op incremental index p95: 1.881 ms;
- 100 and 20 measured samples respectively;
- zero files processed by every no-op sample.

These values are reference observations, not universal promises. The enforced
contract is the threshold table above and the raw report produced for each run.
