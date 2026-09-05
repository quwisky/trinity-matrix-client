# Matrix and encryption

Use this guide when changing client startup, persisted credentials, authentication, Trust or
media encryption. It describes the implementation on `refactor/refine-architecture`.
For product terminology, read the [glossary](../../CONTEXT.md). For cross-capability startup,
Account switching, Workspace and projection ownership, use
[state and runtime lifetimes](state-and-reactivity.md). For the person using Trinity, see
[encryption and recovery](../users/encryption.md).

## Find the implementation owner

| Change                                                                     | Owner and source                                                                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restore, establish, switch or sign out an Account; reset an installation   | [Accounts](../../libs/data-access/accounts/src/index.ts), through `AccountRuntimeService`                                                                           |
| Create an SDK client, bind its stores and crypto callbacks, refresh tokens | [Matrix Runtime adapter](../../libs/data-access/matrix-client/src/index.ts)                                                                                         |
| Discover a homeserver before login                                         | [Discovery](../../libs/data-access/discovery/src/lib/homeserver-discovery.service.ts), injected through Authentication's discovery port                             |
| Password/SSO/OIDC authentication and opaque grants                         | [Authentication](../../libs/data-access/auth/src/index.ts)                                                                                                          |
| Verification, recovery, cross-signing and encryption health                | [Trust](../../libs/data-access/trust/src/index.ts)                                                                                                                  |
| Persist Accounts and select secure storage                                 | [Session storage](../../libs/platform-native/src/lib/session-storage.service.ts) and [secure storage](../../libs/platform-native/src/lib/secure-storage.service.ts) |
| Normalize timeline events and present messages                             | [Conversations](../../libs/data-access/timeline/src/index.ts)                                                                                                       |
| Transfer attachment bytes for an exact Account and Room                    | [Media Pipeline](../../libs/data-access/media/src/index.ts)                                                                                                         |
| Pure WASM loading, attachment/key-file crypto and protocol helpers         | [Matrix utilities](../../libs/util/matrix/src/index.ts)                                                                                                             |

Application Runtime composes these owners. Features consume their public views and commands;
they do not import raw SDK clients or coordinate another capability's connection lifecycle.
See [library boundaries](libraries.md) and the [architecture contract](target-architecture.md).

## SDK version and the deep-import rule

| Package                              | Version |
| ------------------------------------ | ------- |
| `matrix-js-sdk`                      | 42.1.0  |
| `@matrix-org/matrix-sdk-crypto-wasm` | 18.4.0  |

These installed versions are checked by [the version guard](../../scripts/stack-versions.spec.mjs).
The SDK's crypto dependency range must remain compatible with the installed WASM package.
Use the [stack reference](../reference/stack.md) for Trinity's Node and toolchain requirements.

Inside an approved Matrix adapter, crypto types and helpers come from the SDK's deep modules:

```ts
import { CryptoEvent, decodeRecoveryKey, type CryptoApi } from 'matrix-js-sdk/lib/crypto-api';
import type { ServerSideSecretStorage } from 'matrix-js-sdk/lib/secret-storage';
```

The installed SDK has no `exports` map. Its root `SecretStorage` namespace does not replace
these imports. Recheck deep paths if an SDK upgrade introduces an export map. Consumer tiers
remain SDK-free: [ESLint](../../eslint.config.mjs) restricts both static and dynamic SDK imports,
and structural guards enforce containment. Nx project boundaries alone do not cover every
third-party import. Keep protocol modeling in its approved utility boundary and expose the
owning capability's public contract instead of widening an import exemption.

## Create and release an Account client

[MatrixClientService](../../libs/data-access/matrix-client/src/lib/matrix-client.service.ts)
keeps a registry keyed by Matrix user ID. Each live Account has its own SDK client, sync store,
crypto prefix, sync projection, logout listener and ephemeral secret-storage key holder.
Live Accounts sync concurrently; `instance` resolves the Active Account's client. A saved
Account may have no live client after soft logout or a failed restore.

The startup sequence is significant:

1. Await any tracked wipe for the same Account and release an existing client being replaced.
2. Create the Account's sync store, key holder and SDK client, including its captured token
   refresher and ordinary Matrix request deadline (`localTimeoutMs: 30_000`). Sync requests
   use their own polling policy.
