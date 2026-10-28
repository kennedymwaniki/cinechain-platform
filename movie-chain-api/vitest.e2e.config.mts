import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// End-to-end: real Postgres + real Redis. Run on every deploy (onboarding smoke).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/e2e/**/*.spec.ts'],
    globalSetup: ['test/support/global-setup-e2e.ts'],
    testTimeout: 90_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
