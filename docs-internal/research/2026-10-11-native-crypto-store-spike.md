---
status: awaiting owner decision
issue: https://github.com/quwisky/trinity-matrix-client/issues/1153
---

# Spike: a crypto store the mobile notification code can use

Research for [#1153](https://github.com/quwisky/trinity-matrix-client/issues/1153), which
enables [#1154](https://github.com/quwisky/trinity-matrix-client/issues/1154): showing the
decrypted text of encrypted messages in closed-app notifications on iOS and Android. No
production code was written. Facts checked against source are linked under
[Sources](#sources); estimates and unverified points are marked as such.

## Summary

The native-engine plan in #1153 is feasible but much larger than a shim. matrix-js-sdk has
no seam for a different `OlmMachine`. Part of the API it uses is synchronous and stateful,
which an asynchronous Capacitor bridge cannot serve. The uniffi crypto bindings lack
several features that matrix-js-sdk 43 uses. They also lack the cross-process lock that
iOS needs to let the app and the Notification Service Extension (NSE) share one store
safely.

The recommendation is a **room-key handoff**. The app copies Megolm room keys, as it
receives them, into a native decrypt-only store. The notification code decrypts with that
store and never processes to-device messages, so one Matrix device keeps exactly one Olm
engine. This decrypts pushes for every message whose room key the app has already
received. A push whose key arrived while the app was not running keeps today's
"Encrypted message" text. The native engine stays the fallback if the measured gap is too
large (owner decisions 1 and 2).

## Context and problem

- Push is device-rendered since [#1157](https://github.com/quwisky/trinity-matrix-client/pull/1157):
  pushers send `event_id_only`, and native code fetches the event with the access token from
  the push handoff store. On Android this is `TrinityMessagingService`. On iOS it is the
  `NotificationService` extension, which uses `TrinityPush`. For an `m.room.encrypted`
  event the text is "Encrypted message"
  ([push reference](../maintenance/push-notifications.md#render-pushes-on-the-device)).
- The app's crypto runs inside the WebView. `MatrixClientService` calls
  `initRustCrypto({ cryptoDatabasePrefix, storageKey })`
  ([source](../../libs/data-access/matrix-client/src/lib/matrix-client.service.ts)).
  matrix-js-sdk 43.0.0 then opens a `@matrix-org/matrix-sdk-crypto-wasm` 18.9.0
  `OlmMachine` on an IndexedDB store named `${prefix}::matrix-sdk-crypto`. The store is
  encrypted with a per-store 32-byte key held in the keychain or Keystore
  ([encryption and trust](../../apps/docs-developers/src/content/docs/architecture/encryption-and-trust.md#crypto-storage)).
- The WASM store can only be IndexedDB or memory. `StoreHandle.open` and `openWithKey`
  take an IndexedDB name or nothing (installed `matrix_sdk_crypto_wasm.d.ts`).
- Native notification code cannot use that store:
  - On iOS, WebKit keeps IndexedDB in the app's own data container, in WebKit's internal
    format. The NSE is a separate process with its own container. It shares only the
    app group `group.dev.trinityproject.trinity` and the keychain group
    `dev.trinityproject.trinity.shared` with the app.
  - On Android, the messaging service runs in the app process, but Chromium owns the
    LevelDB-backed IndexedDB files. No native API reads them, and opening them outside
    the WebView would race the WebView's own connection.
  - Neither platform offers a supported interface to this store. The format is private
    to the browser engine and the WASM store encryption.
- Owner context on #1153: approach B (the Element X model) was chosen, and there are no
  existing mobile users (2026-10-10), so no mobile store needs migrating.
  [ADR 0002](../decisions/0002-matrix-sdk-authoritative-state.md) keeps the SDK
  authoritative for encryption state. [ADR 0005](../decisions/0005-operation-based-host-capabilities.md)
  keeps native access behind narrow operations.

## Constraints

### Platform

| Constraint             | iOS (NSE)                                                                                                                                                                                                                                                                                             | Android (`TrinityMessagingService`)                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process                | Separate process from the app; both can run at once                                                                                                                                                                                                                                                   | The app process; the WebView may or may not be alive                                                                                                                                        |
| Time                   | About 30 s before `serviceExtensionTimeWillExpire` ([Apple](https://developer.apple.com/documentation/usernotifications/unnotificationserviceextension))                                                                                                                                              | `onMessageReceived` has a short window; Firebase's sample says to finish within 10 s ([Firebase](https://firebase.google.com/docs/cloud-messaging/android/receive-messages))                |
| Trinity's budget today | 5 s for all reads                                                                                                                                                                                                                                                                                     | 5 s, with a watchdog                                                                                                                                                                        |
| Memory                 | 24 MB, from Apple DTS forum replies, not documented ([forum](https://developer.apple.com/forums/thread/64634), [forum](https://developer.apple.com/forums/thread/722879))                                                                                                                             | Normal app process                                                                                                                                                                          |
| Delivery policy        | `mutable-content` alert; the NSE must call the content handler                                                                                                                                                                                                                                        | A data-only high-priority message that does not lead to a visible notification can be deprioritized ([Firebase](https://firebase.google.com/docs/cloud-messaging/android-message-priority)) |
| Shared storage         | App group container and shared keychain group. A SQLite lock held by a suspended app in the app group gets the app killed with `0xdead10cc` ([forum](https://developer.apple.com/forums/thread/655225), [summary](https://mjtsai.com/blog/2025/05/15/sqlite-databases-in-app-group-containers-dont/)) | App-private files and the Android Keystore                                                                                                                                                  |
| Locked device          | The store and its key must be readable after first unlock: `NSFileProtectionCompleteUntilFirstUserAuthentication` and `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`                                                                                                                              | Keystore keys without `setUnlockedDeviceRequired`                                                                                                                                           |

### Protocol

- **To-device messages are consumed once per device.** The server deletes them when the
  client next syncs with the returned `next_batch`
  ([spec v1.19, send-to-device](https://spec.matrix.org/v1.19/client-server-api/#send-to-device-messaging)).
  Room keys reach a device this way, as `m.room_key` inside Olm-encrypted messages. If
  notification code syncs and acknowledges to-device messages, the app never sees them.
- **One device has one Olm account.** Its one-time keys, Olm sessions and
  device-list tracking are mutable state that must have a single writer. Two engines
  for one device corrupt it (see [One device, one engine](#one-device-one-engine)).
- **Megolm sessions are long-lived.** A sender reuses one outbound session per room until
  rotation. The `m.room.encryption` defaults are 100 messages or one week, and clients also
  rotate when membership changes. A room key the app already holds therefore usually
  decrypts later messages in the same session.

### Repository

- Components never import `matrix-js-sdk`, and SDK access stays in data-access services
  ([AGENTS.md](../../AGENTS.md#runtime-constraints)). A crypto change sits in
  `data-access/matrix-client`, `util/matrix` and a native plugin, not in features.
- matrix-js-sdk is already patched with pnpm (`patches/matrix-js-sdk@43.0.0.patch`, nine
  files), so a small, upstreamable patch is an accepted pattern.
- The push handoff store never holds crypto keys today. This was an explicit #1155 owner
  decision that any option here revises.

## Findings on the #1153 spike questions

### Does matrix-js-sdk accept an injected `OlmMachine`?

No. `initRustCrypto` in `src/rust-crypto/index.ts` imports the WASM module as a namespace.
It opens `StoreHandle` and calls `RustSdkCryptoJs.OlmMachine.initFromStore(...)` directly,
then constructs the internal `RustCrypto` class. `MatrixClient.initRustCrypto` assigns the
result to `cryptoBackend`. Injection needs one of two things:

- a pnpm patch to `rust-crypto/index.ts` (and wherever objects are constructed), or
- a build alias that replaces `@matrix-org/matrix-sdk-crypto-wasm` with a shim module in
  mobile builds. It is unverified whether the Angular application builder can alias a
  bare import that comes from inside `node_modules`.

Either way, the shim must stand in for the whole WASM surface that matrix-js-sdk
reaches, not only `OlmMachine`. That is about 60 `OlmMachine` members and about 50
other WASM classes: `UserId`, `RoomId`, `Device`, `OwnUserIdentity`, `VerificationRequest`,
`Sas`, `Qr`, `BackupDecryptionKey`, request types, enums, and others. It also includes
the rendezvous (QR sign-in) code.

**Synchronous, stateful calls are the main obstacle.** All Capacitor plugin methods are
asynchronous ([Capacitor](https://capacitorjs.com/docs/plugins/method-types)). The WASM
API that `RustCrypto` relies on includes synchronous calls, several of which mutate state:

- `OlmMachine`: `getVerificationRequest`, `getVerificationRequests`, `getVerification`,
  `queryKeysForUsers` and `dehydratedDevices()`, and the getters `userId`, `deviceId`,
  `identityKeys`, `deviceCreationTimeMs`, `roomKeyRequestsEnabled`;
- `VerificationRequest`: `accept`, `acceptWithMethods`, `cancel`, `phase`, `isDone` and
  similar;
- `Sas`: `accept`, `cancel`, `emoji`, `decimals` and similar;
- `Device`: `isVerified`, `isCrossSigningTrusted`, `requestVerification` and similar.

Three ways around this, each with a cost:

- **Synchronous bridge.** Android `@JavascriptInterface` is synchronous. On iOS the only
  route is the `prompt()` interception that Capacitor itself uses for cookies
  (`WebViewDelegationHandler.swift`). Both block the WebView's main thread.
- **Mirrored snapshots.** Objects mirror native state and are refreshed by events. This
  risks stale reads in verification flows.
- **A patched `rust-crypto` layer that awaits.** This is a large patch, about 7,400 lines
  in scope, to carry across every SDK upgrade.

### Is a uniffi crypto-only artifact current for both platforms?

The source, `bindings/matrix-sdk-crypto-ffi`, is maintained: its last commit was on
2026-09-24. Releases are sparse:

- Android `org.matrix.rustcomponents:crypto-android` 26.05.12, released 2026-05-12. The AAR
  is 25 MB across all ABIs.
- iOS `MatrixSDKCryptoFFI` 0.17.0, released 2026-05-26. The zipped xcframework is 150 MB
  with all slices.

The WASM package that web uses ships far more often: 18.6.0 to 18.9.0 came out between
2026-08-25 and 2026-09-21. Web and mobile would therefore run different
`matrix-sdk-crypto` versions most of the time.

The FFI API is narrower than the WASM API that matrix-js-sdk 43 drives. In
`machine.rs` it has no:

- room-key bundles (MSC4268: `shareRoomKeyBundleData`, `receiveRoomKeyBundle` and the
  pending-bundle calls, which `RustCrypto` uses for history sharing on invite);
- `encryptStateEvent`;
- secret inbox (`getSecretsFromInbox`/`deleteSecretsFromInbox`, used for gossiped backup
  keys);
- room-key-updated or withheld callbacks outside `receive_sync_changes`;
- cross-process lock.

Every FFI method blocks on its own Tokio runtime, so plugin calls must leave the main
thread.

The cross-process lock and store-generation counter exist only in the full `matrix-sdk`
client (`Encryption::enable_cross_process_store_lock`), which reloads the `OlmMachine` when
another process has written. Element X depends on this for its NSE. Through crypto-ffi,
Trinity would have to add these APIs upstream or build and ship its own bindings, which
means a Rust cross-compilation toolchain in CI for both platforms.

### What does the bridge cost per call?

Not measured. A device was outside this spike, and the [next experiment](#open-technical-questions-and-next-experiment)
lists the measurement. Capacitor sends each call as a JSON message:
`postMessage(String jsonStr)` on Android, `WKScriptMessageHandler` on iOS. Each
`decryptRoomEvent` would therefore serialize the event in and the cleartext and encryption
info out, and timeline backfill and search decrypt hundreds of events at a time. Binary
values such as backup keys and attachments must be encoded for the bridge.

## One device, one engine

Every option that runs a second Olm engine for the user's existing device, with its own
store or a copy, fails for the same reasons:

- **One-time keys.** Each engine generates, uploads and forgets one-time keys on its own.
  A peer claims a key that the other engine owns or has dropped, and its Olm pre-key
  message can't be decrypted. matrix-rust-sdk [#1415](https://github.com/matrix-org/matrix-rust-sdk/issues/1415)
  ("Lost OTK ... later UTDs") records exactly this from unsafe concurrent store access.
- **Olm ratchets fork.** When either engine sends an Olm message (a key share, a
  verification step, a secret) it advances its copy of the session. The peer receives
  messages from two forks of one session, and later room keys sent over it fail.
- **Room keys split.** Whichever engine acknowledges a to-device batch consumes it. The
  other engine never receives those room keys, which is a guaranteed UTD.
- **Trust state diverges.** Device lists, cross-signing state and verification results
  drift apart and must be merged by hand.

Keeping two engines in sync would amount to replicating the Olm account and every session
between processes. The legacy Element iOS SDK came closest. Its NSE opened the main app's
crypto-ffi store and created a fresh `OlmMachine` for every background operation, because
the machine "is not fully multi-thread and multi-process safe"
([`MXBackgroundCryptoV2.swift`](https://github.com/matrix-org/matrix-ios-sdk/blob/develop/MatrixSDK/Background/Crypto/MXBackgroundCryptoV2.swift)).
Element X replaced that with the cross-process lock. Two engines for one device are
rejected below. A decrypt-only store that never touches Olm state (option 3) is not a
second engine in this sense.

## What other clients do

- **Element X iOS** runs the full `matrix-sdk-ffi` client in the NSE. It uses
  `notificationClient(processSetup: .multipleProcesses)` and a
  `crossProcessLockConfig(.multiProcess(holderName: bundleID))`, with the SQLite stores in
  the app group container
  ([`NSEUserSession.swift`](https://github.com/element-hq/element-x-ios/blob/develop/NSE/Sources/NSEUserSession.swift),
  [`ClientFactory.swift`](https://github.com/element-hq/element-x-ios/blob/develop/ElementX/Sources/Services/Client/ClientFactory.swift),
  [`URL.swift`](https://github.com/element-hq/element-x-ios/blob/develop/ElementX/Sources/Other/Extensions/URL.swift)).
  When an event cannot be decrypted, the NSE runs short encryption-sync iterations (MSC4186
  sliding sync, to-device extension) under the lock until it decrypts or a deadline passes
  ([`notification_client.rs`](https://github.com/matrix-org/matrix-rust-sdk/blob/main/crates/matrix-sdk-ui/src/notification_client.rs)).
  The app and the NSE share one device, one store and one sync position. That works
  because both run the same Rust SDK.
- **Element X Android** uses `NotificationProcessSetup.SingleProcess(syncService)`: the push
  wakes the app process, which owns the only engine
  ([`RustMatrixClient.kt`](https://github.com/element-hq/element-x-android/blob/develop/libraries/matrix/impl/src/main/kotlin/io/element/android/libraries/matrix/impl/RustMatrixClient.kt)).
- **Legacy Element iOS** shared the crypto-ffi store across processes, as described above,
  and its maintainers recorded the safety problem.
- Other clients (FluffyChat, Element Web) were not checked for this spike.

## Options

### Option 1: native crypto engine behind the WebView (#1153 as written)

matrix-js-sdk's `RustCrypto` drives a native `OlmMachine` (crypto-ffi, SQLite) through a
Capacitor plugin and a WASM-compatible shim. The notification code opens the same store.
This covers both (a) and (c) from the spike brief: the WebView can't open SQLite, so "the
app uses the same store" always means the app calls into native crypto. The variants
differ only in where the seam sits:

- **1a, the `OlmMachine` seam.** A shim for the WASM classes, as #1153 proposes.
- **1b, the `CryptoBackend` seam.** A Trinity `CryptoBackend` written over native calls,
  which replaces `RustCrypto` through a patch. It avoids mimicking WASM objects, but it
  reimplements roughly 7,400 lines of SDK logic.

On iOS, a push for a key the app has not seen needs the NSE to fetch to-device messages
under a cross-process lock, as Element X does. The NSE would also have to pass on, or
queue, any non-key to-device events the app needs, because once the NSE has acknowledged
them the app never receives them. The app syncs with `/v3/sync` in matrix-js-sdk, so the
two processes do not share a sync position as they do in Element X. Android needs no lock:
the messaging service and the WebView plugin can share one in-process `OlmMachine`.

### Option 2: two engines with synchronization

The WebView keeps WASM and IndexedDB, and native code runs its own engine for the same
device, with state copied between them. Rejected: see [One device, one engine](#one-device-one-engine).

### Option 3: room-key handoff to a decrypt-only native store (recommended)

The app keeps WASM crypto unchanged. Whenever `OlmMachine` reports new or updated room
keys, Trinity exports those sessions and hands them to native code through a new
`PushHandoff` operation. Sources of these keys include to-device, forwarded keys, backup
restore, import and key bundles. Native code imports them into a per-account,
decrypt-only store, and the renderers decrypt with it.

- **Export.** It requires a small matrix-js-sdk patch, because `RustCrypto.onRoomKeysUpdated`
  is internal and the public `exportRoomKeys()` exports every session. The patch emits
  the `RoomKeyInfo` batch and exports by `(roomId, sessionId)` through the existing
  `olmMachine.exportRoomKeys(predicate)`. A first run exports the existing sessions in
  chunks.
- **Native store.** A crypto-ffi `OlmMachine` opened under a local-only pseudo device ID,
  so nothing it could ever upload can collide with the real device, takes the keys
  through `import_decrypted_room_keys` and decrypts through `decrypt_room_event`. It never
  calls `outgoing_requests` or `receive_sync_changes`, so it has no Olm sessions and
  never syncs. No official Swift or Kotlin vodozemac bindings exist
  ([vodozemac-bindings](https://github.com/matrix-org/vodozemac-bindings) covers C++, JavaScript and
  Python), and hand-written Megolm code is not proposed.
- **iOS write path.** To keep SQLite out of two processes, the app appends exported keys
  to an encrypted inbox file in the app group, in short writes under
  `beginBackgroundTask`. Only the NSE opens the SQLite store, importing the inbox before
  it decrypts. The app deletes both on sign-out. On Android the plugin imports directly
  into a store owned by one process.
- **Rendering.** Decryption is local CPU work with no extra network request, so it fits
  the existing 5 s budget. The shared text-rule fixture gains decrypted cases. A missing
  key, or any failure, keeps "Encrypted message".
- **The gap.** A push for a Megolm session that reached the device while the app was not
  running can't be decrypted: the key is still in the to-device inbox, which only the app
  consumes. This happens for a new conversation, a rotated session, or a sender's new
  device, and lasts until the app next syncs.
- **Optional key-backup fallback (3+).** The NSE fetches the missing session from
  server-side key backup (`GET /room_keys/keys/{roomId}/{sessionId}`). This needs the
  backup decryption key in the native store, which also decrypts the account's whole
  backed-up history. It only helps when another of the user's devices received and backed
  up that key; a user with one device gains nothing.

### Option 4: a dedicated notification device

The app signs in a second Matrix device for each account, used only by native code. The
app cross-signs it, and it syncs its own to-device inbox when a push arrives. This gives
it its own engine and its own inbox, so no state is shared. The costs:

- Every contact sees an extra device per installation.
- Every sender shares keys with it as well.
- The app needs a second access token: a login token through
  `POST /login/get_token`, which needs user-interactive authentication, or an equivalent
  OAuth flow.
- Clean-up must stop dead notification devices from accumulating.
- To avoid "unverified device" warnings for contacts, the app needs the self-signing key.

No client was found doing this.

### Option 5: the full Rust SDK on mobile (Element X wholesale)

Replace matrix-js-sdk on mobile with `matrix-sdk-ffi` for sync, timeline and crypto.
Rejected as out of scope. It would split the product into two SDKs and contradict the
single-SDK ownership that ADR 0002 and the data-access boundaries rest on.

### Option 6: notification code reaching the WebView store

Run a headless WebView or JavaScript engine in the notification code against the app's
IndexedDB. Rejected:

- An iOS extension cannot reach the app's WebKit data store.
- On Android, a second JavaScript context on the same origin is a second engine on the
  same store: the same problem that makes web Matrix clients refuse a second tab.

### Trade-offs

| Option                      | Closed-app decryption                                               | Engines per device               | Effort                                           | Notification-code fit                                  | Security at rest                                                                  | Upstream dependence                                           |
| --------------------------- | ------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1a native engine, WASM shim | Complete if the NSE may sync to-device under a lock; otherwise as 3 | One, if the lock is added on iOS | XL, plus Rust work for the lock and missing APIs | Full engine in the NSE; memory and KDF cost unmeasured | The whole Olm account and every key in the app group, readable after first unlock | High: crypto-ffi gaps, release lag behind WASM                |
| 1b native `CryptoBackend`   | As 1a                                                               | As 1a                            | XL+                                              | As 1a                                                  | As 1a                                                                             | High, plus reimplementing `RustCrypto`                        |
| 2 two engines               | Partial and unsafe                                                  | Two                              | L                                                | Engine in the NSE                                      | Two copies of the Olm account                                                     | Low                                                           |
| 3 room-key handoff          | Every session the app has received; the rest falls back             | One (decrypt-only native store)  | M                                                | Local decryption only, no sync; NSE alone opens SQLite | Megolm session keys only; no Olm account, cross-signing or backup key             | Low: stable `import_decrypted_room_keys`/`decrypt_room_event` |
| 3+ with key-backup fallback | Adds sessions another own device backed up                          | One                              | M + S                                            | One extra authenticated read per miss                  | Adds the backup decryption key, which opens all backed-up history                 | Low                                                           |
| 4 notification device       | Complete for keys shared after it joined                            | One per device, two devices      | L                                                | Engine and to-device sync in the NSE                   | Second device credentials and Olm account                                         | Medium                                                        |
| 5 Rust SDK everywhere       | Complete                                                            | One                              | XXL                                              | As Element X                                           | As Element X                                                                      | High                                                          |
| 6 headless WebView          | Not possible on iOS                                                 | Two on Android                   | -                                                | -                                                      | -                                                                                 | -                                                             |

What changes where:

- **Option 1** touches `patches/` (a large matrix-js-sdk patch), `util/matrix` (the WASM
  loader and the shim), `data-access/matrix-client` (start-up, store keys and clean-up),
  `platform-native`, a new native crypto plugin of about 60 methods plus object handles
  and callbacks in Kotlin and Swift, the NSE, and the iOS and Android builds. It also
  needs the mobile encrypted-messaging, verification and backup journeys rerun on the
  native backend.
- **Option 3** touches a small patch, a room-key exporter in `data-access/matrix-client`
  (or `data-access/notifications`, next to `PushHandoffService`), new `PushHandoff`
  operations (`addRoomKeys` and per-account removal), `TrinityPush` and the Android push
  package (store and decryption), the shared fixture, the push reference and the
  encryption guide.

Sizes are rough team-relative estimates, not measurements.

### Migration

None is needed for any option while there are no mobile users (owner, 2026-10-10). Should
that change before an option ships:

- **Option 3** migrates itself: the first run exports the existing sessions.
- **Option 1** cannot move an existing IndexedDB device. The WASM API exports room keys,
  cross-signing keys and a secrets bundle, but not the Olm account or Olm sessions, and
  crypto-ffi's migration helpers accept only libolm pickles. Existing users would sign in
  again as a new device and restore from key backup, reverifying that device.

## Recommendation

Adopt **option 3, the room-key handoff**, as the next step in place of the native-engine
rewrite. Keep option 1 as a later, measured decision.

Reasons:

- It meets #1154's goal for most messages: ongoing conversations reuse sessions the app
  already holds.
- It never risks the Olm corruption and UTDs that the native engine guards against with
  a lock crypto-ffi does not have.
- It leaves web, desktop and mobile on one crypto implementation, with nothing to keep in
  step between WASM and FFI releases.
- The notification code gets the smallest key set that does the job. The Olm account,
  the cross-signing keys and the backup key never leave the WASM store.

Phased path:

1. **Experiment (S).** The [next experiment](#open-technical-questions-and-next-experiment)
   below, on a real iPhone and Android phone. Its outcome confirms or rejects crypto-ffi as
   the decrypt-only store.
2. **Room-key handoff (M).** Rewrite #1153's body for option 3, and fold its delivery into
   #1154: matrix-js-sdk patch, exporter, `PushHandoff` operations, native stores,
   decryption in both renderers, fixture cases, sign-out and clear-all-data removal, docs.
   On-device checks: an encrypted DM pushed with the app closed after the key was seen,
   a first message in a new session (fallback expected), sign-out removal and a
   locked-phone render.
3. **Measure the gap (S).** Run scripted on-device scenarios (new DM, weekly rotation,
   new sender device, the app closed for a day) and record how often pushes fall back.
   The owner decides from that whether 3+ or option 1 is warranted.
4. **Only if needed (XL).** Option 1, once crypto-ffi offers the cross-process lock and
   the missing APIs upstream, or once the owner accepts maintaining Trinity's own uniffi
   bindings.

## Owner decisions needed

1. Replace #1153's native-engine plan with the room-key handoff (option 3), and treat
   option 1 as a possible later step? (yes / no)
2. Accept that a push whose room key arrived while the app was not running shows
   "Encrypted message" until the app next syncs? (yes / no; "no" means option 1 or 4)
3. Revise the #1155 rule "the handoff store never holds crypto keys" to allow Megolm room
   keys, and only those, in a separate native store? (yes / no)
4. Add the key-backup fallback (3+), which puts the backup decryption key in storage the
   notification code can read? (yes / no; recommended: no for now)
5. Which room keys to hand off: all sessions, or only sessions for rooms whose
   notifications are not muted, pruned after N days without use? (all / unmuted plus N)
6. Keep encrypted pushes decryptable while the phone is locked after first unlock? This
   is required for lock-screen text. It means `AfterFirstUnlockThisDeviceOnly` and
   `CompleteUntilFirstUserAuthentication` on iOS, and no unlocked-device requirement on
   Android. (yes / no; "no" decrypts only while unlocked)
7. Accept adding crypto-ffi to the app and the NSE, at a size per installation still to be
   measured (the Android AAR is 25 MB across all ABIs)? (yes / no)
8. Carry a matrix-js-sdk patch for the room-key event and selective export, and offer it
   upstream? (yes / no)
9. Ship Android and iOS together, or Android first? Android has no cross-process concern.
   (together / Android first)

## Open technical questions and next experiment

The next experiment is a throwaway branch with a Kotlin and a Swift harness, plus a debug
build of the app that exports keys. On a real iPhone (NSE) and a real Android phone:

- **Decrypt-only store.** Does a crypto-ffi `OlmMachine` under a pseudo device ID decrypt
  a real event from `import_decrypted_room_keys` data alone, without the sender's device
  keys? What verification state does it report, and does creating it write anything that
  needs suppressing?
- **NSE cost.** Peak memory and cold-start time in the NSE with `MatrixSDKCryptoFFI`
  loaded, including the store open. `SqliteCryptoStore::open` with a passphrase runs
  PBKDF2 with 200,000 rounds in `matrix-sdk-store-encryption`. Can the FFI take a
  high-entropy key instead, as Element X does through the full SDK?
- **Callback coverage.** Does `registerRoomKeyUpdatedCallback` fire for every source of a
  room key: to-device, forwarded keys, backup restore, file import and MSC4268 bundles?
- **Export cost.** `exportRoomKeys(predicate)` visits every stored session. Measure the
  latency and bridge payload for a first export of 10,000 sessions and for a typical
  incremental batch.
- **iOS write path.** Does the inbox file avoid `0xdead10cc` when the app is suspended
  mid-write, with writes wrapped in `beginBackgroundTask`?
- **Android packaging.** Does the `crypto-android` AAR work with the JNA dependency, R8,
  `minSdkVersion` 24 and ABI splits? What does each installation add?
- **Bridge cost, if option 1 is reopened.** Round-trip latency and payload for
  `decryptRoomEvent` over the Capacitor bridge, and whether a synchronous bridge or
  mirrored state can serve the synchronous verification API.

Other open points:

- Does Synapse return a to-device batch again to a client that reuses an older `since`
  token? This only matters if notification code ever syncs (options 1 and 4).
- Can the Angular application builder alias a bare import from inside `node_modules`?
  This only matters for option 1a.

## Sources

Repository (at `origin/main`, 3059d11e):

- [`matrix-client.service.ts`](../../libs/data-access/matrix-client/src/lib/matrix-client.service.ts),
  [`rust-crypto-store.ts`](../../libs/util/matrix/src/lib/rust-crypto-store.ts),
  [`crypto-wasm-loader.ts`](../../libs/util/matrix/src/lib/crypto-wasm-loader.ts)
- [Push reference](../maintenance/push-notifications.md),
  [encryption and trust](../../apps/docs-developers/src/content/docs/architecture/encryption-and-trust.md)
- Installed `matrix-js-sdk` 43.0.0 `src/rust-crypto/index.ts` and `rust-crypto.ts`;
  `@matrix-org/matrix-sdk-crypto-wasm` 18.9.0 `pkg/matrix_sdk_crypto_wasm.d.ts`;
  `@capacitor/android` `MessageHandler.java` and `@capacitor/ios`
  `WebViewDelegationHandler.swift`

Upstream code, read on 2026-10-11:

- [matrix-rust-sdk `bindings/matrix-sdk-crypto-ffi`](https://github.com/matrix-org/matrix-rust-sdk/tree/main/bindings/matrix-sdk-crypto-ffi)
  (`src/machine.rs`, `src/lib.rs`, `src/verification.rs`)
- [matrix-rust-sdk `crates/matrix-sdk/src/encryption/mod.rs`](https://github.com/matrix-org/matrix-rust-sdk/blob/main/crates/matrix-sdk/src/encryption/mod.rs)
  (cross-process store lock and generation counter)
- [matrix-rust-sdk `crates/matrix-sdk-ui/src/notification_client.rs`](https://github.com/matrix-org/matrix-rust-sdk/blob/main/crates/matrix-sdk-ui/src/notification_client.rs)
- [matrix-rust-sdk `crates/matrix-sdk-store-encryption/src/lib.rs`](https://github.com/matrix-org/matrix-rust-sdk/blob/main/crates/matrix-sdk-store-encryption/src/lib.rs)
  (`KDF_ROUNDS`)
- [matrix-rust-sdk #1415](https://github.com/matrix-org/matrix-rust-sdk/issues/1415)
- [crypto-ffi 0.17.0 release](https://github.com/matrix-org/matrix-rust-sdk/releases/tag/matrix-sdk-crypto-ffi-0.17.0);
  [`crypto-android` on Maven Central](https://repo1.maven.org/maven2/org/matrix/rustcomponents/crypto-android/maven-metadata.xml)
- [Element X iOS `NSEUserSession.swift`](https://github.com/element-hq/element-x-ios/blob/develop/NSE/Sources/NSEUserSession.swift),
  [`ClientFactory.swift`](https://github.com/element-hq/element-x-ios/blob/develop/ElementX/Sources/Services/Client/ClientFactory.swift),
  [`URL.swift`](https://github.com/element-hq/element-x-ios/blob/develop/ElementX/Sources/Other/Extensions/URL.swift)
- [Element X Android `RustMatrixClient.kt`](https://github.com/element-hq/element-x-android/blob/develop/libraries/matrix/impl/src/main/kotlin/io/element/android/libraries/matrix/impl/RustMatrixClient.kt)
- [matrix-ios-sdk `MXBackgroundCryptoV2.swift`](https://github.com/matrix-org/matrix-ios-sdk/blob/develop/MatrixSDK/Background/Crypto/MXBackgroundCryptoV2.swift)

Specifications and platform documentation:

- [Matrix client-server API v1.19, send-to-device messaging](https://spec.matrix.org/v1.19/client-server-api/#send-to-device-messaging)
- [Apple `UNNotificationServiceExtension`](https://developer.apple.com/documentation/usernotifications/unnotificationserviceextension);
  Apple Developer Forums on NSE memory ([64634](https://developer.apple.com/forums/thread/64634),
  [722879](https://developer.apple.com/forums/thread/722879)) and `0xdead10cc`
  ([655225](https://developer.apple.com/forums/thread/655225)); [Michael Tsai's summary of SQLite in app group containers](https://mjtsai.com/blog/2025/05/15/sqlite-databases-in-app-group-containers-dont/)
- [Firebase: receive messages on Android](https://firebase.google.com/docs/cloud-messaging/android/receive-messages)
  and [message priority](https://firebase.google.com/docs/cloud-messaging/android-message-priority)
- [Capacitor plugin method types](https://capacitorjs.com/docs/plugins/method-types)
