import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // Serial: shared DB state, prevents flake.
    fileParallelism: false,
    // Hard per-test ceiling: prevents a stalled DB connection from silently
    // blocking the entire suite for 16+ minutes (observed with two concurrent
    // test processes sharing a connection pool). Individual slow tests can
    // override locally with { timeout: N }.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': rootDir,
    },
  },
});
