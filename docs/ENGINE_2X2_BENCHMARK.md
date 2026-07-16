# LYNX vs Codebase Memory: reproducible 2×2 benchmark

This benchmark indexes both the LYNX repository and the public Codebase Memory
repository with both engines. Every cell uses a fresh isolated cache and the
same machine. Concurrency defaults to two LYNX workers to keep thermal load
bounded and repeatable.

```bash
npm run build
node scripts/engine-2x2-benchmark.mjs \
  --lynx-repo /path/to/LYNX \
  --codebase-repo /path/to/codebase-memory-mcp \
  --codebase-bin /path/to/codebase-memory-mcp \
  --workers 2 \
  --codebase-single-thread false \
  --out benchmarks/results/engine-2x2.json
```

For a concurrency-normalized comparison, pass `--workers 1` and
`--codebase-single-thread true`. Product-default and normalized runs answer
different questions and should be reported separately.
Use `--workers auto --codebase-single-thread false` for the product-default
comparison so each engine chooses concurrency for the host.

The JSON report includes wall time, peak resident memory, database size, graph
counts by node/edge type, and precision probes shared by both SQLite schemas.
Raw graph volume is never a winner criterion: an engine can create more edges
by making more guesses. Product gates must combine:

1. deterministic precision/recall fixtures with known expected relationships;
2. real-repository coverage and partial-file reporting;
3. unchanged incremental latency;
4. full-index wall time and peak memory;
5. useful task outcomes through the existing agent A/B suite.

The first two precision probes are cross-language TypeScript→C relationships
(normally zero without explicit FFI evidence) and preservation of C source
implementations when a same-name header prototype exists. Further probes should
be added only when they represent a falsifiable defect class with an oracle.
