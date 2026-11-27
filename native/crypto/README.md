# trinity-crypto

Trinity's native end-to-end encryption for the Android and iOS apps: `matrix-sdk-crypto`
behind one JSON call surface, so the phone apps can run the same crypto as the web app
without WebAssembly. Experimental: nothing in a release build uses it yet.

## Build and test

Needs Rust and cargo (see `rust-version` of the pinned crates; 1.96 or newer).

```sh
cd native/crypto
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```

`cargo build --bin trinity-crypto-cli` builds a host binary that reads one request per line
on stdin and writes one response per line on stdout; a line holding a JSON array is a batch.
The interop and contract tests drive it against the WASM package; see "Interop with WASM"
below.

## Interop with WASM

`pnpm nx run scripts:native-crypto-interop` builds the CLI and runs it as one device against
the repository's `@matrix-org/matrix-sdk-crypto-wasm` as the other, through a small in-test
homeserver: key claims and room keys both ways, encryption both ways, a replayed to-device
message, and the request shapes of each step compared with each other and with
`scripts/native-crypto-interop.golden.json` (update it with `-u` after a deliberate change).
The same target runs `scripts/native-crypto-contract.test.mjs`: each `done` call of the surface
manifest (below) and its WASM counterpart run the same step and must answer the same, by value
(by shape only where the answer is random, such as fresh ciphertext). Room keys exported on one
side import on the other, a backup made on one side restores on the other, and a malformed key
or a tampered backup signature fails the same way on both.
`scripts/native-crypto-trust.test.mjs` does the same for devices, identities and cross-signing:
a native and a WASM observer see the same cross-signed users through the in-test homeserver
(which also takes signing-key and signature uploads) and must give the same trust answers:
another user's unverified device, verification and a later key change (violation, pinning,
withdrawal), pinning a changed identity, local trust and blacklisting, own devices signed by
cross-signing, signatures tampered with, cross-signing bootstrap and key import (also with wrong
keys), tracked users marked dirty and backup info signed by own devices. They also check what
must stay untrusted: a reset of the own identity until it is verified again, a self-signing key
its master key did not sign, a forged user-signing signature, a device signed by another user's
self-signing key, and which devices each `deviceBasedStrategy` shares with.
`scripts/native-crypto-verification.test.mjs` runs each verification flow in every pairing
(WASM with WASM as the reference, native requester with WASM responder, WASM requester with
native responder, native with native) and compares every answer, change event and sent
request of each role with the reference's, step by step: random values (flow and transaction
IDs, keys, MACs) by where they recur, emoji and decimals by shape and by both ends of the flow
showing the same ones. Flows: SAS between two devices of one user (to-device) and between two
users (in a DM), both through to both sides verified; QR codes in mode 0 (another user), 1
(shown by the trusted device) and 2 (shown by the new device); cancels by the requester before
accepting, by the responder, with `m.mismatched_sas`, with `m.user` during SAS, `m.accepted`
on a third own device, `m.unknown_method` for an unknown key agreement (and an unknown start
method ignored), `m.timeout` after a minute without events (this case waits 61 seconds); a
second request for the same user (both are cancelled, on both sides); unknown flows; and a
cancelled flow that is confirmed again before and after a sync collects it. All four suites
share `scripts/native-crypto-harness.mjs`; a case declared with `covered([...entries], …)` fails
unless the answer of each entry's native method reached a comparison with WASM (`expectSame`,
or the homeserver's comparison of the requests it saw); a call made only for setup, or whose
answer is dropped, does not count. Without cargo on `PATH` the suites are skipped and say why;
with `CI` set they fail instead.
CI runs the crate checks and this test in the `Native crypto (Rust)` job when the crate, its
scripts, the WASM version or the CI workflow change.

## The call surface

`call(request_json) -> response_json` runs one request, `call_batch` runs a JSON array of
them in order. The C functions `trinity_crypto_call`, `trinity_crypto_call_batch` and
`trinity_crypto_free` wrap them.

