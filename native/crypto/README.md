# trinity-crypto

Trinity's native end-to-end encryption for the Android and iOS apps: `matrix-sdk-crypto`
behind one JSON call surface, so the phone apps can run the same crypto as the web app
without WebAssembly. Experimental: nothing in a release build uses it yet.

## Build and test

Needs Rust and cargo (see `rust-version` of the pinned crates; 1.96 or newer).

```sh
cd native/crypto
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

`cargo build --bin trinity-crypto-cli` builds a host binary that reads one request per line
on stdin and writes one response per line on stdout; a line holding a JSON array is a batch.
The interop test drives it against the WASM package; see "Interop with WASM" below.

## Interop with WASM

`pnpm nx run scripts:native-crypto-interop` builds the CLI and runs it as one device against
the repository's `@matrix-org/matrix-sdk-crypto-wasm` as the other, through a small in-test
homeserver: key claims and room keys both ways, encryption both ways, a replayed to-device
message, and the request shapes of each step compared with each other and with
`scripts/native-crypto-interop.golden.json` (update it with `-u` after a deliberate change).
Without cargo on `PATH` the suite is skipped and says why; with `CI` set it fails instead.
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

`init` opens the store and creates or loads the account. With `storePath` it opens a SQLite
store with `storeKey`, a raw 32-byte key in base64 (never a passphrase); without either the
store is in memory. One machine exists per user and device for the whole process; calls for it
run one at a time. `init` again with the same store returns the open machine, with another
store it fails with `AlreadyOpen`. `close` waits for a call in flight, then drops the machine;
calls queued behind it get `UnknownMachine`. A call that panics drops its machine too, so the
next call needs `init`, which reloads the account from the store.

The crate wipes its own copies of the key, but it cannot wipe the request string or the serde
buffers the key passed through on the way in. Pass the key only in `init`, and drop the
caller's copies as soon as `init` returns.

## For the JNI wrapper

- Read the request with the `jni` crate's `get_string`: Java strings are modified UTF-8, not
  plain UTF-8, so never read their bytes directly.
- Never build with `panic = "abort"`: panics are caught and returned as `Panic` errors only
  while panics unwind.
- Call from a background thread: a call blocks its thread until it is done, and must never
  run on a thread of the crate's own runtime.
- Callbacks (M2) must be queued and delivered after the call that produced them returns, not
  from inside the call.

## The pin rule

`matrix-sdk-crypto`, `matrix-sdk-common` and `matrix-sdk-sqlite` are pinned exactly (`=`) to
the release that `@matrix-org/matrix-sdk-crypto-wasm` in the root `package.json` is built on,
so the web and phone apps run the same crypto. `Cargo.lock` started from the WASM release's
own lock file, so every crate both use has the same version. Bump the WASM package and these
pins together: `[package.metadata.trinity.wasm-pin]` in `Cargo.toml` records the pairing, and
`node scripts/native-crypto-pin.mjs` (also part of `pnpm nx test scripts`) fails when
`package.json`, the pins or `Cargo.lock` disagree with it. Renovate leaves the three pins alone.

## Licence

Most of `src/` is ported from matrix-sdk-crypto-wasm, which is Apache-2.0; this crate is
therefore Apache-2.0 as a whole (`LICENSE-APACHE`). Each ported file names its source.
