/// <reference types="vitest" />
import angular from '@analogjs/vite-plugin-angular';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/libs/feature-crypto',
  // Point at tsconfig.base.json explicitly so workspace path aliases (e.g.
  // @trinity/core) resolve in spec files too — spec tsconfigs aren't crawled by
  // default, and specs are excluded from the lib tsconfig.
  plugins: [
    angular(),
    tsconfigPaths({ root: '../../', projects: ['tsconfig.base.json'] }),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
  },
}));
