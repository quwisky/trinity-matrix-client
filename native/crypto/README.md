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
or a tampered backup signature fails the same way on both. Both suites share
`scripts/native-crypto-harness.mjs`; a case declared with `covered([...entries], …)` fails unless
it called each entry's native method. Without cargo on `PATH` the suites are skipped and say
why; with `CI` set they fail instead.
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
  listener and return when done. WASM objects passed in travel as their serialised form:
  `saveBackupDecryptionKey` takes `decryptionKeyBase64`, `importBackedUpRoomKeys` takes
  `{ roomId: { sessionId: data } }` for WASM's nested `Map`.

### Events

What WASM reports through `registerRoomKeyUpdatedCallback` and its siblings is queued per
device and read with `pollEvents` (no parameters), which answers
`{ "events": [ … ], "dropped": n }` and empties the queue. Each event is
`{ "type", … }` with one callback invocation's payload: `roomKeysReceived` and
`roomKeysWithheld` carry `keys`, the WASM `RoomKeyInfo` and `RoomKeyWithheldInfo` fields. The
other callbacks (devices, identities, secrets, verification) become event types of their own as
their calls land; `surface.json` names each one.

- Every call moves the events it caused into the queue before it returns, so a poll right
  after a call sees them. Each event is delivered once; events of one type keep their order
  (WASM's separate callbacks give no order across types either).
- `pollEvents` never waits for a call in flight: the queue has its own lock, held only while
  events move, never across an await or while waiting for another lock, and released before
  the host reads the response.
- The queue keeps 1024 events. When the host falls behind, later events are not queued and
  `dropped` counts them (and any batch the store's broadcast channel skipped). A non-zero
  `dropped` means the host's view is stale: for room keys, retry every undecryptable event.
- After a panic drops the machine, `pollEvents` still returns what it queued, and `init`
  listens to the reloaded machine. `close` discards the queue: poll before closing.
- Not every loss can be counted: the store drops a withheld batch its broadcast channel
  skipped without saying so. The channel holds 16 batches and every call drains it, so only a
  single call that stores more than 16 withheld batches could lose one.

### Surface manifest

`surface.json` lists every WASM class and member the installed matrix-js-sdk uses, generated
from its sources by `scripts/native-crypto-surface.mjs` (TypeScript's checker; the WASM
`.d.ts` and `declare module` augmentations). Members of stateful classes carry `status`
(`done`: answered by the `native` call; `planned`; `shim`: answered in JavaScript, with a
`note`), an `area`, and for callbacks the `event` type. `wasmHelpers` are stateless helpers that
keep running on WASM; `pureJs` are value types the shim implements. `node
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
