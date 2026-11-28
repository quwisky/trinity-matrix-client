---
title: Native crypto (experimental)
description: Build and test the experimental native end-to-end encryption crate and its Android debug plugin.
audience: developer
contentChannel: develop
canonicalTopic: platform-native-crypto
pageType: how-to
platforms: [android]
---

`native/crypto` is a Rust crate that runs the same `matrix-sdk-crypto` release as the WASM package behind one JSON call surface, for the phone apps. It is **experimental: Android debug builds only, and the app does not use it**. The crate's [README](https://github.com/quwisky/trinity-matrix-client/blob/main/native/crypto/README.md) is the reference for its call surface, store and key rules, and JNI wrapper.

## Build and test {#build-test}

```bash
cd native/crypto
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
cd ../..
pnpm nx run scripts:native-crypto-interop
```

The interop target drives the crate's command-line binary and the repository's WASM package as two devices and compares their answers and request shapes with a golden file. It also runs the contract test, which runs each finished native call and the same WASM call side by side and expects the same answer. Without cargo both are skipped locally and fail in CI. CI runs these checks in the `Native crypto (Rust)` job when the crate, its scripts, the WASM version, the facade or the workflow change.

## Surface status {#surface}

`native/crypto/surface.json` lists every WASM class and member the installed matrix-js-sdk uses. Each member of a stateful class (one backed by the machine or its store) is `done` (a native call answers it, proven by a contract-test case), `planned`, or `shim` (the JavaScript shim answers it without a native call, such as `free()`). Value types are listed as pure JavaScript; stateless helpers such as `BackupDecryptionKey` stay on WASM.

| Area               | Done | Planned | Shim |
| ------------------ | ---- | ------- | ---- |
| core               | 15   | 8       | 0    |
| events             | 2    | 3       | 0    |
| room-keys          | 4    | 0       | 0    |
| backup             | 10   | 0       | 0    |
| store              | 0    | 0       | 3    |
| devices-identities | 0    | 32      | 4    |
| cross-signing      | 0    | 4       | 0    |
| verification       | 0    | 38      | 0    |
| secrets            | 0    | 5       | 0    |
| key-bundles        | 0    | 10      | 0    |
| dehydrated-devices | 0    | 7       | 3    |
| libolm-migration   | 0    | 3       | 0    |

`pnpm nx test scripts` fails when matrix-js-sdk uses a member the manifest lacks or no longer uses one it lists, when a `done` member has no contract case, or when this table disagrees with the manifest. After a matrix-js-sdk bump, run `node scripts/native-crypto-surface.mjs write`: new members arrive as `planned`, and members of `OlmMachine` need an area before the check passes.

## Run it on Android {#android}

```bash
native/crypto/build-android.sh
pnpm android:build
```

The script cross-builds `libtrinity_crypto.so` for `x86_64` (pass other ABIs as arguments) into `android/app/src/debug/jniLibs/`, which git ignores. It needs an Android NDK, the Rust Android target and `cargo-ndk`; the README lists the versions. Debug builds then expose the `TrinityCryptoDebug` Capacitor plugin on Android 10 or newer. Without the library the plugin rejects with `NOT_BUILT`, so `pnpm android:build` and the mobile E2E suite need neither Rust nor the NDK.

## The crypto backend facade {#facade}

`@matrix-org/matrix-sdk-crypto-wasm` resolves to `libs/native/crypto-backend`, everywhere: Trinity's libs, the E2E support code and matrix-js-sdk's own imports. An `overrides` entry in `pnpm-workspace.yaml` links the facade in place of the package, and the facade installs the real package under the alias `@matrix-org/matrix-sdk-crypto-wasm-real` and re-exports all of it with `export *` (ESM and types) or as the same `module.exports` object (CommonJS). This is where a native backend can later slot in under matrix-js-sdk.

Today it changes nothing: every export is the WASM package's own object, which `src/matrix-sdk-crypto-wasm.spec.ts` checks name by name, and the build serves the same `.wasm` file at `assets/crypto/matrix_sdk_crypto_wasm_bg.wasm`. Nx cannot see the override, so `libs/util/matrix` and `e2e/support` name the facade in `implicitDependencies`; every other project that loads the package reaches it through them, which `scripts/crypto-backend-dependents.spec.mjs` checks, so an edit to the facade re-runs their builds and tests. Code that needs the package's files rather than its exports, such as the build's asset rule, reads them from `libs/native/crypto-backend/node_modules/@matrix-org/matrix-sdk-crypto-wasm-real`.

## Keep the WASM pin {#pin}

The crate pins `matrix-sdk-crypto`, `matrix-sdk-common` and `matrix-sdk-sqlite` exactly to the release the WASM package in the root `package.json` is built on. `node scripts/native-crypto-pin.mjs`, also part of `pnpm nx test scripts`, fails when the WASM version, the pins, `Cargo.lock` or the snapshot `native/crypto/wasm-lock.json` disagree. On a WASM bump, download that release's `Cargo.lock`, refresh the snapshot with `node scripts/native-crypto-pin.mjs snapshot <Cargo.lock> <version> <commit>`, then move the pins and the lock to match.

The same check fails unless three versions are equal: the root `package.json`'s WASM version, the facade's `npm:` alias in `libs/native/crypto-backend/package.json`, and the exact version the installed matrix-js-sdk depends on. The override replaces matrix-js-sdk's own pin without a warning, so a matrix-js-sdk update that moves its pin would otherwise run on the old WASM. Renovate does not bump the three together: it never moves the WASM package, in either manifest, and the matrix-js-sdk update it opens changes only the SDK's pin. The pin check fails that update until whoever takes it moves both the root `package.json` version and the facade's alias to the SDK's new pin (and `native/crypto` with them, as above).

## Release isolation {#release-isolation}

The plugin and the library live only in `android/app/src/debug`. `pnpm android:build:release` runs `scripts/android-release-isolation.mjs` on the bundle and fails when it contains either. CI builds no Android release yet, so the check runs wherever a release bundle is built.

## Before a release build may use it {#before-release}

The debug surface trusts its JavaScript caller. Before any of it ships in a release build:

- Native code builds the store path itself; JavaScript passes none.
- The store key comes from the Android Keystore and never from JavaScript.
- Plugin registration moves to `main`, behind a flag.
- The request queue is bounded.
- The shim refuses `StoreHandle.open` with a store prefix: WASM then opens a passphrase store, or an unencrypted persistent one when Trinity has no storage key, and the native crate offers only a raw-key store or memory.
