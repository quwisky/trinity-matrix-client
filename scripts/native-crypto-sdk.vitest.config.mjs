import { defineConfig } from 'vitest/config';

// The SDK test bed builds native/crypto with cargo and starts the disposable homeserver in
// Docker, so it runs as `scripts:native-crypto-sdk`, apart from the unit tests.
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../node_modules/.vite/native-crypto-sdk',
  test: {
    environment: 'node',
    globals: true,
    include: ['native-crypto-sdk.e2e.mjs'],
    reporters: ['verbose'],
    env: { TRINITY_E2E_PORT_OFFSET: '' },
    fileParallelism: false,
    // A cold `cargo build` of the crate and the homeserver's first start take minutes.
    hookTimeout: 900_000,
    testTimeout: 90_000,
    // The bridge-failure case kills the CLI. matrix-js-sdk's RoomEncryptor starts
    // `doProcessOutgoingRequests()` without a catch, so the failed `outgoingRequests` call that
    // follows is unhandled there, as it is on WASM once the machine is gone. Only that error,
    // from a CLI the test killed, is ignored.
    onUnhandledError: (error) =>
      !/^native crypto outgoingRequests: the bridge failed: trinity-crypto-cli exited \(SIGKILL\)$/.test(
        error?.message ?? '',
      ),
  },
});
