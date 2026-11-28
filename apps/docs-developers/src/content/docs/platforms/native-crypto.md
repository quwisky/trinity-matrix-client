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

Milestone 3 puts a JavaScript shim between matrix-js-sdk and the crate. The manifest's notes and `shimNotes` say what the shim does for each member; these are the obligations a wrong shim would break silently. `pnpm nx test scripts` fails when a `shimNotes` member, or a member whose note says "the shim must", is not named here.

- Bridge batches stay at or under 1 MB.
- Store: refuse `StoreHandle.open` with a store prefix. WASM then opens a passphrase store, or an unencrypted persistent one when Trinity has no storage key; the crate offers only a raw-key store or memory.
- Stale objects: pass the key from the snapshot its JavaScript object wraps. `ed25519Key` goes to `Device.setLocalTrust`, `Device.verify`, `Device.encryptToDeviceEvent` and `Device.requestVerification`. `masterKey` (the public master key) goes to `OwnUserIdentity.verify`, `OwnUserIdentity.withdrawVerification`, `OtherUserIdentity.withdrawVerification`, `OtherUserIdentity.pinCurrentMasterKey`, `OwnUserIdentity.requestVerification`, `OtherUserIdentity.requestVerification` and `OtherUserIdentity.verificationRequestContent`. Without it the call acts on whatever device or identity now has that ID; with it a changed object fails with `StaleObject`, and nothing changes, is encrypted or is requested.
- Trust: ask `OlmMachine.getDevice` / `OlmMachine.getIdentity` again for each trust question (a snapshot is current only when returned), and build real `OwnUserIdentity` and `OtherUserIdentity` instances from the snapshot's `kind`, because matrix-js-sdk uses `instanceof`.
- Sharing strategy: map `CollectStrategy.deviceBasedStrategy` (`onlyAllowTrustedDevices`, `errorOnVerifiedUserProblem`) in WASM's order (`onlyTrustedDevices`, else `errorOnUnverifiedUserProblem`, else `allDevices`) and `CollectStrategy.identityBasedStrategy` to its own name. A wrong mapping shares room keys with unverified devices.
- Verification: pass the decimals it displayed to `Sas.confirm` (the crate requires them), so a SAS replaced under the same flow ID fails with `StaleObject` instead of being confirmed. Map `UnknownVerification` from `VerificationRequest.cancel`, `VerificationRequest.acceptWithMethods`, `Sas.cancel`, `Sas.cancelWithCode` and `Qr.cancel` on a flow it saw done or cancelled to WASM's "no request". Answer `VerificationRequest.timeRemainingMillis` as `max(0, expiresAtMs - Date.now())`, treat `timedOut` as true at the snapshot's time only, keep its mirrors from the `verificationRequestChanged` and `verificationChanged` events, read `qrCodeBytes` only when matrix-js-sdk asks for the bytes, and build real `Sas` and `Qr` instances by `kind` for `VerificationRequest.getVerification`.
- Events: poll `pollEvents` after every call or batch (`OlmMachine.registerRoomKeyUpdatedCallback` and the other callbacks), and on a non-zero `dropped` treat the view as stale (retry undecryptable events). Call the secret callback (`OlmMachine.registerReceiveSecretCallback`) with the name from `secretReceived` and no value: matrix-js-sdk ignores the value and reads `getSecretsFromInbox`.
- Secrets: a decrypted `m.secret.send` or secret push in the answer of `OlmMachine.receiveSyncChanges` or `OlmMachine.receiveSyncChangesMsc4186` comes without `content.secret`, unlike WASM's (matrix-js-sdk passes the event to the app); the shim must not put it back. Turn the `SecretsBundle` object back into JSON with `to_json()` for `OlmMachine.importSecretsBundle`, and wrap the JSON of `OlmMachine.exportSecretsBundle` in an object whose `to_json()` returns it. Wrap the `decryptionKeyBase64` of `getBackupKeys` with `BackupDecryptionKey.fromBase64` for `BackupKeys.decryptionKey`.
- Import progress: replay the progress listeners of `OlmMachine.importExportedRoomKeys` and `OlmMachine.importBackedUpRoomKeys` from `lastProgress`, as WASM's last listener call.
- Machine state: set `OlmMachine.roomKeyRequestsEnabled` again after every `init` (the crate keeps it in memory only, as upstream). Call `OlmMachine.encryptStateEvent` only after the room key is shared, as matrix-js-sdk does: without one upstream panics, and the crate drops the machine.
- Room key bundles: pass `roomId`, `senderUser` (as `inviter`) and `url` from the bundle data object it was handed, and the downloaded bytes as base64, to `OlmMachine.receiveRoomKeyBundle` (a newer bundle fails with `StaleObject`).
- Dehydrated devices: defer `DehydratedDevices.create` to `keysForUpload`, which is one native call (`createDehydratedDevice`), and refuse a second `keysForUpload` on the same object. Call `dropRehydratedDevice` for `RehydratedDevice.free`.
- libolm: throw "legacy libolm migration is not supported on native" from `Migration.migrateBaseData`, `Migration.migrateOlmSessions` and `Migration.migrateMegolmSessions`.

## Before a release build may use it {#before-release}

The debug surface trusts its JavaScript caller. Before any of it ships in a release build:

- Native code builds the store path itself; JavaScript passes none.
- The store key comes from the Android Keystore and never from JavaScript.
- Plugin registration moves to `main`, behind a flag.
- The request queue is bounded.
- Everything in [What milestone 3 needs](#milestone-3) is in place.
