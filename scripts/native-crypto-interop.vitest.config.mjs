import { defineConfig } from 'vitest/config';

// The interop test builds native/crypto with cargo, so it stays out of the `scripts` test
// target and runs as `scripts:native-crypto-interop`.
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../node_modules/.vite/native-crypto-interop',
  test: {
    environment: 'node',
    globals: true,
    include: ['native-crypto-interop.test.mjs'],
    reporters: ['verbose'],
    // A cold `cargo build` of the crate and matrix-sdk-crypto takes minutes.
    hookTimeout: 900_000,
    testTimeout: 60_000,
  },
});