3. Attempt sync-store startup, preload the crypto WASM and enter serialized `initRustCrypto()`.
   Store startup is best effort; crypto initialization is required.
4. Attach the sync projection and server-logout listener, then call
   `startClient({ initialSyncLimit: 20, threadSupport: true })`.
5. Publish the client registry and host network origins, then acknowledge projection readiness.

A failed startup releases attached listeners, stops the client, clears the holder and closes
its store. Same-user starts share an uninterruptible underlying attempt. If all consumers
leave, rollback follows **after that attempt settles**; unsubscribe does not immediately
abort Rust initialization. Accounts owns the higher-level restore/establish outcome and
placement commit. Authentication grants are opaque and are consumed by
`AccountRuntimeService`, not by a retired session-establishment facade.

The [state guide](state-and-reactivity.md) describes restore priority and bounded per-Account
outcomes, explicit active/inactive establishment, identical-attempt joining, conflict outcomes,
Workspace URL preparation and the cancellable-preparation/post-commit boundary of switching.
Do not infer those cancellation semantics for every lifecycle command: accepted sign-out and
installation-reset lifetimes continue after the initiating subscription ends.

## Project SDK state and authorize Room writes

[projectFromClient](../../libs/data-access/matrix-client/src/lib/project-from-client.ts) binds
SDK invalidations to Projection Runtime generations. Attachment is keyed to the **client
instance**. A boolean `connected` flag cannot distinguish a replacement client after re-login.
Create this helper in a field initializer or constructor with an injection context. Rebuilds
are coalesced; tests must flush the scheduled turn before asserting that a rebuild did not occur.
Subscription ownership, acknowledgement and reset behavior are detailed in the
[state guide](state-and-reactivity.md).

Conversation adapters normalize `MatrixEvent` and Room state before presentation. The
normalizer handles malformed federated content and throwing getters, gathers bounded sender,
reply, reaction, receipt and shield context, and emits frozen discriminated records. Unsupported
input produces an explicit fallback rather than stopping the projection. Message Presentation
owns sanitized formatted bodies, supported system-event summaries, HTTP(S)-only link-preview
candidates and redacted, undecryptable and unsupported fallbacks. Both main and thread timelines
use it; consumers import `MessageView` from `@trinity/data-access/timeline`. Metrics contain
counts and durations, never message bodies or identifiers. Shiki grammars remain relative
imports beside the lazy Rooms feature so they do not enter the eager bundle.

Room Administration projects membership and power-level policy through
`RoomActionPermissionsService`. Moderation requires the actor to strictly outrank the target;
role assignment also caps the assigned power at the actor's own level, including the SDK's
room-v12 creator power semantics. Detached Accounts have no authority.

The live projection updates open Room and Space settings when a remote role change removes
permission, while preserving drafts and readable alias lists. UI feedback uses focusable
`trnActionAllowed` controls, keyboard-accessible explanations and a touch status surface.
Every cold mutation rechecks permission at subscription time after pickers/confirmations and
before the SDK write; avatar publication checks both before upload and before publishing state.
The homeserver remains authoritative for races. UI details belong in the
[UI guide](ui-and-theming.md), not in a second authorization implementation.

## Session persistence

[SessionStorageService](../../libs/platform-native/src/lib/session-storage.service.ts) splits
saved Account state across two backends:

| Value                                                 | Backend                | Key                            |
| ----------------------------------------------------- | ---------------------- | ------------------------------ |
| Access token                                          | `SecureStorageService` | `matrix.accessToken:<userId>`  |
| OIDC refresh token                                    | `SecureStorageService` | `matrix.refreshToken:<userId>` |
| Non-secret Account records and Active Account pointer | Capacitor Preferences  | `matrix.accounts`              |

The registry contains `{ activeUserId, accounts }`. Each record omits access and refresh tokens
but retains homeserver, user/device identity, expiry, OIDC binding and crypto prefix. `load()`
returns `null` if its record has no access token; the record can still preserve crypto ownership
for reauthentication.

Mutations run through a promise queue so concurrent read/modify/write operations see the previous
commit. In particular, token refresh must not resurrect a removed Account. Reads use a single
registry snapshot and stay outside the mutation queue. Token updates refuse empty refresh-token
replacements as well as absent ones.

