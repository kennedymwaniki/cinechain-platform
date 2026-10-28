import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// The isolation suite: required on the default branch, never skipped.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/isolation/**/*.spec.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
