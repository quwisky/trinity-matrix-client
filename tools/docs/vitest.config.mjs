import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '../../node_modules/.vite/docs-site',
  test: {
    environment: 'node',
    include: ['**/*.spec.mjs'],
    reporters: ['default'],
  },
});