### Secure storage backend selection

A successful backend selection is memoized; a rejected selection clears the memo so the next
call can retry:

| Host          | Preferred backend                                                            | Security report    |
| ------------- | ---------------------------------------------------------------------------- | ------------------ |
| Electron      | Main-process `safeStorage` through `trinityDesktop.capabilities.secureStore` | Secure when usable |
| iOS / Android | Keychain / Keystore through `@aparajita/capacitor-secure-storage`            | Secure when usable |
| Web / PWA     | Capacitor Preferences under `secure.`                                        | `isSecure: false`  |

Native calls use `sync: false` so a device's Matrix credentials do not sync through iCloud
Keychain. When no usable desktop backend or native plugin is available, selection falls back
to the web store and emits a warning. This fallback does not provide OS-backed secrecy.
A rejected Electron availability probe instead propagates and clears the selection memo for
retry; it does not select plaintext storage. Failures of an already selected backend's get,
set or remove operations likewise propagate without changing the backend. Browser CSP and
sanitization reduce exposure but do not make script-readable storage safe from code executing
in that origin.

[Electron's secure store](../../electron/src/secure-store.ts) rejects Linux `basic_text` and
`unknown` backends even if `isEncryptionAvailable()` is true. Accepted ciphertext is a JSON
key-to-base64 map in a `0600` file under `userData`. See the
[desktop guide](../platforms/desktop.md) for the bridge and host boundary.

## The crypto store prefix

Rust crypto binds a store to `(userId, deviceId)`. New-device login must not reopen a previous
device's store. `SessionStorageService.upsert` derives the device-scoped prefix:

```text
trinity-crypto:${userId}:${deviceId}
```

A new Account or changed device receives a fresh prefix and best-effort reclamation of the
abandoned crypto store. Same-device reauthentication reuses the existing prefix, including an
absent legacy prefix that means the SDK default. The reauthentication flow carries the saved
device ID so keys need not be discarded merely because the access token expired.

[rust-crypto-store.ts](../../libs/util/matrix/src/lib/rust-crypto-store.ts) is the single source
for `${base}::matrix-sdk-crypto` and `${base}::matrix-sdk-crypto-meta`; an absent prefix uses the
SDK's `matrix-js-sdk` base. Teardown must use the captured Account prefix, not recompute it or
call `clearStores()` without the corresponding `cryptoDatabasePrefix` option.

## Logout, wipe, and the orphan sweep

Client removal detaches listeners, stops sync, clears the key holder, removes the live registry
entry and repairs the Active Account pointer. A retained-store stop closes the sync store;
logout requests store deletion. A tracked background wipe prevents a same-Account start from
racing deletion of reused store names. SDK crypto-store deletion can remain blocked while
another connection exists; there is no universal completion time.

During restoration, Accounts awaits the preliminary orphan-sweep enumeration before reading
saved Accounts. The sweep feature-detects `indexedDB.databases()`, keeps crypto and sync stores
owned by **all registered Accounts**, and requests deletion of recognized unowned crypto and
sync stores. Individual deletion requests are detached. Missing enumeration, another tab,
blocked storage or a failed request can leave residue; the next startup is another best-effort
attempt, not a cleanup guarantee.

### Soft logout versus hard logout

`HttpApiEvent.SessionLoggedOut` routes the server's `soft_logout` flag to the adapter:

| Behavior     | Soft logout                                      | Hard logout     |
| ------------ | ------------------------------------------------ | --------------- |
| Local stores | Preserved for reauthentication                   | Wipe requested  |
| Saved record | Preserved, token invalidated                     | Removed         |
| Presentation | Reauthentication offered through `softLoggedOut` | Account removed |

Other Accounts keep running. The persisted Active Account pointer is reconciled with the live
one after removal, so registry array order and live-map insertion order cannot select different
survivors after restart.

`signOutAccount(accountId)` requires an explicit target. Its adapter determines the last saved
Account from `storage.list()`, never from the live client count: soft-logged-out or failed-restore
Accounts may still own recovery-critical stores. It unregisters notifications while the token
is usable, attempts provider token revocation and Matrix logout, then performs local cleanup.
Expected residue becomes a typed `partial-cleanup` result with a storage scope and recovery
action. Raw scanned database names, secrets and exception messages stay inside the adapter.
The three-second courtesy budget used by installation reset does **not** cover ordinary
single-Account sign-out.

## The factory reset

**Erase all data on this device** invokes `AccountRuntimeService.resetInstallation()` and
[LocalDataWipeService](../../libs/platform-native/src/lib/local-data-wipe.service.ts). It targets
the installation, including local-only keys and offline caches; it does not promise sign-out
on every device. Preserve the recovery-key/other-device and connectivity prerequisites in the
[user flow](../users/encryption.md).

The ordering is part of the storage contract:

1. Read the registry and tokens before deletion. They identify per-Account stores and
   Electron secret keys that cannot be enumerated through the renderer bridge.
2. Attempt live-client sign-out and provider revocation before stopping the client registry.
   Each courtesy operation has a three-second wait budget; failure is reported and cleanup
   proceeds.
3. Stop clients, then attempt IndexedDB deletion using both registry-derived names and
   enumeration where available. Individual delete helpers report blocked/failed outcomes
   with a five-second backstop. They avoid the SDK `clearStores()` promise that can stay
   pending on `onblocked`.
4. Remove Account secrets by registry key before clearing the registry and Preferences.
   Clear the whole app Preferences group, not a manually maintained list of prefixes, and
   attempt secure-store and raw local/session-storage cleanup.
5. Remove service-worker registrations and caches. The next PWA load can require the network.

Deletes run concurrently. A blocked request does not stop other deletions or roll back what
has already gone. It can remain queued and succeed after its holder closes. Recognized orphaned
stores may be reclaimed by a later sweep, subject to the limits above.

Expected cleanup failures become secret-safe scope/recovery values; programming defects use the
error channel. This does **not** guarantee the login page reaches restart within a deadline:
registry reads, database enumeration, secure-store/Preferences and cache/service-worker promises
have no single overall timeout. Unsubscription also does not cancel the accepted reset lifetime.

### What it cannot reach

| Surface                                             | Limit                                            |
| --------------------------------------------------- | ------------------------------------------------ |
| Files saved/shared through native file operations   | Outside the storage reset's deletion set         |
| Electron Chromium cookies and HTTP cache            | Main-process storage; no renderer bulk-clear IPC |
| Electron secrets orphaned without a registry record | The bridge deletes known keys only               |

## Loading the crypto WASM

The SDK's default relative WASM lookup does not produce an Angular build asset. Both the build
copy and explicit preload are required:

```json
{
  "glob": "matrix_sdk_crypto_wasm_bg.wasm",
  "input": "node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg",
  "output": "assets/crypto"
}
```

[preloadCryptoWasm](../../libs/util/matrix/src/lib/crypto-wasm-loader.ts) resolves
`assets/crypto/matrix_sdk_crypto_wasm_bg.wasm` against `document.baseURI`, which also works under
Electron's `trinity://app/` origin. Its module-level replayed Observable and the WASM package's
own memoized initialization share one module. **Preload must finish before `initRustCrypto()`.**
The CSP permits WASM compilation through `wasm-unsafe-eval`; the production service-worker
asset group includes WASM for offline use. The [Web/PWA](../platforms/web.md) and
[Electron](../platforms/desktop.md) checks exercise the emitted renderer and asset path.

## Secret storage and the key holder

[SecretStorageKeyHolder](../../libs/data-access/matrix-client/src/lib/secret-storage-key-holder.ts)
is one plain object per Account client. Bound callback fields are supplied to
`createClient({ cryptoCallbacks })`; a background Account cannot borrow the Active Account's
key. It retains one `[keyId, privateKey]` pair in memory and clears it on teardown.

When replacing a key, zero the outgoing buffer only if it is a **different buffer**. The SDK
may cache the same buffer immediately after Trinity sets it; unconditional zeroing would wipe
the incoming key. The unlocked key is not persisted by this holder.

Trust uses `TrustCryptoPort` to capture an already-started crypto snapshot and attach projections.
That port does not expose Account startup, switching or shutdown. Long-running recovery captures
its exact client and holder before awaiting work, so an Account switch cannot retarget secrets.

## TrustStatus

`TrustHealth` atomically publishes status, backup activity and this-device verification as a
discriminated availability view. `coherent` places one authoritative snapshot in `current`;
`stale` moves the last coherent snapshot into the explicitly named `stale` field; and
`unavailable` exposes neither. Compatibility signals return `unknown` or `null` unless the view is
coherent, so an unavailable read cannot imply that this device is unverified, key backup is off,
or setup/recovery is safe to start. In a coherent snapshot, cross-signing and secret storage
readiness both produce `ready`; otherwise an existing default key produces `needs-recovery`, and
its absence produces `needs-setup`.

[Trust health](../../libs/data-access/trust/src/lib/trust-health.service.ts) reconciles crypto
readiness, backup and device verification from coalesced SDK invalidations. Its asynchronous read
is part of Projection Runtime reconciliation rather than detached promise work, so initial and
later failures mark the retained projection failed. Runtime and local generation gates prevent an
older asynchronous read from overwriting a new Account/view. Explicit `refresh()` reports a
sanitized `TrustOperationError` for `refresh-health` and updates the availability view, but it does
not claim that a failed projection was reattached. The Rooms encryption banner reads the coherent
compatibility status; it does not import the crypto feature.

Application Runtime retains one Trust lifetime for health and incoming verification. The lifetime
publishes opaque, active-Account-scoped health with bounded preparation and recovery observation.
No Account is expected dormancy. Recovery invalidates only a retained failed projection; if either
owned lease was released, it recreates both under the single session owner. Only a successful
current-generation reconciliation resolves the scope, leaving Workspace, Conversations and
unrelated session subscriptions intact throughout a Trust outage.

## Setup and recovery

[TrustService](../../libs/data-access/trust/src/lib/trust.service.ts) exposes cold commands for
setup, unlock, reset and key transfer. These wrap Promise-backed crypto operations: ending the
subscription does not abort the underlying crypto/network work. There is no blanket deadline
for setup, recovery, import or export.

### First device

`setUp(promptPassword)` checks server recovery state, generates a random recovery key,
bootstraps cross-signing with password UIA, creates secret storage and key backup, refreshes
health, then emits the encoded recovery key. It does not derive that key from a password.
The UI displays it behind an explicit saved-key acknowledgement. Passphrase recovery exists
for Accounts provisioned elsewhere; Trinity has no separate passphrase-recovery screen.

The setup guard uses a raw account-data GET for `m.secret_storage.default_key`. The SDK's
post-sync getter can answer from its local store while a prior write's sync echo is missing.
A positively observed server pointer blocks setup. **Read failure currently permits setup**,
including a ten-second guard timeout; it does not establish that recovery is absent. Preserve
this limitation when describing the guard or interpreting a `needs-setup` view.

### Later device

Recovery captures the client and holder, reads the default secret-storage key description,
decodes the recovery key or derives it from a passphrase, and verifies the private key using
`checkKey`. A rejected key buffer is zeroed. A valid key enters the holder and
`bootstrapCrossSigning({})` imports the cross-signing secrets. Enabling an existing backup is
best effort after trust recovery; bulk `restoreKeyBackup()` is not called. Historical messages
can decrypt lazily from backup.

An abandoned reset can leave local cross-signing private keys that were never published.
[cross-signing-repair.ts](../../libs/data-access/trust/src/lib/cross-signing-repair.ts) repairs
only the combination of all three local privates, all three corresponding secrets in storage,
and failed cross-signing readiness. It validates the exported bundle shape, replaces the
three key fields, imports it and signs the current device. Readiness failure alone is too broad
a predicate: it also describes an ordinary unverified device.

### Recovery reset

[runRecoveryReset](../../libs/data-access/trust/src/lib/recovery-reset.ts) owns an ordered
alternative to the SDK's `resetEncryption`, whose destructive preparation precedes the upload
that may require authentication. This path is for loss of recovery access and changes the
Account's identity and backup:

1. Probe password UIA with `deleteMultipleDevices([])`. A cancellation, unsupported flow or
   exhausted attempts **at this probe** exits before pointer or key writes. A server may skip
   the challenge, or a non-refusal probe failure may be swallowed; neither proves that the
   later upload will be authorized.
2. Capture the previous default key ID and park its pointer with `setDefaultKeyId(null)`.
   This prevents local key rotation from trying to export into an old key the person cannot
   unlock. An unconfirmed park attempts repair before returning failure.
3. Rotate and upload cross-signing keys, replaying an accepted password when available.
   Upload can still prompt after parking and local rotation. Failure attempts best-effort
   rollback; it does not guarantee that no writes occurred.
4. After identity publication, delete the dehydrated device, generate a new recovery key and
   call `bootstrapSecretStorage({ setupNewKeyBackup: true })`. This replaces secret storage
   and deletes old key-backup versions. Failures after publication are partial-reset failures.
5. Best-effort remove the stale key description and refresh health. Return the new encoded key
   only on successful completion.

Trinity owns this sequence, so inspect upstream `resetEncryption` on each SDK upgrade. The
ordering tests in [Trust's suite](../../libs/data-access/trust/src/lib/trust.service.spec.ts)
protect park/upload/destructive-tail ordering, including dehydrated-device deletion.

#### Rollback and timeout budgets

Rollback first attempts an unconditional raw server PUT of the previous default-key pointer,
then optional local-pointer alignment and a forced key query to restore the published identity
view. It uses captured Account context. Both major repairs are best effort, followed by health
refresh; a failure is not proof of restored server state.

Do not replace the raw PUT with `storage.setDefaultKeyId()` or gate it on a local read. The
SDK can suppress a write matching its stale local value and then wait for a sync echo. The
server may still hold the parked pointer. The raw write resolves on its HTTP response and
precedes local alignment.

| Constant                      | Value      | Actual scope                                                |
| ----------------------------- | ---------- | ----------------------------------------------------------- |
| `ACCOUNT_DATA_TIMEOUT_MS`     | 10,000 ms  | Selected account-data waits and repair helpers              |
| `RESTORE_ATTEMPTS`            | 3          | Raw rollback write retry limit, with 2s then 4s backoff     |
| `RESTORE_TIMEOUT_MS`          | 20,000 ms  | The **entire retried raw rollback write**, not each attempt |
| `DESTRUCTIVE_TAIL_TIMEOUT_MS` | 150,000 ms | The `bootstrapSecretStorage` wait                           |

`withTimeout` races a Promise against a timer. **It does not abort the request or SDK operation.**
A timed-out destructive tail can still perform work. The initial pointer read, cross-signing
upload/UIA, other tail steps and final health reconciliation are outside that 150-second wait.
Do not describe it as an overall reset deadline or assume timeout rolled anything back.

### Reset in the UI

`EncryptionUnlockPage` requires confirmation with `RESET` and explains that old server backup
is deleted, other devices lose verified status while remaining signed in, and a new key must
be saved. The failure handler distinguishes cancellation, provider-managed recovery,
`review-security-settings` for possible partial reset, and other sanitized operational errors.
It cannot use a busy helper that consumes the error when the recovery meaning must be handled.

Provider recovery resolves only an advertised cross-signing reset action through
`TRUST_PROVIDER_RECOVERY`, composed in
[Application Runtime providers](../../libs/application/runtime/src/lib/composition/application-capability.providers.ts).
The URL remains a visible link as well as an attempted browser handoff because an asynchronous
failure can outlive the browser's user-activation window. The link is cleared with its error.

Setup/unlock leave guards warn about in-flight work and unsaved recovery keys. They permit
**Leave anyway**. They do not guarantee preservation of a generated key whose subscriber has
left, and leaving does not cancel Promise-backed provisioning.

## Shared password UIA

[runPasswordUia](../../libs/util/matrix/src/lib/password-uia.ts) probes the request without auth,
then handles a password-capable UIA challenge with up to three attempts. Callers distinguish
`UiaCancelledError`, `UiaUnsupportedError` and `UiaAttemptsExceededError`; `isUiaRefusal`
groups these separately from request failures. Setup, recovery reset, device sign-out and
password changes share this helper. A server completing the probe without a challenge is a
valid result, not proof that a different subsequent endpoint will also accept the operation.

## Verification and shields

[TrustVerificationService](../../libs/data-access/trust/src/lib/trust-verification.service.ts)
projects one active verification. Self-verification offers advertised Matrix QR show/scan
methods with emoji SAS fallback. Cross-user DM verification remains SAS-only. Only one request
runs at a time. Application Runtime owns Trust's combined session lifetime;
`VerificationHostComponent` presents incoming/cross-user dialogs but does not own a generic
`connect()` call. Outgoing self-verification belongs to `/encryption/verify`. Lazy dialog
components enter through `ENCRYPTION_DIALOG_COMPONENTS`, keeping feature imports contained.

QR payloads are raw bytes. Generation happens only on explicit display, emits a defensive copy
and is not retained in `VerificationView`. The page clears its transient data URL when QR
presentation ends or the request advances. Camera decoding uses the public scanner's platform
service. Scanning is not completion: the displaying side confirms reciprocation, and only
request `Done` reports success. Local `sasConfirmed` prevents repeat prompts while waiting for
the other side; a rejected confirmation clears it.

Expected Trust failures expose operation, stable kind, recovery and partial-update meaning,
without raw SDK responses or secrets. [Shield mapping](../../libs/data-access/timeline/src/lib/shields.ts)
is shared by main and thread timelines. A failed encryption-info probe yields a gray caution
shield, not `null`: absence of a shield must not visually upgrade an unknown message to an
authenticated one.

## Attachment and key-file crypto

[Attachment crypto](../../libs/util/matrix/src/lib/attachment-crypto.ts) implements the Matrix
AES-CTR-256 format with WebCrypto. Only the high eight counter bytes are randomized; the low
64-bit counter starts at zero. Decryption hashes ciphertext and rejects a mismatch before
importing the key and producing plaintext.

Media Pipeline owns opaque staging, exact Account-and-Room transfer, validation, progress,
cancellation, retry identity and presentation references. It captures the client for probes,
uploads, downloads and cache namespaces; an Active Account switch cannot retarget bytes or
credentials. Encrypted uploads omit the filename and use `application/octet-stream`. Generated
thumbnails have independent encryption material because a server cannot resize the ciphertext.
Message Presentation exposes bounded `PresentedMediaReference` metadata, not MXC credentials,
encrypted descriptors, keys, IVs or hashes. Media consumers acquire bytes through the pipeline;
its pin-aware object-URL cache is bounded to 64 entries and URLs are released on Room teardown.
Gallery acquisition and export use host-media adapters; Conversations does not branch on host
identity. See [host capabilities](../platforms/index.md).

[Key-file crypto](../../libs/util/matrix/src/lib/key-file-crypto.ts) implements the interoperable
Megolm session export:

```text
version(1) | salt(16) | iv(16) | iterations(4, big-endian) | ciphertext | hmac(32)
```

The base64 payload is wrapped in `BEGIN/END MEGOLM SESSION DATA` markers. PBKDF2-SHA512
produces separate AES-CTR and HMAC-SHA256 keys. Authentication precedes decryption/import.
The iteration count is read before authentication so it must be bounded: the default is
500,000 and the maximum 5,000,000. WebCrypto buffers use `Uint8Array<ArrayBuffer>` and copies
compatible with the TypeScript `BufferSource` contract. Trust import captures the crypto
context before awaiting file decryption; Account changes cannot redirect imported keys.

## Authentication

### Homeserver discovery

`HomeserverDiscoveryService.discover()` accepts a bare server or Matrix user ID, invokes SDK
`.well-known` discovery, rejects explicit discovery failures and falls back to `https://<domain>`
when no base URL is supplied. It strips the trailing slash. The host network-policy adapter
allows both the entered and resolved origin for pre-login Electron requests; registered
Account origins replace temporary probes on Account changes.

### Capability discovery runs in parallel

The sign-in flow probes legacy login methods and delegated authentication metadata in parallel.
A failed legacy flow request becomes an empty list; unavailable OIDC metadata becomes `null`.
This permits OIDC-native servers without legacy `/login` support and legacy servers without
OIDC metadata. Neither fallback establishes that another authentication method is available.

### Redirect URI shapes

| Flow       | Native and Electron                                | Web                                        |
| ---------- | -------------------------------------------------- | ------------------------------------------ |
| Legacy SSO | `eu.qwky.trinity://sso-callback?sso_state=<nonce>` | `${origin}/sso-callback?sso_state=<nonce>` |
| OIDC       | `eu.qwky.trinity:/sso-callback`                    | `${origin}/sso-callback`                   |

OIDC's private-use redirect has a single slash and no authority or extra query parameters.
It must match registration; OAuth carries its own state. Deep-link matching accepts the scheme
so both forms work. Electron uses the native redirect because its internal `trinity://app`
origin cannot be launched externally; its preload marker identifies desktop even though
Capacitor reports it as non-native.

### Dynamic client registration

`OidcClientService.resolveClientId()` caches the registered client ID under
`oidc.clientId.v2:<issuer>`. Registration supplies the application type, client metadata and
exact redirect URI. A change to authorization-relevant registration metadata requires a
cache-version review; reusing a registration with a different redirect can strand login.

The callback's `invalid_client` message predicate is a known limitation: the installed SDK's
generic token-exchange error omits the provider response code, so that path cannot reliably
clear stale registrations. A test constructing a literal `invalid_client` message does not
prove this production recovery works. Keep this limitation separate from redirect-registration
errors, which can occur before the callback is reached.

### PKCE state has to survive a context change

Trinity owns durable OAuth state through `OidcStateStore`; the installed SDK does not persist it.
The store keeps state, client/device IDs, PKCE verifier and the homeserver, redirect, issuer and
mode needed to rebuild the same OAuth context. Native authorization runs in the system browser;
Electron uses an external browser. App relaunch must recover the same verifier, not generate one.

The verifier is stored through Preferences on every host, including script-readable web
storage. Entries are single-use and freshness-checked for ten minutes, with a one-minute
backward-clock allowance. Expired entries are deleted when checked; this is not a scheduled
erasure guarantee for abandoned storage. Clearing also removes legacy verifier-stash keys.

### The callback page

`SsoCallbackPage` distinguishes OIDC `code`/`error` from legacy `loginToken`, observes query
changes for a reused native route and latches an exchange at most once. It strips returned
credentials/state from the visible URL immediately. OIDC identity is resolved with `whoami()`;
missing device identity fails grant completion.

Both state stores **peek, compare state, then consume**. A forged mismatching callback must
not consume a legitimate pending login. Mismatch against a live stash stays silent; no-pending
state has an error path. Freshness checks reject excessive future timestamps as well as expired
ones, with the clock allowance above.

OIDC reauthentication also retains `expectedUserId`. Authentication rejects and best-effort
revokes a grant for a different user before Account persistence. Ordinary login permits the
chosen Account. The legacy SSO reauthentication path currently lacks the equivalent expected-user
check; do not describe the OIDC protection as covering both flows.

### Token refresh

[TrinityOidcTokenRefresher](../../libs/data-access/matrix-client/src/lib/oidc-token-refresher.ts)
composes the SDK `TokenRefresher`. Metadata discovery goes through the Account's homeserver,
is lazy and shares one pending Promise; rejection clears the memo so a later attempt can retry.
The refresher captures the Account identity and storage service rather than looking up whatever
Account is active, including during crypto startup before registration.

The SDK callback persists rotated tokens and declared expiry through the storage queue. When
a provider omits or returns an empty refresh token, Trinity carries the incoming token forward
for the live client; storage likewise rejects empty replacements. Otherwise a later expiry
could invalidate an Account that still had a usable refresh token.

If code exchange mints tokens but identity resolution fails, `completeGrant` starts best-effort
provider revocation and propagates the original failure immediately. Revocation is detached
because the provider request has no overall timeout and must not hold the callback error screen
indefinitely. The same detached cleanup applies to an OIDC reauthentication identity mismatch.

## Validate a change

Use the [testing guide](../contributing/testing.md) to select the owning project's unit and
type checks plus repository source contracts. Account/Workspace lifecycle tests, Trust reset
ordering and rollback tests, hostile-message and media/key-file tests cover different contracts;
a passing version table or architecture map does not replace them. The disposable Synapse
verification/QR suites and host renderer checks provide integration evidence where available.
Record actual host/provider coverage, skipped destructive operations and unavailable checks.
