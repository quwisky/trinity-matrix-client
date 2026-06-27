# Milestone 3 — Crypto Bootstrap: Implementation Plan

> Status: **planned.** Scope and sequencing for [PLAN.md](../PLAN.md) Milestone 3
> ("Crypto bootstrap"). Device-to-device verification UI (emoji SAS / QR) is
> Milestone 7 and out of scope here.

## What's already done vs. what this milestone adds

`MatrixClientService.init()` already runs `preloadCryptoWasm()` → `initRustCrypto()`
→ `startClient()` ([matrix-client.service.ts](../libs/core/src/lib/matrix/matrix-client.service.ts)).
So the Rust crypto engine and the **IndexedDB crypto store** exist as soon as a
session is live, and device Olm/Megolm keys are generated automatically.

What's missing — and what M3 delivers — is the **account-level secret layer** that
messaging trust depends on:

- **Cross-signing** — a stable user identity that signs each device
- **Secret storage (4S)** + a **recovery key** the user saves
- **Server-side key backup** — so room history survives a device loss
- A UI-facing **`CryptoService`** exposing readiness as signals
- The **two entry flows**: first-time _set up_ and new-device _unlock/recover_

Out of scope (Milestone 7): interactive device-to-device **emoji SAS / QR
verification**. M3's "verification" path is _recovery-key unlock_, which is what
makes a fresh device trusted without another device present.

## The two flows (with exact SDK calls)

All calls go through `client.getCrypto()` (the `CryptoApi`), confirmed present in
matrix-js-sdk 41.8.0 at `node_modules/matrix-js-sdk/lib/crypto-api/index.d.ts`.

### A. First-time setup

Account has no cross-signing yet (`isCrossSigningReady()` → false,
`isSecretStorageReady()` → false):

1. `createRecoveryKeyFromPassphrase()` → `GeneratedSecretStorageKey`
   (`{ privateKey, encodedPrivateKey, keyInfo }`). Hold `privateKey` in memory for
   this session; show `encodedPrivateKey` to the user **once**.
