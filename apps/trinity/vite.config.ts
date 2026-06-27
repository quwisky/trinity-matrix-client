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
    reporters: ['default'],
    // Ionic ships ESM inside a CommonJS-typed package; inline it so Vitest
    // transforms it instead of trying to require() the ES modules.
    server: {
      deps: {
        inline: [/@ionic/, /ionicons/, /@stencil/],
      },
    },
    coverage: {
      reportsDirectory: '../../coverage/apps/trinity',
      provider: 'v8',
    },
  },
}));
