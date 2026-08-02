# Matrix and encryption

This is the engineering view of the layer between `matrix-js-sdk` and the rest of the
app: how clients are created and torn down, where session state is persisted, how the
Rust crypto stack is bootstrapped, and how the two authentication families work. The
user-facing view of encryption — what a recovery key is, what the shields mean — lives
in [encryption](../users/encryption.md).

Everything described here sits in two libraries:
[`libs/data-access/matrix-client`](https://github.com/quwisky/trinity-matrix-client/tree/develop/libs/data-access/matrix-client)
(client lifecycle, registry, 4S key holder, token refresher) and
[`libs/data-access/crypto`](https://github.com/quwisky/trinity-matrix-client/tree/develop/libs/data-access/crypto)
(the crypto flows), with the DI-free primitives in
[`libs/util-matrix`](https://github.com/quwisky/trinity-matrix-client/tree/develop/libs/util-matrix)
and the storage backends in
[`libs/platform-native`](https://github.com/quwisky/trinity-matrix-client/tree/develop/libs/platform-native).

## SDK version and the deep-import rule

| Package                              | Version in `package.json`   |
| ------------------------------------ | --------------------------- |
| `matrix-js-sdk`                      | `^41.9.0` (41.9.0 resolves) |
| `@matrix-org/matrix-sdk-crypto-wasm` | `^18.3.1`                   |

The SDK requires Node 22 or newer (`engines.node: >=22.0.0`).

Crypto types are **not** re-exported from the package root in 41.x. `CryptoApi`,
`CryptoEvent`, `decodeRecoveryKey`, `deriveRecoveryKeyFromPassphrase` and
`EventShieldColour` come from `matrix-js-sdk/lib/crypto-api`; `ServerSideSecretStorage`
and `SecretStorageKeyDescriptionAesV1` come from `matrix-js-sdk/lib/secret-storage`.

```ts
import { CryptoEvent, decodeRecoveryKey, type CryptoApi } from 'matrix-js-sdk/lib/crypto-api';
import type { ServerSideSecretStorage } from 'matrix-js-sdk/lib/secret-storage';
```

Those deep paths resolve only because the SDK's `package.json` has no `exports` field.
The root does export a `SecretStorage` _namespace_, which is a different thing and is
not what the code uses. If upstream ever adds an `exports` map, every deep import in the
repo breaks at once.

!!! warning "Components never import matrix-js-sdk"

    All SDK access is wrapped in the `@trinity/data-access-*` services. This is enforced
    by Nx module boundaries, and it is what keeps the SDK swappable and the UI testable.
    See [libraries](libraries.md).

## MatrixClientService is a registry, not a wrapper

[`MatrixClientService`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/data-access/matrix-client/src/lib/matrix-client.service.ts)
holds a `Map<userId, AccountClient>`. Every signed-in account has its own live
`MatrixClient` and all of them sync concurrently; exactly one is marked **active**, and
`instance` returns the active account's client. That is the design decision that let
multi-account land without touching the ~78 call sites that read `this.matrix.instance`:
they stay scoped to whichever account is in view, for free.

Each `AccountClient` carries the per-account state that teardown needs later:

| Field                   | Why it is retained                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `client`                | The live `MatrixClient`.                                                           |
| `cryptoPrefix`          | So a logout wipe deletes **this** account's crypto store, not the SDK default one. |
| `syncStore`             | The `IndexedDBStore`, so its connection can be closed.                             |
| `syncState`             | A per-account signal; `MatrixClientService.syncState` reads the active one.        |
| `onSync`, `onLoggedOut` | The exact listener references, so they can be detached.                            |
| `holder`                | This account's `SecretStorageKeyHolder`, cleared on teardown.                      |

### The lifecycle, in order

`start(session)` is the only place a client is born, and the order is fixed:

1. Await any pending background store wipe for this user id.
2. Build the per-account sync store, `IndexedDBStore({ dbName: 'trinity-sync:${userId}' })`
   — or `null` when `globalThis.indexedDB` is undefined, so unit tests fall back to the
   SDK's in-memory store.
3. `createClient({ baseUrl, accessToken, userId, deviceId, refreshToken?, tokenRefreshFunction?, store?, cryptoCallbacks })`.
4. `store.startup().catch(() => undefined)` — a corrupt or blocked IndexedDB must never
   block login; the cache load is best-effort.
5. `preloadCryptoWasm()`.
6. `initRustCrypto({ cryptoDatabasePrefix: session.cryptoPrefix })`.
7. Attach `ClientEvent.Sync` and `HttpApiEvent.SessionLoggedOut`.
8. `startClient({ initialSyncLimit: 20, threadSupport: true })`.
9. Only now register in the map, publish `accountIds`, publish CORS origins to Electron,
   and clear any soft-logout flag.

A failure anywhere rolls the whole thing back — listeners off, `stopClient()`,
`holder.clear()`, store closed — and rethrows, so `isInitialized` never reports a client
that is half-built. Re-adding an account that is already in the map removes the old entry
first, so a re-auth never orphans a running client or opens a second connection to the
same IndexedDB.

`restoreAll()` is what `authGuard` calls on a cold start. It fires the orphan sweep
(below) fire-and-forget, lists the registry, awaits the **active** account's start for a
fast first paint, then warms the rest in the background best-effort. A stored record with
no token means it was soft-logged-out in an earlier session, so instead of resurrecting a
failing ghost it is marked `softLoggedOut` and offered for re-auth.

### Projecting SDK events into signals

Every service that bridges SDK events into signals goes through
[`projectFromClient`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/data-access/matrix-client/src/lib/project-from-client.ts),
which decides three things once so no service re-derives them: coalescing a sync burst
into a single microtask-deferred rebuild, keying the connection to the **client instance**
rather than a boolean, and re-projecting onto the newly-active client when
`activeUserId()` changes.

!!! warning "Never gate a projection on a boolean"

    A logout followed by a login swaps in a brand-new `MatrixClient`. A boolean
    `connected` flag leaves the listeners attached to the discarded client, which keeps
    emitting into a dead read model — the UI simply freezes with stale data. The guard is
    `connectedClient === client`.

    A consequence for tests: because rebuilds are coalesced into a microtask, an assertion
    that something did *not* rebuild passes trivially unless the turn is flushed first
    (`await Promise.resolve()`).

`projectFromClient` must be called from a field initializer or constructor. It needs an
injection context so the account-switch `effect` is owned by the root injector and lives
for the session.

## Session persistence

[`SessionStorageService`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/platform-native/src/lib/session-storage.service.ts)
splits every account in two.

| What               | Where                           | Key                            |
| ------------------ | ------------------------------- | ------------------------------ |
| Access token       | `SecureStorageService`          | `matrix.accessToken:<userId>`  |
| OIDC refresh token | `SecureStorageService`          | `matrix.refreshToken:<userId>` |
| Everything else    | Capacitor Preferences, one blob | `matrix.accounts`              |

The Preferences blob is `{ activeUserId, accounts: AccountRecord[] }`, where
`AccountRecord = Omit<MatrixSession, 'accessToken' | 'refreshToken'>` — so `baseUrl`,
`userId`, `deviceId`, `accessTokenExpiresAt`, the non-secret `oidc` binding, and
`cryptoPrefix`. `load()` returns `null` when a record exists but has no token. That is
what makes a soft-logged-out account invisible to a restore while keeping its record, and
therefore its crypto store, alive for re-auth.

Every mutation (`save`, `remove`, `clear`, `setActive`, `updateTokens`,
`invalidateToken`) runs through a promise queue, so each read-modify-write of the shared
blob sees the previous one's committed result. The OIDC token refresher calls
`updateTokens` on its own schedule — near expiry, or on a 401 — fully concurrently with a
user-driven logout. Without the lock, a refresh landing after a logout resurrects the
signed-out account. Reads deliberately stay off the queue: one `Preferences.get` plus a
parse is already a consistent snapshot.

### Secure storage backend selection

[`SecureStorageService.select()`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/platform-native/src/lib/secure-storage.service.ts)
picks once and memoizes:

| Platform        | Backend                                                                                           | `isSecure` |
| --------------- | ------------------------------------------------------------------------------------------------- | ---------- |
| Electron        | `trinityDesktop.secureStore` over IPC to the main process `safeStorage`                           | `true`     |
| iOS and Android | `@aparajita/capacitor-secure-storage` — Keychain or Android Keystore, `sync: false` on every call | `true`     |
| Web and PWA     | Capacitor Preferences under a `secure.` prefix                                                    | `false`    |

`sync: false` on native keeps a per-device Matrix session out of iCloud Keychain. On web
`isSecure` is `false` because no XSS-proof browser store exists; the real web defences are
the CSP and the DOMPurify sanitization. Falling back to the web backend **on desktop or
native** means the OS keyring failed, so the code emits a `console.warn` naming the
anomaly rather than degrading silently.

!!! warning "Electron refuses the Linux basic_text backend"

    [`secureStorageUsable()`](https://github.com/quwisky/trinity-matrix-client/blob/develop/electron/src/secure-store.ts)
    returns `false` on Linux when `safeStorage.getSelectedStorageBackend()` is
    `basic_text` or `unknown`. Electron selects `basic_text` when it finds no OS password
    manager, and that backend "encrypts" with a hardcoded key — obfuscation, not
    encryption. `isEncryptionAvailable()` does not distinguish it, so accepting it would
    store the access token and the cross-signing keys under a false promise while the app
    reported secure storage as available. Refusing pushes the renderer onto its documented
    plaintext fallback, which at least surfaces the anomaly.

    On disk the ciphertext is a JSON `key -> base64` map in a single `0600` file under
    `userData`.

## The crypto store prefix

The Rust `OlmMachine` binds to a `(userId, deviceId)` pair. It refuses to open a store
that belongs to a different pair, with:

```text
the account in the store doesn't match the account in the constructor
```

A fresh login always mints a **new device id**. So a crypto store scoped by user id alone
means the second sign-in reopens the first device's store and dies on that error.
Trinity's prefix is therefore scoped by both:

```text
trinity-crypto:${userId}:${deviceId}
```

`SessionStorageService.upsert` is the one place that scheme is derived, and it branches on
whether the device changed:

- **Brand-new account, or an existing one whose `deviceId` changed** — mint a fresh
  device-scoped prefix, and fire-and-forget `reclaimCryptoStore(existing.cryptoPrefix)` to
  delete the abandoned store. No sign-out happened, so nothing else would clean it up.
- **Same-device re-login** (soft-logout re-auth, token rotation) — reuse the exact
  existing record's prefix, _including_ a migrated legacy account's **absent** prefix,
  which means the SDK default store. Upgrading users are never asked to re-verify.

This is also why re-authenticating a soft-logged-out account keeps its keys.
`/login?reauth=<userId>` loads the stored `AccountRecord` (which needs no token), skips
the homeserver step, and passes the stored `deviceId` into the login call as `device_id`.
`upsert` sees no device change, reuses the prefix, and the account comes back with its
Olm store, cross-signing trust and message keys intact.

The IndexedDB names the SDK derives from a prefix live in exactly one file,
[`rust-crypto-store.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/util-matrix/src/lib/rust-crypto-store.ts):
`${base}::matrix-sdk-crypto` and `${base}::matrix-sdk-crypto-meta`, where `base` falls
back to the SDK's own `matrix-js-sdk` default. Three call sites depend on that convention
— the logout wipe, the device-change reclaim, and the cold-start sweep — so it is defined
once rather than restated.

## Logout, wipe, and the orphan sweep

`removeInternal(userId, wipe)` detaches both listeners, stops the client, clears the 4S
key holder, drops the map entry, repoints `activeUserId` if needed, and then either closes
the sync store (a switch-away) or wipes it (a logout).

!!! danger "Always pass the account's own prefix to clearStores"

    ```ts
    account.client.clearStores({ cryptoDatabasePrefix: account.cryptoPrefix });
    ```

    The no-argument form deletes the SDK *default*-prefix store, leaving this account's
    real store orphaned on disk while its registry record disappears. The startup orphan
    sweep spares only stores owned by registered accounts, so it then deletes the orphan —
    and the next fresh login fails with the account/device mismatch. Take the prefix from
    the `AccountClient`; never recompute it.

The crypto delete can block for around 25 seconds, because the WASM store's connection is
only released on garbage collection. So the wipe is tracked in a `Map<userId, Promise<void>>`
and run in the background; re-adding the same account awaits it first, since the sync and
crypto database names repeat across a same-account re-login. The entry self-prunes once it
settles, unless a newer wipe has replaced it.

`sweepOrphanedCryptoStores()` runs at cold start, fire-and-forget, before any account is
loaded. It enumerates `indexedDB.databases()`, builds a keep-set from every registered
account's store names, and deletes any remaining database whose name ends in a Rust crypto
suffix. Cold start is the right moment specifically because a fresh page load holds no
connection to a prior session's stores, so `deleteDatabase` will not block. It is a no-op
where `indexedDB.databases()` is unavailable.

### Soft logout versus hard logout

`handleServerLogout` fires from `HttpApiEvent.SessionLoggedOut` and reads
`err.data.soft_logout`.

|                 | Soft logout                                                           | Hard logout                |
| --------------- | --------------------------------------------------------------------- | -------------------------- |
| Server state    | Token revoked, device kept                                            | Device deleted server-side |
| Stores          | Preserved                                                             | Wiped                      |
| Registry record | Preserved                                                             | Removed                    |
| UI              | Added to the `softLoggedOut` signal so the switcher can offer re-auth | Account gone               |

Either way the other accounts keep running and the active pointer moves to a survivor.
Afterwards the persisted active pointer is reconciled with the in-memory one, because
`removeInternal` repoints by `Map` order while `storage.remove` repoints by array order —
without that step a restart could restore a different account than the UI was showing.

!!! warning "Do not decide the last account from the live client map"

    `AuthService.logout` computes `isLast` from `storage.list()`, never from
    `matrix.accountIds()`. The two legitimately diverge: a soft-logged-out account, or one
    whose background warm-up failed, is absent from the map but deliberately keeps its
    registry record. Judging by the map takes the full-clear branch, `storage.clear()`
    erases every record, and the next cold-start sweep then deletes those accounts' crypto
    stores — destroying their E2EE keys.

`logout` also unregisters the push pusher first, while the token is still valid, and
best-effort revokes OIDC tokens at the provider (RFC 7009 POST to `revocation_endpoint`
for both the refresh token and the access token) before the CSAPI `client.logout(true)`.

## Loading the crypto WASM

This is the single most important platform gotcha in the app.

matrix-js-sdk's default loader resolves `./pkg/matrix_sdk_crypto_wasm_bg.wasm` relative to
its own bundled JS. Angular's esbuild does not emit that file as an asset, so the request
404s and crypto never initializes. The fix needs **both** halves:

1. The build target copies the file out of `node_modules` into the app's assets:

   ```json
   {
     "glob": "matrix_sdk_crypto_wasm_bg.wasm",
     "input": "node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg",
     "output": "assets/crypto"
   }
   ```

2. [`preloadCryptoWasm()`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/util-matrix/src/lib/crypto-wasm-loader.ts)
   calls `initAsync` with an explicit URL against that path:

   ```ts
   const url = new URL('assets/crypto/matrix_sdk_crypto_wasm_bg.wasm', document.baseURI);
   return from(initAsync(url));
   ```

`document.baseURI` rather than `window.location.origin` is what makes this work over
Electron's `trinity://app/` scheme.

The memoization is two-layered and both layers matter. `initAsync` memoizes its module
promise inside the WASM package, so the call matrix-js-sdk makes later inside
`initRustCrypto()` reuses this instance instead of fetching again. On the Trinity side,
`shareReplay(1)` over a module-level observable means repeated `preloadCryptoWasm()` calls
— one per account start, plus the spike harness — run `initAsync` exactly once.

The ordering constraint is simple and absolute: **`preloadCryptoWasm()` must complete
before `initRustCrypto()`**. Step 5 before step 6 in the lifecycle above.

Two supporting details. The app's CSP (a `<meta http-equiv>` in `index.html`) includes
`script-src 'self' 'wasm-unsafe-eval'`, which exists precisely for this WASM module. And
the service worker's `assets` prefetch group includes a `*.wasm` glob, so the crypto module
is available offline on the production web build.

## Secret storage and the key holder

[`SecretStorageKeyHolder`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/data-access/matrix-client/src/lib/secret-storage-key-holder.ts)
is a plain class, deliberately not `@Injectable`. One is constructed per `AccountClient`
inside `start()` and wired straight into that client's crypto callbacks:

```ts
cryptoCallbacks: {
  getSecretStorageKey: holder.getSecretStorageKey,
  cacheSecretStorageKey: holder.cacheSecretStorageKey,
}
```

Both callbacks are arrow **fields**, so `this` stays bound when they are handed to
`createClient`. One holder per account is what stops a background account's key operation
from reading or overwriting another account's key. The unlocked key is effectively the
account's recovery key, so it lives in memory only and is never written to disk.

The holder keeps exactly one `[keyId, privateKey]` pair at a time — whichever key the user
just generated or unlocked — which is why matching on `this.keyId in keys` inside
`getSecretStorageKey` is sufficient and the SDK's suggested `getDefaultKeyId()` lookup is
unnecessary.

!!! warning "Zeroing needs an identity check"

    `set()` zeroes the outgoing buffer before replacing it, but guarded:

    ```ts
    if (this.privateKey && this.privateKey !== privateKey) {
      this.privateKey.fill(0);
    }
    ```

    `set()` can run more than once during a single bootstrap — `cacheSecretStorageKey`
    firing right after a manual `set` with the *same* buffer. Zeroing unconditionally
    would wipe the incoming key, and every subsequent 4S read would fail.

## CryptoStatus

```ts
type CryptoStatus = 'unknown' | 'ready' | 'needs-setup' | 'needs-recovery';
```

`computeStatus()` runs four crypto reads in parallel — `isCrossSigningReady()`,
`isSecretStorageReady()`, `getActiveSessionBackupVersion()`,
`secretStorage.getDefaultKeyId()` — plus `getDeviceVerificationStatus(userId, deviceId)`,
then resolves: both ready gives `ready`; otherwise a `defaultKeyId` exists gives
`needs-recovery`; otherwise `needs-setup`.

Two properties are load-bearing. A monotonic `statusGeneration` token means a slow run
cannot overwrite a newer one. And it never rejects — a transient crypto error keeps the
last known signals rather than flapping the whole UI.

It is driven by a coalesced `projectFromClient` bound to `CryptoEvent.KeysChanged`,
`UserTrustStatusChanged`, `KeyBackupStatus` and `DevicesUpdated`. All four arrive together
during initial sync and after a key query, and each previously ran a full status recompute
— several async crypto reads — on its own.

`CryptoStatus` is what the encryption banner reads. That banner lives in `feature-rooms`,
not `feature-crypto`, because the module boundary forbids a feature-to-feature dependency;
it reads the signal from `@trinity/data-access-crypto` directly.

## Setup and recovery

Three flows, all in
[`CryptoService`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/data-access/crypto/src/lib/crypto.service.ts).

### First device

`setUp(promptPassword)` runs: `assertNoRecoveryOnAccount()` →
`createRecoveryKeyFromPassphrase()` → `bootstrapCrossSigning({ authUploadDeviceSigningKeys })`
→ `bootstrapSecretStorage({ setupNewKeyBackup: true, createSecretStorageKey })` →
recompute status → emit the encoded key.

`createRecoveryKeyFromPassphrase()` is called with **no argument**, so the key is random
rather than passphrase-derived. That is why accounts onboarded in Trinity recover through
`recoverWithKey`; `recoverWithPassphrase` exists for accounts provisioned elsewhere and
has no UI of its own. The encoded key is displayed once, behind an explicit "I have saved
my recovery key" gate, and lives only in a component signal.

!!! danger "Setup asks the server, not the local store"

    `assertNoRecoveryOnAccount` issues a raw
    `client.http.authedRequest(GET, /user/{id}/account_data/m.secret_storage.default_key)`
    instead of reading `secretStorage.getDefaultKeyId()`.

    After initial sync, `getDefaultKeyId` routes through `getAccountDataFromServer`, which
    answers from **this client's local store**. That view stays stale for as long as a
    `/sync` echo is missing — up to the roughly 110 seconds it takes the sync loop to
    notice a dead long-poll (`pollTimeout` 30s plus `BUFFER_PERIOD_MS` 80s). A rolled-back
    recovery reset opens exactly that window.

    Without the guard, one click of "Set up encryption" on an already-set-up account mints
    a fresh 4S key — orphaning the valid one the user holds — and `resetKeyBackup` deletes
    every key-backup version on the account.

    The check **fails open on purpose**: only a pointer the server positively reports
    blocks setup. An unreachable server, a 5xx, or `M_NOT_FOUND` all let it proceed. It is
    also bounded by a local `withTimeout` helper, because `createClient` passes no
    `localTimeoutMs` and matrix-js-sdk's fetch layer only attaches a timeout signal when
    one is given — an accepted-but-unanswered socket would otherwise hang first-run setup
    forever.

### Later device

`recover()` captures the account's holder and client up front, so a mid-recovery account
switch cannot retarget the cached key. It reads `getDefaultKeyId()` and `getKey(keyId)`,
resolves the private key (decoded from the recovery key, or PBKDF2-derived from a
passphrase via `deriveRecoveryKeyFromPassphrase`), verifies it with
`secretStorage.checkKey` — zeroing the buffer and throwing on failure — caches it in the
holder, then calls `bootstrapCrossSigning({})` to import cross-signing out of 4S.

Key backup is enabled afterwards, only if one exists, inside a try/catch: the device is
already trusted by that point and a missing or stale backup key must not fail the
recovery.

The bulk `restoreKeyBackup()` is deliberately never called. History decrypts lazily from
the backup once it is enabled, and the bulk download can take hours.

!!! warning "bootstrapCrossSigning does nothing if privates are already present"

    `resetCrossSigning` rotates the cross-signing private keys **locally** before it
    uploads anything. A reset abandoned between those two points leaves the device holding
    keys nobody published, and that state is self-sustaining: `bootstrapCrossSigning({})`
    sees privates already in the Olm machine and logs "doing nothing", so unlocking 4S
    later never replaces them and the device stays untrusted forever. The user types the
    correct recovery key, the flow reports success, and the status stays `needs-recovery`.

    [`cross-signing-repair.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/data-access/crypto/src/lib/cross-signing-repair.ts)
    detects it narrowly — all three privates cached locally **and** present in secret
    storage **and** `!isCrossSigningReady()`. The `!isCrossSigningReady()` test alone is
    far too wide; it matches every ordinary unverified device. The repair reads the three
    seeds from 4S, round-trips `exportSecretsBundle()` → patch the three key fields →
    `importSecretsBundle()` (the only public way to overwrite them), then
    `crossSignDevice(deviceId)`. The bundle shape is probed at runtime and rejected loudly
    if unrecognised, because the WASM crate's serde representation is typed `unknown` and a
    silent no-op would leave the user broken while reporting success.

### Recovery reset

The last resort, for someone who has lost their recovery key and has no other verified
device.
[`runRecoveryReset`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/data-access/crypto/src/lib/recovery-reset.ts)
is a hand-written replacement for `CryptoApi.resetEncryption`.

!!! danger "Why CryptoApi.resetEncryption is not used"

    `resetEncryption` deletes every key-backup version and all of secret storage **before**
    the cross-signing upload that needs user-interactive auth — and the password prompt
    lives inside that upload. So a cancelled prompt, a mistyped password, an SSO-only
    account, or an OIDC-native homeserver all destroyed the backup on the way to failing,
    and gave nothing back.

    Measured against Synapse v1.119.0: `room_keys/version` went from 200 to `M_NOT_FOUND`
    while the UI was reporting that the identity provider had to do it instead.

Trinity's version runs the same steps in an order that authenticates first:

1. **Pre-authenticate.** Complete a real password UIA round-trip against
   `client.deleteMultipleDevices([])` — a request whose own effect is nothing, but which
   the server gates with the same challenge as the key upload. A refusal (cancelled,
   SSO-only, out of attempts) ends the reset here with **zero writes**.
2. **Park the 4S pointer** with `storage.setDefaultKeyId(null)`, bounded by `withTimeout`.
   This is needed because `resetCrossSigning` exports the freshly rotated privates into the
   _current_ 4S key whenever `hasKey()` — and this user cannot open that key, so leaving
   the pointer in place makes the rotation die on a falsey key callback and never reach the
   upload at all. Parking is the reversible version of what `resetEncryption` achieves by
   deleting secret storage outright.
3. **Rotate and upload:** `bootstrapCrossSigning({ setupNewCrossSigning: true, authUploadDeviceSigningKeys })`,
   replaying the password the server already accepted so the user is asked once. The replay
   is given `replayedAttempts: 1`, so a rejected replay does not cost a human attempt.
4. **The destructive tail:** `deleteDehydratedDevice`, then
   `bootstrapSecretStorage({ setupNewKeyBackup: true })`. `setupNewKeyBackup` is
   **required** here — unlike in the `resetEncryption` shape, where it would create a
   second backup — because `resetKeyBackup` → `setupKeyBackup` opens with
   `deleteAllKeyBackupVersions()`. That one call _is_ the destructive tail.
5. Best-effort clear the stale `m.secret_storage.key.<id>` description.

One step is deliberately moved rather than copied: `resetEncryption` deletes the dehydrated
device first thing, which here would destroy something before the user has authenticated,
so it heads the destructive tail instead.

Because Trinity owns a copy, **a step added to `resetEncryption` upstream will not be
inherited.** Diff the SDK's `resetEncryption` on every version bump. Ordering unit tests in
`crypto.service.spec.ts` assert the sequences `['park','upload','destroy']` and
`['park','upload','dehydrated','destroy']`; they are the guard, not a substitute for
looking.

#### Rollback and timeout budgets

`abandonReset` runs two independent, idempotent repairs. `restoreDefaultKeyId` puts the 4S
pointer back **on the server** — leaving it parked would make every other device read "no
recovery set up" and offer a fresh key, orphaning the user's valid one. Then
`crypto.userHasCrossSigningKeys(userId, true)` forces a `/keys/query` to re-seat the
account's real identity locally, since the Olm machine rotated its privates before the
upload was authorised.

| Constant                      | Value      | What it bounds                                    |
| ----------------------------- | ---------- | ------------------------------------------------- |
| `ACCOUNT_DATA_TIMEOUT_MS`     | 10 000 ms  | A single account-data round-trip                  |
| `RESTORE_ATTEMPTS`            | 3          | Rollback attempts, backing off 2s then 4s         |
| `RESTORE_TIMEOUT_MS`          | 20 000 ms  | Each rollback attempt                             |
| `DESTRUCTIVE_TAIL_TIMEOUT_MS` | 150 000 ms | `bootstrapSecretStorage` and the backup deletions |

The tail budget is deliberately above the roughly 110 seconds a dead `/sync` long-poll
takes to be noticed; a shorter budget would abort a tail the sync loop was about to
unblock. A tail timeout cannot undo anything it already did, so the user is shown a
"may have completed only partly, check Settings" message rather than "timed out".

!!! warning "The rollback writer must not be storage.setDefaultKeyId"

    `restoreDefaultKeyId` uses `client.setAccountDataRaw(...)` — a bare authed PUT that
    always sends and resolves on the HTTP response — wrapped in `retryNetworkOperation`,
    with **no read gating the write**. Two independent reasons:

    - `setAccountData` short-circuits to a no-op when the local store already deep-equals
      the value, and its promise resolves only from its own `ClientEvent.AccountData`
      listener. On the exact failure this repair exists for — the park's PUT landed, its
      `/sync` echo did not — it therefore sends nothing and waits forever for an echo it
      never caused.
    - Reading it back to confirm consults the *local* store, which still holds the
      pre-park value, so it "confirms" a server state that is wrong and skips the only
      write that would fix it.

### Reset in the UI

The reset lives on `EncryptionUnlockPage` behind a confirmation that states the three
consequences — the server backup is deleted forever, other devices lose verified status
but stay signed in, a new key must be saved — and demands the literal word `RESET`.

`resetRecovery()` deliberately does **not** use the shared `runWithBusy` helper. That
helper maps a failure to `EMPTY`, so no error handler ever runs, and this is the one path
that must inspect _why_ it failed:

| Failure               | Response                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UiaCancelledError`   | Say nothing                                                                                                                                                                                               |
| `UiaUnsupportedError` | The account cannot answer a password challenge in-app (OIDC-native or SSO-only), so read the provider's `account_management_uri` and deep-link it with `?action=org.matrix.cross_signing_reset` (MSC2965) |
| Anything else         | Keep its own message                                                                                                                                                                                      |

The provider URL is rendered as a **link** as well as passed to `Browser.open`: by the time
the failure is triaged, several awaits and a network round-trip have passed since the
click, so the browser no longer counts it as user-initiated and blocks the popup. The URL
is held in a `linkedSignal` on `error`, so it can never outlive the message it belongs to.

Both `encryption/setup` and `encryption/unlock` carry `canDeactivate` leave-guards.
Unsubscribing does not abort either operation — both are promises behind `defer` — so a
back-button dismissal would let setup go on to provision 4S and a key backup whose only
recovery key was emitted to a dead subscriber. After that, Settings reports the account as
secured and nothing ever prompts a fix.

## Shared password UIA

`runPasswordUia(makeRequest, promptPassword, userId, opts?)` in
[`password-uia.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/util-matrix/src/lib/password-uia.ts)
probes unauthenticated first (many servers complete without UIA), then on a 401 carrying
`flows` and `session` prompts and retries with an `m.login.password` auth dict, up to three
attempts. Three distinct error types exist because callers act on them differently:

| Error                      | Meaning                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `UiaCancelledError`        | The user cancelled                                                                                               |
| `UiaUnsupportedError`      | The server offers no completable password stage — SSO-only, OIDC-native, or a multi-stage flow past the password |
| `UiaAttemptsExceededError` | Out of attempts                                                                                                  |

`isUiaRefusal(err)` groups them, so an irreversible action can tell "the user did not get
in" from "the request itself failed". It is shared by encryption setup, the recovery reset,
device sign-out, and change-password.

## Verification and shields

[`VerificationService`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/data-access/crypto/src/lib/verification.service.ts)
wraps the SDK's `VerificationRequest` and `Verifier` behind a single `active` signal.
Method is `m.sas.v1`, for both self-verification (`requestOwnUserVerification`) and
cross-user verification (`requestVerificationDM`, launched from the member-info panel).
QR verification is not implemented, and only one verification runs at a time.

The `sasConfirmed` flag on the view model is **local**, because the SDK's phase stays
`Started` after your MAC goes out. Without it the UI would keep asking the user to confirm
instead of waiting for the other side; a rejected `confirm()` flips it back so nobody is
stuck waiting on a MAC that never sent.

Presentation is split. `VerificationHostComponent` in `feature-shell` renders nothing and
owns `connect()`, presenting a modal for any verification the route does not own —
`active.incoming || !active.isSelfVerification`. An outgoing _self_-verification belongs to
`/encryption/verify`. The modal component is resolved through the
`ENCRYPTION_DIALOG_COMPONENTS` token so `feature-shell` never imports `feature-crypto`.

[`shields.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/data-access/timeline/src/lib/shields.ts)
is the single mapping from `getEncryptionInfoForEvent` to a `MessageShield`, shared by
`TimelineService` and `ThreadsService` so the main timeline and the thread panel agree.

!!! warning "A failed shield probe must not return null"

    `null` means *no shield*, which renders identically to a fully authenticated message.
    `resolveShieldsInto` fails **closed**: a caught probe error yields a grey caution
    shield with the generic reason. A transient crypto or store error must never visually
    upgrade an unverified message. The catch is still there so a probe failure cannot break
    the timeline.

## Attachment and key-file crypto

Both live in `util-matrix`, in-tree rather than as dependencies.

[`attachment-crypto.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/util-matrix/src/lib/attachment-crypto.ts)
is a faithful port of Matrix.org's `matrix-encrypt-attachment` (Apache-2.0). It is inlined
because that package has had no release since 2022 and the scheme is frozen by spec — there
is nothing to track, and a security-sensitive primitive stays auditable in-tree with no
Node `crypto` shim leaking into the browser bundle. AES-CTR-256 over WebCrypto.

Two details worth knowing. The 16-byte counter block randomises only the **high** 8 bytes,
so the low 64-bit counter starts at zero and cannot overflow into the nonce for any
realistic file size. And decryption hashes the ciphertext and rejects on mismatch **before**
importing the key, so tampered bytes never yield plaintext.

`MediaService` uploads encrypted blobs with `includeFilename: false` and
`type: 'application/octet-stream'`, so the plaintext filename and MIME type do not leak. It
encrypts the client-generated thumbnail under its own independent key, IV and hash — that
thumbnail is the only one an encrypted room can show, since the server cannot scale an
encrypted original.

[`key-file-crypto.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/util-matrix/src/lib/key-file-crypto.ts)
implements the interoperable Matrix megolm export, the same `.txt` Element reads and
writes:

```text
version(1) ‖ salt(16) ‖ iv(16) ‖ iterations(4, big-endian) ‖ ciphertext ‖ hmac(32)
```

base64 between `-----BEGIN MEGOLM SESSION DATA-----` and its trailer. PBKDF2-SHA512
produces 64 bytes, split into a 32-byte AES-CTR key and a 32-byte HMAC-SHA256 key; the HMAC
covers everything before it, so a wrong passphrase fails verification rather than
decrypting garbage.

!!! warning "The imported iteration count is attacker-controlled"

    `DEFAULT_KEY_FILE_ITERATIONS` is 500 000, and `MAX_KEY_FILE_ITERATIONS` is 5 000 000.
    The cap is a denial-of-service guard, not tidiness: the iteration count is a uint32
    that must be read **before** the HMAC can be verified, because the HMAC key is derived
    from it. Uncapped, a crafted file can request roughly 4.3 billion rounds and pin the
    main thread for minutes.

    Related build constraint in the same file: buffers are typed `Uint8Array<ArrayBuffer>`
    and `.slice()`d, never `subarray()`d, before reaching `crypto.subtle`. The Angular
    build's TypeScript lib rejects the `ArrayBufferLike` a subarray view carries where an
    ArrayBuffer-backed `BufferSource` is required.

## Authentication

### Homeserver discovery

`AuthService.discoverHomeserver(input)` accepts `@user:server.org`, `user:server.org` or a
bare `server.org` — everything after the first colon is taken as the domain. It calls
`AutoDiscovery.findClientConfig(domain)`, throws on `FAIL_PROMPT` or `FAIL_ERROR`, and
otherwise falls back to `https://<domain>` when discovery is silent, with any trailing
slash stripped.

On Electron it calls the desktop bridge's `cors.allowOrigin()` for **both** the typed
domain and the resolved `base_url`. Discovery reaches a server before any account exists to
declare it, and the resolved homeserver may be a different origin than the typed domain
while login POSTs to it. Probes of servers the user never signs into are dropped on the next
account change, when `publishCorsOrigins()` replaces the whole set. See
[desktop](../platforms/desktop.md).

### Capability discovery runs in parallel

```ts
forkJoin({
  flows: this.auth.getSupportedFlows(baseUrl).pipe(catchError(() => of<string[]>([]))),
  oidc: this.auth.getDelegatedAuthConfig(baseUrl),
});
```

Both degradations are deliberate. A failing `loginFlows()` collapses to `[]` rather than
aborting, because an OIDC-native homeserver may not serve the legacy `/login` flows at all
and must not be hidden by their absence. `getDelegatedAuthConfig` maps a thrown
`getAuthMetadata()` to `null`, because that call throws on every non-OIDC homeserver — so a
legacy server is never slowed or broken by the extra round-trip.

`applyFlows` then **suppresses** password and SSO whenever OIDC metadata exists. A
homeserver mid-migration may still advertise `m.login.sso` for compatibility, but an
OIDC-native server owns credentials at the provider. Registration is offered when the
provider's `prompt_values_supported` includes `create` (MSC2965).

### The redirect URI rule

This differs between the two flows, and the difference is not cosmetic.

| Flow       | Native and Electron                                | Web                                        |
| ---------- | -------------------------------------------------- | ------------------------------------------ |
| Legacy SSO | `eu.qwky.trinity://sso-callback?sso_state=<nonce>` | `${origin}/sso-callback?sso_state=<nonce>` |
| OIDC       | `eu.qwky.trinity:/sso-callback`                    | `${origin}/sso-callback`                   |

!!! danger "OIDC private-use redirects take a single slash"

    RFC 8252 §7.1 requires a private-use scheme redirect to have **no authority**, hence
    `eu.qwky.trinity:/sso-callback`. The `//sso-callback` form parses `sso-callback` as the
    authority with an empty path, which providers that enforce the rule reject at **dynamic
    client registration** with "redirect_uri must not have an authority" — before login can
    even start. That is not the `invalid_client` error the recovery path handles.

    The OIDC redirect also carries no extra query parameters, because it must byte-match the
    registered value; the CSRF state rides OAuth's own `state`.

    Because legacy SSO still uses the `//` form, the deep-link matchers must be
    **scheme-only**. `electron/src/deep-link.ts` matches `eu.qwky.trinity:`; matching on
    `://` would silently drop every OIDC callback.

Electron takes the native shape for both flows because its own origin is `trinity://app`,
an internal non-OS scheme that cannot be launched. Note that `Capacitor.isNativePlatform()`
is `false` in the hand-rolled Electron shell — desktop is detected through the
`trinityDesktop` preload marker instead.

### Dynamic client registration

`OidcClientService.resolveClientId` caches the DCR client id in Preferences under
`oidc.clientId.v2:<issuer>`. Registered metadata is
`{ clientName: 'Trinity', clientUri: 'https://trinity.qwky.eu', applicationType: 'web' | 'native', redirectUris: [one] }`.

!!! warning "Bump the cache-key version on any metadata change"

    A registration pins the `redirect_uris` it was created with. Changing the redirect URI
    strands every id cached under the old shape, and the provider then fails with a
    *redirect mismatch* — which is **not** the `invalid_client` that `forgetClientId`
    recovers from, so login wedges until app storage is wiped. The `v2` in the key prefix
    exists for exactly this; bump it whenever registered metadata changes.

    On a callback failure whose message matches `/invalid_client/i`, the callback page does
    call `forgetOidcClientId(issuer)` so the next attempt re-registers.

### PKCE state has to survive a context change

`generateOidcAuthorizationUrl` makes `oidc-client-ts` mint its own OAuth `state` and persist
the sign-in state — which contains the PKCE `code_verifier` — in `sessionStorage` under
`mx_oidc_<state>`.

That is not good enough off the web. On native the authorization happens in the **system
browser**, and on Electron in an **external window**; the app WebView's `sessionStorage` is a
different, empty store, and a cold-start relaunch loses it outright. So Trinity harvests the
entry at build time (preferring the exact key, falling back to scanning any `mx_oidc_*` key
ending in the state, so an SDK prefix change cannot silently break the stash), persists it
through `OidcStateStore` in Capacitor Preferences, and re-seeds `sessionStorage` before
`completeAuthorizationCodeGrant`. The re-seeded entry is removed afterwards either way — it
holds a spent verifier.

On **web** the blob is deliberately not persisted. The SDK's own `sessionStorage` copy
survives a same-tab redirect, so copying the secret into durable storage would add exposure
for no benefit.

### The callback page

`SsoCallbackPage` handles both flows: `code` or `error` means OIDC, `loginToken` means
legacy SSO. Several details defend it:

- It subscribes to `queryParamMap` rather than reading the snapshot once, because the native
  deep link reuses the same component instance. A `claimed` latch makes the exchange run at
  most once.
- The single-use token or code and the state are stripped from the URL via
  `location.replaceState('/sso-callback')` immediately, so they cannot leak through the
  address bar, history, or a `Referer` header.
- OIDC token responses carry no user or device id, so identity is resolved with `whoami()`,
  and the exchange throws if the provider returned no device.

!!! warning "Peek the stash, verify, then clear"

    The `eu.qwky.trinity://` scheme is shared — any installed app can fire it. Both
    `SsoStateStore` and `OidcStateStore` therefore peek **without** clearing, compare the
    returned `state`, and only clear on a match. Consuming first would let a forged callback
    silently kill a legitimate in-flight login, after which the genuine callback finds
    nothing stashed. A mismatch against a live stash stays silent; an error is surfaced only
    when nothing is pending.

    Both stashes are TTL-boxed at 10 minutes, and `OidcStateStore.peek()` **deletes** a
    stash it finds past its TTL — on native and Electron that blob holds the PKCE verifier
    in app-private plaintext, and enforcing the TTL only at read time left an abandoned
    login's secret on disk until some later `save()` happened to overwrite it.

### Token refresh

`TrinityOidcTokenRefresher` extends the SDK's `OidcTokenRefresher` and overrides
`persistTokens` to write rotated tokens through `SessionStorageService.updateTokens` — the
base class persists nothing.

It closes over only the user id and the storage service, never the client registry or the
active account, because a refresh can fire on the first authenticated request during crypto
bootstrap, before `startClient`, when no client is registered yet. One instance per account
keeps a rotated token from landing under another account's key.
