import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // LYNX exercises native SQLite and tree-sitter/WASM lifecycles. Isolate
    // those resources by process: worker_threads can complete every assertion
    // and still segfault while concurrent native runtimes tear down.
    pool: 'forks',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/hidden-tests/**'],
    // setupFiles runs in each worker before any test file is imported.
    // It sets LYNX_HOME to an isolated temp directory per worker,
    // guaranteeing zero writes to the user's real ~/.lynx.
    setupFiles: ['./tests/setup.ts'],
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        statements: 40,
        branches: 35,
        functions: 45,
        lines: 40,
      },
    },
  },
});
