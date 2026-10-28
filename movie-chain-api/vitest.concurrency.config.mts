import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Races against real Postgres (and, from step 13, real Redis). Never mocks.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/concurrency/**/*.spec.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
