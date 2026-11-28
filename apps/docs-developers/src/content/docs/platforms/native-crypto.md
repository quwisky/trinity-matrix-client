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

The interop target drives the crate's command-line binary and the repository's WASM package as two devices and compares their answers and request shapes with a golden file. It also runs the contract tests, which run each finished native call and the same WASM call side by side and expect the same answer, including every trust answer about devices and identities, and every step, change event and sent request of each verification flow (SAS, QR codes, cancels) in all four pairings of native and WASM devices, and the secrets inbox and bundle, room key bundles for shared history, dehydrated devices and the remaining machine calls in both mixed pairings. The timeout case waits 61 seconds. Without cargo both are skipped locally and fail in CI. CI runs these checks in the `Native crypto (Rust)` job when the crate, its scripts, the WASM version or the workflow change.

## Surface status {#surface}

`native/crypto/surface.json` lists every WASM class and member the installed matrix-js-sdk uses. Each member of a stateful class (one backed by the machine or its store) is `done` (a native call answers it, proven by a contract-test case), `planned`, or `shim` (the JavaScript shim answers it without a native call, such as `free()`). Value types are listed as pure JavaScript; stateless helpers such as `BackupDecryptionKey` stay on WASM. Nothing is `planned`: every stateful member is a native call or a shim.

| Area               | Done | Planned | Shim |
| ------------------ | ---- | ------- | ---- |
| core               | 23   | 0       | 0    |
| events             | 5    | 0       | 0    |
| room-keys          | 4    | 0       | 0    |
| backup             | 10   | 0       | 0    |
| store              | 0    | 0       | 3    |
| devices-identities | 37   | 0       | 4    |
| cross-signing      | 4    | 0       | 0    |
| verification       | 44   | 0       | 0    |
| secrets            | 5    | 0       | 0    |
| key-bundles        | 10   | 0       | 0    |
| dehydrated-devices | 6    | 0       | 4    |
| libolm-migration   | 0    | 0       | 3    |

`pnpm nx test scripts` fails when matrix-js-sdk uses a member the manifest lacks or no longer uses one it lists, when a `done` member has no contract case, when a member is `planned` without being listed in `ALLOWED_PLANNED` (`scripts/native-crypto-surface.mjs`, empty), or when this table disagrees with the manifest. After a matrix-js-sdk bump, run `node scripts/native-crypto-surface.mjs write`: new members arrive as `planned`, so the check fails until each is a native call or a shim, and members of `OlmMachine` need an area as well.

The libolm migration (`Migration.*`) is not ported. matrix-js-sdk migrates only from a legacy crypto store that holds data; Trinity passes none to `createClient`, so js-sdk's default empty `MemoryCryptoStore` is used and the migration never runs. The same spec fails if the app starts passing a legacy store or pickle key, or sets a store factory.

## Run it on Android {#android}

```bash
native/crypto/build-android.sh
pnpm android:build
```

The script cross-builds `libtrinity_crypto.so` for `x86_64` (pass other ABIs as arguments) into `android/app/src/debug/jniLibs/`, which git ignores. It needs an Android NDK, the Rust Android target and `cargo-ndk`; the README lists the versions. Debug builds then expose the `TrinityCryptoDebug` Capacitor plugin on Android 10 or newer. Without the library the plugin rejects with `NOT_BUILT`, so `pnpm android:build` and the mobile E2E suite need neither Rust nor the NDK.

## Keep the WASM pin {#pin}

The crate pins `matrix-sdk-crypto`, `matrix-sdk-common` and `matrix-sdk-sqlite` exactly to the release the WASM package in the root `package.json` is built on. `node scripts/native-crypto-pin.mjs`, also part of `pnpm nx test scripts`, fails when the WASM version, the pins, `Cargo.lock` or the snapshot `native/crypto/wasm-lock.json` disagree. On a WASM bump, download that release's `Cargo.lock`, refresh the snapshot with `node scripts/native-crypto-pin.mjs snapshot <Cargo.lock> <version> <commit>`, then move the pins and the lock to match.

## Release isolation {#release-isolation}

