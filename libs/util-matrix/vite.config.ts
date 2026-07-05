/// <reference types="vitest" />
import angular from '@analogjs/vite-plugin-angular';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/libs/util-matrix',
  // Point at tsconfig.base.json explicitly so workspace path aliases (e.g.
  // @trinity/util-matrix) resolve in spec files too — kept consistent with the
  // other libs so these configs are copy-safe.
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
