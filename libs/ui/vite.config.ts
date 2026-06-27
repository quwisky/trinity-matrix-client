/// <reference types="vitest" />
import angular from '@analogjs/vite-plugin-angular';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/libs/ui',
  // Point at tsconfig.base.json explicitly so workspace path aliases resolve in
  // spec files too — kept consistent with the other libs.
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
    // @ionic/core ships ESM inside a CJS package; inline it so Vitest transforms
    // it (needed once components render Ionic web components like <ion-icon>).
    server: { deps: { inline: [/@ionic/, /ionicons/] } },
  },
}));