The plugin and the library live only in `android/app/src/debug`. `pnpm android:build:release` runs `scripts/android-release-isolation.mjs` on the bundle and fails when it contains either. CI builds no Android release yet, so the check runs wherever a release bundle is built.

## What milestone 3 needs {#milestone-3}

Milestone 3 puts a JavaScript shim between matrix-js-sdk and the crate. The manifest's notes and `shimNotes` say what the shim does for each member; these are the obligations a wrong shim would break silently:

- Bridge batches stay at or under 1 MB.
- The shim refuses `StoreHandle.open` with a store prefix: WASM then opens a passphrase store, or an unencrypted persistent one when Trinity has no storage key, and the native crate offers only a raw-key store or memory.
- The shim passes the key from the snapshot its JavaScript object wraps on every device and identity call: `ed25519Key` (`setLocalTrust`, `verifyDevice`, `encryptToDeviceEvent`) and `masterKey`, the public master key (`verifyIdentity`, `withdrawVerification`, `pinCurrentMasterKey`). The verification calls that start from a device or identity take the same keys: `ed25519Key` (`requestDeviceVerification`) and `masterKey` (`requestIdentityVerification`, `verificationRequestContent`). Without it the call acts on whatever device or identity now has that ID; with it a changed object fails with `StaleObject`, and nothing changes, is encrypted or is requested.
- The shim passes the `decimals` it displayed to `confirmSas` (the crate requires them), so a SAS that matrix-sdk-crypto replaced under the same flow ID (a later start from a lower-sorting device, or a SAS replacing a shown QR code) fails with `StaleObject` instead of being confirmed.
- The shim maps `UnknownVerification` from `cancelVerificationRequest`, `acceptVerificationRequest`, `cancelSas` and `cancelQr` on a flow it saw done or cancelled to WASM's "no request" answer: after a sync collects a flow, WASM's held object still answers, the crate no longer finds it.
- The shim answers `timeRemainingMillis` as `max(0, expiresAtMs - Date.now())` and treats `timedOut` as true at the snapshot's time only, reading it again on the next event or at the deadline. It keeps its verification mirrors from the `verificationRequestChanged` and `verificationChanged` events, reads `qrCodeBytes` only when matrix-js-sdk asks for the bytes, and builds real `Sas` and `Qr` instances from the snapshot's `kind`, because matrix-js-sdk uses `instanceof`.
- The shim builds real `OwnUserIdentity` and `OtherUserIdentity` instances from the snapshot's `kind`, because matrix-js-sdk tells them apart with `instanceof`.
- The shim fetches a fresh device or identity snapshot for each trust question instead of caching one: a snapshot is current only when returned.
- The shim replays the import progress listeners from `lastProgress` (`importExportedRoomKeys`, `importBackedUpRoomKeys`), as WASM's last listener call.
- The shim polls `pollEvents` after every call or batch, and on a non-zero `dropped` treats its view as stale (retry undecryptable events). It calls matrix-js-sdk's secret callback with the name from `secretReceived` and no value (js-sdk ignores the value and reads `getSecretsFromInbox`).
- The shim sets `roomKeyRequestsEnabled` again after every `init`: the crate keeps it in memory only, as upstream. It calls `encryptStateEvent` only after the room key is shared, as matrix-js-sdk does: without one upstream panics, and the crate drops the machine.
- The shim passes the `url` of the bundle data it downloaded to `receiveRoomKeyBundle` (a newer bundle fails with `StaleObject`), calls `dropRehydratedDevice` when matrix-js-sdk frees a `RehydratedDevice`, and defers `DehydratedDevices.create()` to `keysForUpload`, which is one native call (`createDehydratedDevice`).
- The shim throws "legacy libolm migration is not supported on native" from `Migration.*`.

## Before a release build may use it {#before-release}

The debug surface trusts its JavaScript caller. Before any of it ships in a release build:

- Native code builds the store path itself; JavaScript passes none.
- The store key comes from the Android Keystore and never from JavaScript.
- Plugin registration moves to `main`, behind a flag.
- The request queue is bounded.
- Everything in [What milestone 3 needs](#milestone-3) is in place.
