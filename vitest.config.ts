import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // threads: each worker is a worker_thread — LYNX_HOME is set via
    // setupFiles and inherited by all dynamic imports within the worker.
    pool: 'threads',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
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
