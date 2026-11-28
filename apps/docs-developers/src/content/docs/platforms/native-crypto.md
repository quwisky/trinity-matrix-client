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

The interop target drives the crate's command-line binary and the repository's WASM package as two devices and compares their answers and request shapes with a golden file. It also runs the contract tests, which run each finished native call and the same WASM call side by side and expect the same answer, including every trust answer about devices and identities, and every step, change event and sent request of each verification flow (SAS, QR codes, cancels) in all four pairings of native and WASM devices, and the secrets inbox and bundle, room key bundles for shared history, dehydrated devices and the remaining machine calls in both mixed pairings. The timeout case waits 61 seconds. Without cargo both are skipped locally and fail in CI. CI runs these checks in the `Native crypto (Rust)` job when the crate, its scripts, the WASM version, the facade, the matrix-js-sdk patch or the workflow change.

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

## The JavaScript shim {#shim}

The shim lets matrix-js-sdk's own crypto layer (`initRustCrypto`) run on the crate. It lives in `libs/native/crypto-backend/src/native` and loads only through `installNativeCrypto` from `libs/native/crypto-backend/src/index.ts`, a dynamic `import()` that nothing in the app calls yet. `installNativeCrypto({ bridge, storeDirectory })` points the static factories of the real WASM classes (`StoreHandle.open` and `openWithKey`, `OlmMachine.initFromStore` and `initialize`, `Migration.*`) at the crate. Every other export stays the WASM package's own object. Install it before anything initialises crypto: a WASM machine made earlier stays on WASM. It returns `uninstallForTests`, which puts the originals back for tests; after it, the next `initRustCrypto` runs on WASM beside the crate's machines, two backends in one process.

