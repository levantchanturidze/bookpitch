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
  },
  resolve: {
    alias: {
      '@': rootDir,
    },
  },
});