2. `bootstrapCrossSigning({ setupNewCrossSigning: false, authUploadDeviceSigningKeys })`
   — the callback is a **UIA** challenge (normally the user's password) to upload
   the signing keys.
3. `bootstrapSecretStorage({ setupNewKeyBackup: true, createSecretStorageKey })` —
   `createSecretStorageKey` returns the object from step 1; this also creates the
   server key-backup version and stores its key in 4S.
4. Surface the recovery key for the user to save; confirm before dismissing.

### B. New-device unlock / recovery

Cross-signing already exists server-side, but this device isn't trusted
(`isCrossSigningReady()` → false while `getKeyBackupInfo()` / secret storage exist):

1. User enters their **recovery key** or **passphrase**.
2. The SDK's `cryptoCallbacks.getSecretStorageKey` (see below) returns that key when
   the SDK accesses 4S.
3. `restoreKeyBackupWithPassphrase(passphrase)` or `restoreKeyBackup()` pulls
   historical room keys; cross-signing secrets are gossiped into this device,
   marking it trusted.
4. `checkKeyBackupAndEnable()` to start backing up going forward.

## Files — core (`libs/core`)

**New: `libs/core/src/lib/matrix/crypto.service.ts`** — `@Injectable({ providedIn:
'root' })`, same shape as `RoomsService` (a `connect()` that bridges crypto events →
signals; cold Observables for actions):

- Read-only signals: `cryptoReady` (cross-signing + secret storage ready),
  `keyBackupActive`, `thisDeviceVerified`, and `needsSetup` vs `needsRecovery`
  (drives which flow the UI shows).
- `connect()`: on `CryptoEvent.KeysChanged` / sync prepared, recompute status via
  `isCrossSigningReady()`, `isSecretStorageReady()`, `getActiveSessionBackupVersion()`,
  `getDeviceVerificationStatus(userId, deviceId)`. Call `checkKeyBackupAndEnable()`
  once on connect.
- `setUp(getUiaPassword)`: Observable wrapping flow A.
- `recoverWithKey(recoveryKey)` / `recoverWithPassphrase(passphrase)`: Observable
  wrapping flow B.
- `refresh()`: re-evaluate signals.

**Modify: `libs/core/src/lib/matrix/matrix-client.service.ts`** — add
`cryptoCallbacks: { getSecretStorageKey, cacheSecretStorageKey }` to the
`createClient({...})` call. `getSecretStorageKey` resolves from an in-memory key the
`CryptoService` sets during the unlock flow (a small injected key-holder, kept out of
persistent storage). This is the single architectural change to the client lifecycle
and the one to review most carefully.

**Modify: `libs/core/src/index.ts`** — export `crypto.service.ts` (and any
recovery-key value model).

**No new persistence**: the recovery key is **never** written to
`SessionStorageService`. `session.model.ts` is unchanged.

## Files — UI + app

A small new feature lib **`libs/feature-crypto`** (mirrors `feature-auth` /
`feature-rooms`; will also host M7's verification UI later). Pages:

- `encryption-setup.page` — flow A: generate, **display recovery key**
  (copy/download), confirm-saved gate.
- `encryption-unlock.page` — flow B: recovery-key/passphrase input, restore
  progress, error states.
- A reusable `recovery-key-display` component.
- A small `encryption-banner` component shown on `/rooms` when `cryptoReady()` is
  false, linking to setup or unlock.

**Routing (`apps/trinity/src/app/app.routes.ts`)**: add lazy `encryption/setup` and
`encryption/unlock` routes behind `authGuard`.

**UX gate decision (recommended):** keep login/SSO navigating straight to `/rooms` as
today and show the **non-blocking banner** when crypto isn't ready, rather than
forcing a wizard. This matches Element's UX and avoids blocking users who just want
to read unencrypted rooms. (Alternative: a `cryptoGuard` that forces the flow —
heavier; avoid for MVP.)

## Tests (Vitest + TestBed, following `rooms.service.spec.ts`)

- `crypto.service.spec.ts`: fake `client.getCrypto()` returning a fake `CryptoApi`;
  assert signal transitions for the three states (ready / needs-setup /
  needs-recovery), and that `setUp()` calls `bootstrapCrossSigning` then
  `bootstrapSecretStorage` with `setupNewKeyBackup: true`, and `recoverWith*()` calls
  restore + `checkKeyBackupAndEnable`.
- Component spec for `recovery-key-display` (renders the encoded key, copy action).
- No real WASM in unit tests — the `CryptoApi` is fully mocked.

## Docs

- `PLAN.md` §4: mark Milestone 3 ✅ (matching the ✅ style on M5 / M6).
- `README.md`: update the "next" line.
- `docs/ARCHITECTURE.md`: a crypto-bootstrap section (the secret layer, the
  `getSecretStorageKey` callback, the two flows).

## Risks / decisions to flag

- **UIA for `authUploadDeviceSigningKeys`**: password users get a password dialog;
  **SSO users have no password** → the callback must handle a generic UIA stage (SSO
  fallback). Make the callback stage-agnostic, not password-only.
- **Recovery key handling**: shown once, held only in memory, never persisted;
  require an explicit "I saved it" confirm.
- **`getSecretStorageKey` caching**: the SDK may invoke it repeatedly during one
  flow — cache the unlocked key in memory for the session.
- **Don't block first sync** on crypto — `startClient()` stays as-is; crypto setup is
  layered on top.

## Suggested commit sequence (matches the repo's core-then-UI split)

1. `feat(core): secret-storage key callback in the client lifecycle`
2. `feat(core): crypto service — status signals, setup and recovery flows`
3. `feat(crypto): encryption setup + recovery UI with recovery-key display`
4. `feat(rooms): encryption banner prompting setup/verify`
5. `docs: document crypto bootstrap`