- A factory returns a stand-in for the WASM class: its prototype sits on a guard of the real prototype, so `instanceof` holds and every member the shim does not implement throws "… is not implemented on native crypto" instead of reaching wasm with no pointer. The stand-ins own no wasm memory; their `free()` releases nothing.
- Values the crate returns become real WASM objects where JavaScript can construct the class (identifiers, every outgoing request class, `RoomSettings`), and guarded value objects of the class otherwise (`DecryptedRoomEvent`, `EncryptionInfo`, `MegolmDecryptionError`, …).
- The bridge is `call(request)` and `callBatch(requests)` over the crate's JSON. Calls made in one JavaScript task go as one batch, split to stay under 1 MB, answered in call order, and one refused item fails only its own call. Each batch also polls the events of the machines it called, and those reach matrix-js-sdk's callbacks before any call of the batch settles.
- `StoreHandle.openWithKey` opens `<storeDirectory>/<store name>` with the raw key; `StoreHandle.open` with a store name is refused, and without one it is a memory store. A wrong key fails at `init`.
- A machine the crate dropped (a call answered `Panic`, or `UnknownMachine` after one) is reloaded from its store with `init`, and a call that is safe to replay runs once more; `REPLAYABLE` in `src/native/machine.ts` lists them and says why the others (`markRequestAsSent`, `shareRoomKey`, the encrypt calls including `encryptToDeviceEvent`, `invalidateGroupSession`, `bootstrapCrossSigning`, `pushSecretToVerifiedDevices`) are only rejected. The trust setters replayed carry the same key as their first try, so a replay cannot reach a changed device or identity. A replayed sync input is safe: `scripts/native-crypto-replay.test.mjs` shows that a reloaded machine answers an Olm message it already decrypted as undecryptable, keeps the room key and uploads no published one-time key again.
- A machine is lost when the bridge fails, times out (a batch gets the longest limit of the calls it holds: 10 minutes for `init` and room key exports and imports, 5 minutes for the sync inputs, `shareRoomKey`, `markRequestAsSent` and `getMissingSessions`, 60 seconds for the rest; `slowTimeoutMs`, `heavyTimeoutMs` and `timeoutMs` change them, and a batch still waiting after 60 seconds is logged), answers a poll with something other than events, or when the reload fails. Then `onMachineLost(reason)` is called once, every other call rejects with `NativeMachineLostError`, and `receiveSyncChanges` and `receiveSyncChangesMsc4186` never settle. matrix-js-sdk's sync (`processSyncCryptoChanges` in `sync.ts`) logs a rejected sync input and goes on, and its next request with the new `since` token lets the server delete the to-device events (room keys, Olm messages) the machine never saw; a sync input that never settles keeps the sync loop from sending that request, so a client started again on the same store receives them. The host must stop the client on `onMachineLost`. A closed or lost machine drops the `init` parameters it kept for a reload, store key included.
- A failed or malformed poll calls `onEventsDropped`, as a non-zero `dropped` does. Answers that would read as a legitimate "none" or a trust answer (`getMissingSessions`, `getRoomSettings`, `isBackupEnabled`, `getIdentity`, `getDevice`, `getUserDevices`, `crossSigningStatus`, `verifyBackup`, the encryption info of an event) are checked and fail closed with `UnexpectedAnswer` when their shape is wrong.
- Devices, identities and backup keys (`src/native/trust.ts`) are stand-ins built from the crate's snapshot: `Device`, `UserDevices`, `OwnUserIdentity` or `OtherUserIdentity` by the snapshot's `kind`, and `BackupKeys`, whose `decryptionKey` is a real `BackupDecryptionKey` (a new copy on each read, as WASM's getter gives). Every getter matrix-js-sdk reads answers synchronously from the snapshot; every method is a call that carries the key the snapshot was read with (`ed25519Key` for a device, the public `masterKey` for an identity) and is refused in JavaScript, before anything is sent, when the snapshot holds none. A device or identity that changed since fails with `NativeCryptoError` code `StaleObject` (one the machine no longer knows: `UnknownDevice`, `UnknownIdentity`); matrix-js-sdk's call (`setDeviceVerified`, `pinCurrentUserIdentity`, …) rejects with it and nothing is trusted. WASM's object would instead act on whatever device or identity now has that ID. A snapshot is as fresh as WASM's object: WASM's is also the store's data as read, and matrix-js-sdk reads a device or identity again for each trust question.
- The room key imports call matrix-js-sdk's progress listener once, when the import is done, with WASM's last arguments (`lastProgress`); WASM calls it once per key.
- `native/crypto/surface.json` marks each member the shim implements with `shimImpl: true`; `libs/native/crypto-backend/src/native/surface.spec.ts` fails when a marked member has no implementation, or a stand-in is not over its WASM class.

| Area                                  | In the shim | Still throws                                                                                                                           |
| ------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| core, events, store, libolm-migration | 34 of 34    | —                                                                                                                                      |
| room-keys, backup, cross-signing      | 18 of 18    | —                                                                                                                                      |
| devices-identities                    | 37 of 41    | the four `requestVerification` and `verificationRequestContent` members                                                                |
| secrets                               | 3 of 5      | `exportSecretsBundle`, `importSecretsBundle`                                                                                           |
| key-bundles                           | 4 of 10     | building, sharing and receiving bundles, `hasDownloadedAllRoomKeys` and its setter; `getReceivedRoomKeyBundleData` answers only "none" |
| verification                          | 0 of 44     | all                                                                                                                                    |
| dehydrated-devices                    | 0 of 10     | all                                                                                                                                    |

```bash
pnpm nx run scripts:native-crypto-sdk
```

The SDK test bed starts the disposable homeserver and runs real matrix-js-sdk clients in Node: one on the shim with the crate's CLI as the bridge, the others on WASM, in both roles, and the same flows with every client on WASM as the control. It checks device key upload, an encrypted room that members join later, messages both ways, a rotated session, a message whose room key arrives after it, the encryption info a WASM receiver reports for the same event, a restart on the same store (and a wrong key that fails), a machine the crate dropped and the shim reloads, and a CLI that dies mid-session: the machine is lost, the sync stops, and a room key sent meanwhile reaches the client started again on the same store. `scripts/native-crypto-sdk-trust.e2e.mjs` runs the trust paths the same way, with the shim on one user's first device and on the other user's second device: cross-signing bootstrapped on both sides, the other user verified by signing their identity, local trust and blacklisting deciding who gets room keys, secret storage and a key backup, a second device that imports room keys (with progress), distrusts the backup until it imports cross-signing from secret storage, refuses a wrong backup key and restores with the right one, a restart that keeps cross-signing and the backup, an identity reset reported as a violation then withdrawn and pinned, and a device replaced under its ID whose stale read is refused (`StaleObject`, nothing trusted). matrix-js-sdk has no non-interactive way to verify another user, so the bed calls `OtherUserIdentity.verify()` on the machine and sends the request through matrix-js-sdk. Its clients repair stale memberships as the app does (`stale-membership-repair.ts`): Tuwunel can send a `state_after` that lags the same response's timeline. It needs cargo and Docker: without either it is skipped and says why, and in CI it fails instead. CI runs it in the `Native crypto (Rust)` job.

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

## What milestone 3 needs {#milestone-3}

Milestone 3 puts a JavaScript shim between matrix-js-sdk and the crate. The manifest's notes and `shimNotes` say what the shim does for each member; these are the obligations a wrong shim would break silently. `pnpm nx test scripts` fails when a `shimNotes` member, or a member whose note says "the shim must", is not named here.

- Bridge batches stay at or under 1 MB.
- Store: refuse `StoreHandle.open` with a store prefix. WASM then opens a passphrase store, or an unencrypted persistent one when Trinity has no storage key; the crate offers only a raw-key store or memory.
- Stale objects: pass the key from the snapshot its JavaScript object wraps. `ed25519Key` goes to `Device.setLocalTrust`, `Device.verify`, `Device.encryptToDeviceEvent` and `Device.requestVerification`. `masterKey` (the public master key) goes to `OwnUserIdentity.verify`, `OwnUserIdentity.withdrawVerification`, `OtherUserIdentity.withdrawVerification`, `OtherUserIdentity.pinCurrentMasterKey`, `OwnUserIdentity.requestVerification`, `OtherUserIdentity.requestVerification` and `OtherUserIdentity.verificationRequestContent`. Without it the call acts on whatever device or identity now has that ID; with it a changed object fails with `StaleObject`, and nothing changes, is encrypted or is requested.
- Trust: ask `OlmMachine.getDevice` / `OlmMachine.getIdentity` again for each trust question (a snapshot is current only when returned), and build real `OwnUserIdentity` and `OtherUserIdentity` instances from the snapshot's `kind`, because matrix-js-sdk uses `instanceof`.
- Sharing strategy: map `CollectStrategy.deviceBasedStrategy` (`onlyAllowTrustedDevices`, `errorOnVerifiedUserProblem`) in WASM's order (`onlyTrustedDevices`, else `errorOnUnverifiedUserProblem`, else `allDevices`) and `CollectStrategy.identityBasedStrategy` to its own name. A wrong mapping shares room keys with unverified devices.
- Verification: pass the decimals it displayed to `Sas.confirm` (the crate requires them), so a SAS replaced under the same flow ID fails with `StaleObject` instead of being confirmed. Map `UnknownVerification` from `VerificationRequest.cancel`, `VerificationRequest.acceptWithMethods`, `Sas.cancel`, `Sas.cancelWithCode` and `Qr.cancel` on a flow it saw done or cancelled to WASM's "no request". Answer `VerificationRequest.timeRemainingMillis` as `max(0, expiresAtMs - Date.now())`, treat `timedOut` as true at the snapshot's time only, keep its mirrors from the `verificationRequestChanged` and `verificationChanged` events, read `qrCodeBytes` only when matrix-js-sdk asks for the bytes, and build real `Sas` and `Qr` instances by `kind` for `VerificationRequest.getVerification`.
- Lost machine: when the shim calls `onMachineLost`, the host must stop the client. The shim keeps that machine's sync input pending so matrix-js-sdk does not move past to-device events it never processed; a host that keeps the client running syncs nothing more on it.
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
- Nothing the shim leaves throwing is reachable for a normal account. A received room key bundle makes `getReceivedRoomKeyBundleData` throw, so `maybeAcceptKeyBundle` fails when an inviter shared history; a cross-signed user's `invite` into a room whose history is shared calls `shareRoomHistoryWithUser`, where `hasDownloadedAllRoomKeys` throws, so the invite fails; every verification flow throws.
- A non-zero `dropped`, or a failed poll, makes matrix-js-sdk retry its undecryptable events. The shim only calls `onEventsDropped` so far.
- The batch time limits are checked on a real phone (slice 6), with suspend in mind: a timer that fires on resume would count a suspended bridge call as stuck and lose a healthy machine.
- A lost machine's to-device events are delivered after a restart from a saved sync token, tested on the emulator with the app's own store (slice 7). The SDK test bed proves only a restart without a token: matrix-js-sdk's persistent store needs IndexedDB, which Node lacks without a new dependency. The reasoning: the IndexedDB store persists the token in `setSyncData`, which runs after a sync is processed, and a lost machine's sync is never processed, so the saved token is the one before it and the server still holds those events.
