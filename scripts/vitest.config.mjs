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
    // These specs do real work rather than exercising a unit: `lint-invariants` constructs an
    // ESLint instance and resolves configs against the actual tree, which is ~1.6s on a warm
    // dev machine and 6.3s on a loaded CI runner — past vitest's 5s default, which failed the
    // "Unit tests" job with a timeout rather than an assertion. Raised well clear of the worst
    // observed time so it still catches a genuine hang, but does not fail because the runner
    // was busy. Applies to the whole project; the version-table specs are synchronous and
    // unaffected either way.
    testTimeout: 30_000,
  },
});
