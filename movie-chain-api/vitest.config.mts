import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Unit tests live next to the code (src/**/*.spec.ts). SWC compiles the
// decorators and emits the metadata Nest's DI needs.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.spec.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
