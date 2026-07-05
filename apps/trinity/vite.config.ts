/// <reference types="vitest" />
import angular from '@analogjs/vite-plugin-angular';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/trinity',
  // Point at tsconfig.base.json explicitly so @trinity/* aliases resolve in spec
  // files too (spec tsconfigs aren't crawled by default) — consistent with the libs.
  plugins: [
    angular(),
    tsconfigPaths({ root: '../../', projects: ['tsconfig.base.json'] }),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts'],
    // The app is just bootstrap + routing now; its unit tests live in the
    // feature-shell lib, so a bare `nx test trinity` legitimately finds none.
    passWithNoTests: true,
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/trinity',
      provider: 'v8' as const,
    },
  },
}));