```json
{ "method": "encryptRoomEvent", "userId": "@alice:example.org", "deviceId": "ABC", "params": { … } }
```

The response is `{ "result": … }` or `{ "error": { "code", "message", "details"? } }`. A panic
inside a call comes back as the error code `Panic`; one failing item in a batch does not stop
the others.

Methods, parameter names and result shapes follow the
[matrix-sdk-crypto-wasm](https://github.com/matrix-org/matrix-sdk-crypto-wasm) bindings:

- Parameters use the WASM argument names in camel case. Event JSON stays a JSON string
  where WASM takes or returns a string (`toDeviceEvents`, `content`, `event`, `response`).
- Enums are the WASM enum numbers (`RequestType`, `ShieldColor`, `DecryptionErrorCode` …).
- Outgoing requests are wire-ready: `{ id, type, body, … }` where `body` is the HTTP body as
  a JSON string, exactly as WASM builds it.
- A WASM method that takes `strict` (`shieldState`) is returned for both values:
  `shieldState: { lax, strict }`. `undefined` becomes an absent field.
- A JavaScript callback cannot cross the surface. `exportRoomKeys` takes no predicate and
  exports every key (matrix-js-sdk passes `() => true`); the import calls take no progress
  listener and return when done, with `lastProgress`: the arguments of WASM's last listener
  call (`[progress, total]`, or `[progress, total, failures]` for `importBackedUpRoomKeys`),
  `null` when WASM would not call it, for the shim to replay. `importBackedUpRoomKeys` also
  returns `failures`, the sessions that did not parse. WASM objects passed in travel as their
  serialised form: `saveBackupDecryptionKey` takes `decryptionKeyBase64`,
  `importBackedUpRoomKeys` takes `{ roomId: { sessionId: data } }` for WASM's nested `Map`.
- An invalid backup decryption key fails with code `CryptoError` and a fixed message, where
  WASM's decoder message names a character of the key and its offset. So does an invalid
  private key in `importCrossSigningKeys` (`Error while importing <secret name>: invalid key`).
- Objects with identity are not handles. `getDevice` and `getUserDevices` return `Device`
  snapshots: every getter matrix-js-sdk reads (`userId`, `deviceId`, `displayName` when set,
  `keys` as key ID to base64, `algorithms`, `signatures` as signer to key ID to
  `{ isValid, signature }` or `{ isValid, invalidSignatureSource }`) and the trust answers
  (`isVerified`, `isCrossSigningTrusted`, `isCrossSignedByOwner`, `isLocallyTrusted`,
  `isBlacklisted`, `localTrustState`, `isDeleted`, `isDehydrated`). `getIdentity` returns
  `kind` (`own` or `other`), `isVerified`, `wasPreviouslyVerified`,
  `hasVerificationViolation`, `masterKey` and `selfSigningKey`, plus `userSigningKey` (own)
  or `identityNeedsUserApproval` (other); keys are the JSON strings WASM returns. A snapshot
  is current when returned; ask again after a change. The objects' methods are calls that
  take the object's keys and resolve it again: `setLocalTrust`, `verifyDevice`,
  `encryptToDeviceEvent` (`userId`, `deviceId`) and `verifyIdentity`,
  `withdrawVerification`, `pinCurrentMasterKey` (`userId`). A device or identity the
  machine no longer knows fails with `UnknownDevice` or `UnknownIdentity`.
- Because the keys are only IDs, every call on a device or identity also takes the key the
  host's object was read with, as a WASM object keeps the keys it was made with:
  `ed25519Key` for `setLocalTrust`, `verifyDevice` and `encryptToDeviceEvent` (the snapshot's
  `keys["ed25519:<deviceId>"]`), `masterKey` for `verifyIdentity`, `withdrawVerification` and
  `pinCurrentMasterKey` (the public key in the snapshot's `masterKey` JSON). When the device or
  identity now has another key (a device logged in again under its ID, a reset master key),
  the call fails with `StaleObject`, changes nothing and encrypts nothing. The verification
  calls that start from a device or identity take the same key: `requestDeviceVerification`
  (`ed25519Key`), `requestIdentityVerification` and `verificationRequestContent`
  (`masterKey`). Both are optional so the WASM-shaped
  call still works, but the shim must always pass them, and must build real
  `OwnUserIdentity` / `OtherUserIdentity` instances by `kind`: matrix-js-sdk uses
  `instanceof`.
- Signature uploads that a call returns (`verifyDevice`, `verifyIdentity`,
  `bootstrapCrossSigning`, `confirmSas`) have no `id`, as in WASM: send them, do not mark them
  as sent.

### Verification

`VerificationRequest`, `Sas` and `Qr` are snapshots too, addressed by the other user's ID and
the flow ID (`userId`, `flowId`); each call resolves the object from the machine again.

- Reading: `getVerificationRequest` and `getVerificationRequests` (sorted by flow ID) return
  request snapshots: `kind: "request"`, `ownUserId`, `otherUserId`, `otherDeviceId`, `roomId`,
  `flowId`, `phase` (WASM `VerificationRequestPhase`), `isPassive`, `isReady`, `isDone`,
  `isCancelled`, `isSelfVerification`, `weStarted`, `timedOut`, `theirSupportedMethods` and
  `ourSupportedMethods` (WASM `VerificationMethod`), `cancelInfo` (`{ cancelCode, reason,
cancelledbyUs }`, the code as a string), `expiresAtMs` (milliseconds since the epoch:
  `timeRemainingMillis` is `max(0, expiresAtMs - Date.now())`) and, while the phase is
  Transitioned, `verification`: what `getVerification` returns. `getVerification` returns a
  `Sas` (`kind: "sas"`, the WASM getters, with `emoji`, `emojiIndex` and `decimals` once they
  can be shown) or `Qr` (`kind: "qr"`, `state` as WASM `QrState`, `hasBeenScanned`,
  `hasBeenConfirmed`, `reciprocated` and the rest) snapshot. A method WASM's getters do not
  know is left out of `theirSupportedMethods`, where WASM's getter throws.
- Starting: `requestDeviceVerification` (`userId`, `deviceId`, `methods`, `ed25519Key`) and,
  for the own identity, `requestIdentityVerification` (`userId`, `methods`, `masterKey`) return
  `[request, toDeviceRequest]` as WASM's tuple; for another user `requestIdentityVerification`
  also takes `roomId` and `requestEventId` (the DM event sent with the content of
  `verificationRequestContent`) and returns the request. `receiveVerificationEvent` takes an
  in-room event (`event` as a JSON string, `roomId`).
- Acting: `acceptVerificationRequest` (`methods`, or WASM's `accept()` when absent),
  `cancelVerificationRequest`, `startSas` (`[sas, request]`), `generateQrCode`, `scanQrCode`
  (`data`: the scanned bytes, base64), `acceptSas`, `confirmSas` (a list, with a signature
  upload without an `id` last), `cancelSas` and `cancelQr` (`code`, or `m.user` when absent),
  `confirmQrScanning`, `reciprocateQr`. Each returns what WASM returns: the outgoing request
  wire-ready (a to-device or a room message request, as the flow is), or `null`.
- `qrCodeBytes` returns the QR code's bytes, base64. They hold the flow's shared secret, so they
  are in no snapshot and no event; nothing else leaves (WASM shows only emoji, decimals and
  these bytes).
- A flow the machine does not know (never seen, or collected by a sync after it was done or
  cancelled), or a call for the other kind (a QR call on a flow that is now SAS), fails with
  `UnknownVerification` and changes nothing. WASM's object would still answer after a
  collection; a cancelled flow that is still known answers as in WASM (no request, nothing
  verified). `confirmSas` takes the `decimals` the host showed: when the SAS on that flow now
  shows others (another flow reusing the ID), it fails with `StaleObject` before anything is
  confirmed. The shim must always pass them.
- Changes become events: `verificationRequestChanged` (`request`: the full request snapshot,
  with its `verification`) and `verificationChanged` (`verification`: the full `Sas` or `Qr`
  snapshot), one per call that changed the object, as WASM calls `registerChangesCallback`'s
  callback once per change it sees. The crate watches each object (its upstream change stream)
  from the first answer that hands it to the host, once per object, and stops when it is done
  or cancelled; an object that already is is not watched. When a request changes, the `Sas` or
  `Qr` it now holds is watched afresh, as matrix-js-sdk re-subscribes when a flow switches from
  QR to SAS. `init` (also after a panic) drops the watches: verifications live in the machine's
  memory only, so a reloaded machine has none.

### Events

What WASM reports through `registerRoomKeyUpdatedCallback` and its siblings is queued per
device and read with `pollEvents` (no parameters), which answers
`{ "events": [ … ], "dropped": n }` and empties the queue. Each event is
`{ "type", … }` with one callback invocation's payload: `roomKeysReceived` and
`roomKeysWithheld` carry `keys`, the WASM `RoomKeyInfo` and `RoomKeyWithheldInfo` fields;
`userIdentityUpdated` carries `userId` (one event per new or changed identity, as WASM calls its
callback per user); `devicesUpdated` carries `userIds`, sorted, once per store change (an empty
list when only identities changed, as in WASM). Verification events are described under
"Verification" above. The secrets callback becomes an event type of its own when its calls
land; `surface.json` names it.

- Every call moves the events it caused into the queue before it returns, so a poll right
  after a call sees them. Each event is delivered once; events of one type keep their order
  (WASM's separate callbacks give no order across types either).
- `pollEvents` never waits for a call in flight. The queue has its own lock, held only while
  events move: a call takes it while holding its machine lock, `pollEvents` takes it holding
  none, and nothing waits for another lock while holding it. It is released before the host
  reads the response.
- The queue keeps 1024 events. When the host falls behind, later events are not queued and
  `dropped` counts them (and any batch the store's broadcast channel skipped). A non-zero
  `dropped` means the host's view is stale: for room keys, retry every undecryptable event.
- After a panic drops the machine, `pollEvents` still returns what it queued, and `init`
  listens to the reloaded machine. `close` discards the queue: poll before closing.
- Not every loss can be counted: the store drops a withheld batch, or an identity and device
  change, its broadcast channel skipped without saying so. Those channels hold 16 and 32
  changes and every call drains them, so only a single call that stores more could lose one.

### Surface manifest

`surface.json` lists every WASM class and member the installed matrix-js-sdk uses, generated
from its sources by `scripts/native-crypto-surface.mjs` (TypeScript's checker; the WASM
`.d.ts` and `declare module` augmentations). Members of stateful classes carry `status`
(`done`: answered by the `native` call; `planned`; `shim`: answered in JavaScript, with a
`note`), an `area`, and for callbacks the `event` type. `wasmHelpers` are stateless helpers that
keep running on WASM; `pureJs` are value types the shim implements, and `shimNotes` says what
the shim must do for one of them or a helper where that is not obvious (such as mapping
`CollectStrategy.deviceBasedStrategy` onto the crate's strategy names). `node
scripts/native-crypto-surface.mjs write` regenerates the lists and keeps the hand-written
fields; `scripts/native-crypto-surface.spec.mjs`, part of `pnpm nx test scripts`, fails when the
manifest and matrix-js-sdk disagree or a `done` member has no contract case.

`init` opens the store and creates or loads the account. With `storePath` it opens a SQLite
store with `storeKey`, a raw 32-byte key in base64 (never a passphrase); without either the
store is in memory. One machine exists per user and device for the whole process; calls for it
run one at a time. `init` again with the same store returns the open machine, with another
store it fails with `AlreadyOpen`. `close` waits for a call in flight, then drops the machine;
calls queued behind it get `UnknownMachine`. Two device IDs must never share one store path:
the crate does not stop them, and their machines would overwrite each other's account. A call
that panics drops its machine too, so the next call needs `init`, which reloads the account
from the store.

The crate wipes its own copies of the key, but it cannot wipe the request string, the serde
buffers the key passed through on the way in, or on Android the JVM's own string and the
buffer the JVM hands to native code. Pass the key only in `init`, and drop the
caller's copies as soon as `init` returns.

The backup decryption key is no better off: the crate wipes its own base64 copy in
`saveBackupDecryptionKey`, but not the request string or serde's buffers, and the base64 that
`getBackupKeys` returns stays in the response string, as it does in WASM's `BackupKeys`.

Private cross-signing keys leave the crate only through `exportCrossSigningKeys` (WASM's
`CrossSigningKeyExport` getters, `self_signing_key` in snake case as there), never in events or
errors. The upstream export type wipes itself; the keys in the response string and those passed
to `importCrossSigningKeys` in the request string are not wiped.

## For the JNI wrapper

- Java strings are modified UTF-8, not plain UTF-8. `src/jni.rs` (cargo feature `jni`) reads
  the JVM's bytes with `JString::mutf8_chars` (jni 0.22's replacement for the deprecated
  `get_string`) and decodes them strictly: invalid input fails the request with
  `InvalidRequest` instead of being replaced. When decoding had to convert, the converted copy
  is wiped after the call.
- Never build with `panic = "abort"`: panics are caught and returned as `Panic` errors only
  while panics unwind.
- Call from a background thread: a call blocks its thread until it is done, and must never
  run on a thread of the crate's own runtime.
- Events are polled with `pollEvents` after a call returns (see "Events"); the crate never
  calls into the JVM.

## Android (debug builds only)

`native/crypto/build-android.sh [abi …]` (default `x86_64`, the emulator) cross-builds
`libtrinity_crypto.so` with the `jni` feature into `android/app/src/debug/jniLibs/`, which git
ignores. It needs an Android NDK (the Android Gradle Plugin's default, 28.2.13676358, through
`sdkmanager`), `rustup target add x86_64-linux-android` (one target per ABI) and
`cargo install cargo-ndk`.

Debug builds then have the Capacitor plugin `TrinityCryptoDebug`: `call({ request })` and
`callBatch({ requests })` take the JSON strings above and resolve `{ response, nativeMs }`.
Calls run one at a time on one background thread; an error in the native call (for example a
stale library without a method) rejects the call with `NATIVE_ERROR`. A debug-only
`Application` registers the plugin, so `MainActivity` never names it. Registration needs
Android 10 (API 29): on API 24 to 28 debug builds have no plugin, and JS gets Capacitor's "not
implemented" error. The `secondaryDebug` build type does not use `src/debug`, so it has no
plugin either. Without the library the plugin rejects with `NOT_BUILT`; `pnpm android:build`
and the mobile E2E suite need neither Rust nor the NDK. Release builds hold neither the plugin
nor the library: `pnpm android:build:release` checks the bundle with
`scripts/android-release-isolation.mjs`.

## The pin rule

`matrix-sdk-crypto`, `matrix-sdk-common` and `matrix-sdk-sqlite` are pinned exactly (`=`) to
the release that `@matrix-org/matrix-sdk-crypto-wasm` in the root `package.json` is built on,
so the web and phone apps run the same crypto. `Cargo.lock` started from the WASM release's
own lock file, so every crate both use has the same version. Bump the WASM package and these
pins together: `[package.metadata.trinity.wasm-pin]` in `Cargo.toml` records the pairing,
`wasm-lock.json` is a snapshot of that release's `Cargo.lock`, and
`node scripts/native-crypto-pin.mjs` (also part of `pnpm nx test scripts`) fails when
`package.json`, the pins or `Cargo.lock` disagree with the pairing, or when a crate in both
lock files has another version here than in the snapshot. On a WASM bump, refresh the snapshot
with the commands at the top of that script, then move the pins and the lock to match.
Renovate leaves this crate and its lock file alone until it ships in a release build.

## Licence

Most of `src/` is ported from matrix-sdk-crypto-wasm, which is Apache-2.0; this crate is
therefore Apache-2.0 as a whole (`LICENSE-APACHE`). Each ported file names its source.
