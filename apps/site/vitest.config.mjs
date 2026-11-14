import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '../../node_modules/.vite/site',
  test: {
    environment: 'node',
    include: ['src/**/*.spec.mjs'],
    reporters: ['default'],
  },
});
