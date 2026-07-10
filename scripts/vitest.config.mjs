import { defineConfig } from 'vitest/config';

// Plain Node ESM build scripts (no Angular). Kept separate from the lib/app configs.
// Cache under the (git-ignored) root node_modules so no scripts/node_modules appears.
export default defineConfig({
  cacheDir: '../node_modules/.vite/scripts',
  test: {
    environment: 'node',
    globals: true,
    include: ['**/*.spec.mjs'],
    reporters: ['default'],
  },
});
