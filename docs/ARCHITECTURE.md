# Architecture

How the codebase is organized, the rules it follows, and how data flows. For the
roadmap see [../PLAN.md](../PLAN.md); for dependency specifics see [../STACK.md](../STACK.md).

## Layering rules

1. **Components never import `matrix-js-sdk` directly.** They depend only on the
   services in `@trinity/core` (`libs/core/src/lib/matrix/`). This keeps the SDK
   swappable and the UI testable.
2. **`@trinity/core` is framework-of-the-app logic**, the `@trinity/feature-*` libs are
   screens, and `@trinity/ui` holds reusable presentational components (no state/SDK
   deps). Dependencies point inward: `feature-* → {core, ui}` and `ui → ui` only,
   never the reverse — enforced by `@nx/enforce-module-boundaries` (project `tags` in
   each `project.json`).
3. **Reactive state is exposed as Angular signals.** SDK `EventEmitter` streams are
   bridged into signals inside the core services, so components stay zone-friendly
   and change detection is cheap. Services expose state as read-only signals
   (`asReadonly()`); components are `OnPush`.
4. **Async operations are RxJS Observables.** Service methods that wrap SDK/Capacitor
   promises return cold Observables (`defer`/`from` + operators); components subscribe
   with `takeUntilDestroyed`. Signals are for state, Observables for one-shot actions.

```
            @trinity/feature-* (pages, containers)
              /                              \
             v                                v
    @trinity/ui                      @trinity/core (services, guards)
  (presentational)                            |
                                              v
                                     matrix-js-sdk + crypto WASM
```

## @trinity/core — matrix

| File                                                                                       | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [matrix-client.service.ts](../libs/core/src/lib/matrix/matrix-client.service.ts)           | Owns the single `MatrixClient`. Lifecycle: `createClient → preload WASM → initRustCrypto → startClient`, wiring the 4S `cryptoCallbacks`. Idempotent: re-`init`/`stop` tears down the prior client and clears its recovery key, and a failed bootstrap rolls back rather than leaving `isInitialized` lying. Exposes `syncState` signal.                                                                                                       |
| [auth.service.ts](../libs/core/src/lib/matrix/auth.service.ts)                             | Homeserver discovery (`.well-known`), password login, SSO URL + token exchange, logout. Persists session and starts the client on success.                                                                                                                                                                                                                                                                                                     |
| [rooms.service.ts](../libs/core/src/lib/matrix/rooms.service.ts)                           | Read model over the synced client: Spaces / joined rooms / members as plain view models, exposed as read-only signals (recomputed on sync events). Powers the room-list shell.                                                                                                                                                                                                                                                                 |
| [timeline.service.ts](../libs/core/src/lib/matrix/timeline.service.ts)                     | Per-room timeline read model + actions. `open`/`close` attach to one room; `messages`/`loadingOlder`/`canLoadOlder` signals; `loadOlder` (scrollback), `send`, `edit` (`m.replace`), `redact`, `retry`, `toggleReaction` (`m.annotation`), `reply` (`m.in_reply_to`). Maps SDK events to `MessageView` (markdown HTML, edited/redacted/decryption-failed, reactions, reply preview, local-echo status). See [Messaging](#messaging--timeline). |
| [media.service.ts](../libs/core/src/lib/matrix/media.service.ts)                           | Encrypted attachments: upload (encrypt → `mxc`) and resolve (download → decrypt → object URL) images/files, generate thumbnails, probe duration/dimensions. Authenticated-media aware. Object URLs are pinned/released per open room.                                                                                                                                                                                                          |
| [authed-media.ts](../libs/core/src/lib/matrix/authed-media.ts)                             | Shared helper to fetch `mxc://` bytes with the access token (authenticated media, v1.11+) with a legacy-endpoint fallback. Used by `media.service` and `avatar.service`.                                                                                                                                                                                                                                                                       |
| [avatar.service.ts](../libs/core/src/lib/matrix/avatar.service.ts)                         | Resolves `mxc://` avatars to cached authenticated `blob:` URLs (always attempts authed, falls back to legacy; failures aren't cached). Revoked on logout/login. Bound through the `@trinity/ui` `AVATAR_RESOLVER` token so every `<trn-avatar>` works on authenticated-media-only homeservers.                                                                                                                                                 |
| [profile.service.ts](../libs/core/src/lib/matrix/profile.service.ts)                       | Signed-in user's profile: load + set display name + avatar (raw `mxc`). Powers the Settings profile editor.                                                                                                                                                                                                                                                                                                                                    |
| [devices.service.ts](../libs/core/src/lib/matrix/devices.service.ts)                       | Device/session management: list (verified/current flags), rename, sign-out via shared password UIA; live refresh on `CryptoEvent.DevicesUpdated`. Powers the Settings device list.                                                                                                                                                                                                                                                             |
| [push.service.ts](../libs/core/src/lib/matrix/push.service.ts)                             | Native push: registers an FCM/APNs token (`@capacitor/push-notifications`) + a Matrix pusher (`setPusher`) at a push gateway; removes it on logout. Native-only + config-gated (`PUSH_CONFIG`). See [push notifications](../docs/PUSH.md).                                                                                                                                                                                                     |
| [crypto.service.ts](../libs/core/src/lib/matrix/crypto.service.ts)                         | E2EE secret layer over `getCrypto()`: bootstraps cross-signing + secret storage (4S) + key backup and recovers later devices. `status` signal (`unknown` / `ready` / `needs-setup` / `needs-recovery`), `keyBackupActive`, `thisDeviceVerified`; `setUp` / `recoverWithKey` / `recoverWithPassphrase`. See [Crypto bootstrap](#crypto-bootstrap--e2ee-secret-layer).                                                                           |
| [secret-storage-key.service.ts](../libs/core/src/lib/matrix/secret-storage-key.service.ts) | In-memory holder for the unlocked 4S key; backs the `getSecretStorageKey` / `cacheSecretStorageKey` `cryptoCallbacks`. Never persisted; zeroed on teardown.                                                                                                                                                                                                                                                                                    |
| [verification.service.ts](../libs/core/src/lib/matrix/verification.service.ts)             | Interactive device verification (emoji SAS). Wraps `VerificationRequest`/`Verifier`; instance-keyed `connect()/disconnect()` listen for incoming requests. `active` signal (a `VerificationView`); `startSelfVerification` / `accept` / `startSas` / `confirmSas` / `mismatchSas` / `cancel`. See [Device verification](#device-verification-milestone-7).                                                                                     |
| [crypto-wasm-loader.ts](../libs/core/src/lib/matrix/crypto-wasm-loader.ts)                 | Preloads the Rust crypto WASM from a served asset path (see [WASM loading](#e2ee-wasm-loading)). Memoized.                                                                                                                                                                                                                                                                                                                                     |
| [crypto-spike.service.ts](../libs/core/src/lib/matrix/crypto-spike.service.ts)             | Dev smoke test that proves crypto initializes in the current runtime.                                                                                                                                                                                                                                                                                                                                                                          |
| [session.model.ts](../libs/core/src/lib/matrix/session.model.ts)                           | `MatrixSession` shape (baseUrl, userId, deviceId, accessToken).                                                                                                                                                                                                                                                                                                                                                                                |

## @trinity/core — storage & guards

- [session-storage.service.ts](../libs/core/src/lib/storage/session-storage.service.ts) —
  persists `MatrixSession` via **Capacitor Preferences** (native storage on device,
  localStorage on web).
- [auth.guard.ts](../libs/core/src/lib/guards/auth.guard.ts) — a `CanActivateFn` that lets
  routes through only when a client is live, attempting a one-time session **restore**
  first, otherwise redirecting to `/login`.
- [theme/theme.service.ts](../libs/core/src/lib/theme/theme.service.ts) — light/dark/system
  theme preference (persisted), toggling the Ionic `.ion-palette-dark` class and the native
  status-bar style. Drives the Settings _Appearance_ section.

## State management

**Decision:** lightweight **signal-store services** (`providedIn: 'root'`) — _not_ a
Redux-style library (NgRx / Elf / Akita).

**Why:** `matrix-js-sdk` already _is_ the state store — it owns rooms, members,
timelines, sync, and crypto state in memory + IndexedDB and emits events as the
source of truth. A separate global store would continuously mirror SDK state into a
second tree (duplicated state, sync bugs, boilerplate) for little gain. The core
services instead **project** SDK state into read-only signals — the `angular-signals`
"Service State Pattern" (private writable signal → `asReadonly()` → `computed`) — and
expose async actions as Observables. The SDK stays the single source of truth.

**Current strain (clean up as we grow):**

- `RoomsService.revision` is a bump-counter used to force member recomputation; a
  proper entity store removes it.
- Selection state (`activeSpaceId` / `activeRoomId`) lives in the rooms shell
  component — once rooms are deep-linkable or persisted it belongs in the route or a
  store.

**When to revisit:** optimistic sends (Milestone 6) shipped without a store — local
echo and retry are SDK-native (see [Messaging](#messaging--timeline)). The next
trigger is cross-feature / persisted / deep-linkable selection, where adopting
**`@ngrx/signals` (SignalStore)** for those slices only (`withState` / `withComputed`
/ `withMethods` / `withEntities`) makes sense. It's a signal-native evolution of the
current pattern — no Redux ceremony — and the SDK remains the source of truth; the
store would hold the projected view plus UI / selection state.

## Offline & PWA support

- **Persistent sync store.** `MatrixClientService` backs the client with an
  `IndexedDBStore` (per-account, best-effort: falls back to in-memory off-browser or when
  startup fails), so rooms and timelines are cached for fast startup and offline reads.
  The store is destroyed on logout/reset so a prior account's cache can't linger.
- **Connectivity signal.** A `connectivity` signal derived from `SyncState` drives the
  offline banner in the rooms shell.
- **Service worker (web/PWA only).** `@angular/service-worker` (`apps/trinity/ngsw-config.json`,
  **production builds only**) precaches the app shell + the crypto WASM (`/assets/crypto/`),
  giving the web target the same offline cold start native/desktop get from bundled assets.
  Registration is gated to **web + production** — never inside the Capacitor/Electron WebView,
  which load assets locally — and an `unrecoverable`-event handler reloads to recover from a
  broken cache. Needs in-browser verification of the offline/update flow.

## Messaging / timeline

The chat surface follows the same read-model-as-signals pattern. **`TimelineService`**
attaches to one room at a time (`open`/`close`), listens to the SDK's
`RoomEvent.Timeline`, `RoomEvent.LocalEchoUpdated`, and `MatrixEventEvent.Decrypted`,
and projects the live timeline into a `MessageView[]` signal. Edit events
(`m.replace`) are filtered out — the SDK aggregates each edit onto its target, so
`getContent()` already returns the edited content and `replacingEvent()` drives the
`(edited)` marker. It also sends read receipts on open.

- **Pagination** — `loadOlder()` wraps `scrollback`; `canLoadOlder` reflects the
  pagination token. The list also **auto-backfills** until the viewport is full so a
  short timeline can still scroll.
- **Send / edit / delete** — `send` chooses plain vs HTML; `edit` builds an
  `m.replace` with `m.new_content`; `redact` deletes. **Local echo and retry are
  SDK-native** (pending events + `EventStatus` → a `sending`/`failed` status on the
  view model), so there's no separate optimistic store.
- **Reactions** — `toggleReaction` adds an `m.annotation` or redacts the user's own;
  `MessageView.reactions` (key / count / `reacted`) is read from the room's relations
  container. The standalone reaction events are filtered out of the message list.
- **Replies** — `reply` sends an `m.in_reply_to` with both a plain `> …` body
  fallback and an `<mx-reply>` HTML block, so other clients render it correctly.
  `MessageView.replyTo` is built from `event.replyEventId` + `room.findEventById`; the
  reply fallback is stripped from the displayed `body`/HTML so only the actual reply shows.
- **Markdown** — incoming `org.matrix.custom.html` `formatted_body` renders via
  Angular `[innerHTML]` (auto-sanitized). Outgoing markdown is rendered with `marked`
  then run through `DomSanitizer` — **never `bypassSecurityTrust`** — and the
  formatted body is only sent when markdown actually adds formatting.
- **Media (M8)** — _receive:_ `MediaService` (core) resolves an `mxc`/encrypted
  `content.file` into a `blob:` URL — decrypting in-memory via the in-tree
  `attachment-crypto` (AES-CTR-256 + SHA-256, ported from the unmaintained
  `matrix-encrypt-attachment`) — behind a pinned, bounded object-URL cache that
  cancels in-flight work on room close; `media-attachment` (feature) feeds the
  presentational `media-bubble` (ui). _Send:_ the composer's attach button picks a
  file (Capacitor **Camera** on native, a hidden `<input type="file">` on web/WebView),
  relaying `submitMedia` → message-list `sendMedia` → `RoomsPage.onSendMedia` →
  `TimelineService.sendMedia`. That calls `MediaService.uploadMedia` (encrypting the
  bytes first in E2EE rooms, then `uploadContent`) and sends an
  `m.image`/`m.file`/`m.video`/`m.audio` event; the SDK local echo renders through the
  same media bubble. All SDK/crypto stays in `@trinity/core`.

The UI lives in `@trinity/feature-rooms`: **message-list** (sender-grouped rows,
scroll-anchored pagination, hover row-highlight, Discord-style reply previews + reaction
pills), **message-composer** (Enter sends / Shift+Enter newline; edit and reply modes
with a banner; empty + Up arrow edits your last message; an **emoji-picker** for inserting
emoji), and **message-toolbar** (react / reply / copy / edit / delete — edit & delete
gated to own messages — with a quick-react picker). `RoomsPage` owns room selection and
forwards composer/toolbar actions to `TimelineService`.

## Routing

Defined in [app.routes.ts](../apps/trinity/src/app/app.routes.ts), all lazy-loaded standalone:

| Path                 | Page                                    | Guard       |
| -------------------- | --------------------------------------- | ----------- |
| `/login`             | login                                   | —           |
| `/sso-callback`      | SSO token exchange                      | —           |
| `/rooms`             | Discord-style room shell (default)      | `authGuard` |
| `/settings`          | settings (appearance, profile, devices) | `authGuard` |
| `/encryption/setup`  | first-device encryption setup           | `authGuard` |
| `/encryption/unlock` | new-device recovery / unlock            | `authGuard` |
| `/encryption/verify` | device verification (emoji SAS)         | `authGuard` |
| `/spike`             | dev E2EE crypto spike                   | —           |

## Authentication flow

```
LoginPage
  ─ discoverHomeserver(input) ──► AutoDiscovery.findClientConfig (.well-known)
  ─ getSupportedFlows(baseUrl) ─► loginFlows()           (show password / SSO)
  ─ loginWithPassword() ────────► client.login('m.login.password')
        └─ SessionStorage.save() ─► MatrixClientService.init() ─► /rooms
  ─ startSso() ─► stash baseUrl + a single-use `sso.state` in sessionStorage ─►
        open the homeserver SSO page (web: full-page redirect; native: the system
        browser via @capacitor/browser, so the app's webview stays alive)
        └─ homeserver returns to the redirectUrl with ?loginToken=…&sso_state=…
           • web:    /sso-callback (Angular route)
           • native: eu.qwky.trinity://sso-callback — the OS hands it to the running
                     app; AppComponent's `appUrlOpen` listener parses it and routes
                     to /sso-callback
        └─ SsoCallbackPage verifies `sso_state` round-tripped, strips the token from
           the URL, then completeSsoLogin() ─► /rooms
```

> Native SSO uses a custom URL scheme registered in `ios/.../Info.plist`
> (`CFBundleURLTypes`) and `android/.../AndroidManifest.xml` (a `VIEW` intent-filter).
> The `sso.state` nonce defends against login CSRF / token injection — important on
> native, where any app can invoke the `eu.qwky.trinity://` scheme. **Needs on-device
> validation** (the round-trip can't be exercised headlessly).

On app launch, `authGuard` calls `MatrixClientService.restore()`, which reloads the
persisted session and re-runs the client lifecycle (including crypto).

## E2EE WASM loading

The single most important platform detail (full story in [../SPIKE.md](../SPIKE.md)):

- matrix-js-sdk's default loader resolves its `.wasm` **relative to the bundled JS**,
  which Angular's esbuild does not emit — so it **404s**.
- Fix: the build target (`apps/trinity/project.json`) copies the file to
  `assets/crypto/`, and
  [crypto-wasm-loader.ts](../libs/core/src/lib/matrix/crypto-wasm-loader.ts) calls
  `initAsync(url)` against that path **before** `initRustCrypto()`. The loader memoizes
  its module promise, so the SDK's own internal `initAsync()` reuses our instance.
- Validated headless on **Blink** (Android WebView / Electron) and **WebKit** (iOS).

## Crypto bootstrap / E2EE secret layer

`initRustCrypto()` (above) gives every session a device identity + IndexedDB crypto
store. On top of that, two core services manage the **account-level** secrets that make
messaging trustworthy — cross-signing, secret storage (4S), and key backup.

- **`SecretStorageKeyService`** holds the unlocked 4S private key in memory and backs
  the `getSecretStorageKey` / `cacheSecretStorageKey` callbacks wired into `createClient`.
  That key is effectively the account recovery key, so it is **never written to disk**,
  and `clear()` zeroes the bytes on logout/teardown.
- **`CryptoService`** wraps `client.getCrypto()`. `connect()` bridges
  `CryptoEvent.{KeysChanged,UserTrustStatusChanged,KeyBackupStatus,DevicesUpdated}` into a
  `status` signal — `ready` / `needs-setup` (no 4S yet) / `needs-recovery` (4S exists but
  this device isn't trusted) / `unknown` — plus `keyBackupActive` and `thisDeviceVerified`.
  Status recomputation is race-guarded (a superseded run drops its write) and never throws.

Two flows:

- **Setup (first device)** — `setUp(promptPassword)`: generate a random recovery key,
  `bootstrapCrossSigning` (uploads device-signing keys; the UIA password stage is handled
  by probing unauthenticated, then retrying with the password and re-prompting on a
  rejected one), then `bootstrapSecretStorage({ setupNewKeyBackup: true })`. Returns the
  encoded recovery key for **one-time** display — it is never persisted.
- **Recovery (later device)** — `recoverWithKey` / `recoverWithPassphrase`: verify the
  entered key against 4S (`checkKey`), cache it, `bootstrapCrossSigning({})` to import
  cross-signing from 4S so this device becomes trusted, then enable key backup.

Decisions:

- **Lazy history** — recovery enables backup but skips the bulk `restoreKeyBackup()`
  (which can take hours); room history decrypts on demand from the backup. A
  missing/stale backup key degrades gracefully — the device is already trusted.
- **Password-stage UIA only** — SSO-only accounts surface the UIA error; SSO-driven UIA
  is a follow-up.
- **`matrix-js-sdk/lib/crypto-api` is a deep import** — the crypto-api types/values
  (`CryptoApi`, `CryptoEvent`, `decodeRecoveryKey`, …) are not re-exported from the
  package root in 41.x.

### Setup/recovery UI

The `@trinity/feature-crypto` lib drives the two flows above:

- **`EncryptionSetupPage`** (`/encryption/setup`) — runs `setUp`, answering the UIA
  password challenge via an Ionic alert, then shows the recovery key **once** behind an
  "I've saved it" confirm gate. The key lives only in a component signal (never persisted)
  and is dropped on continue.
- **`EncryptionUnlockPage`** (`/encryption/unlock`) — a recovery-key field that calls
  `recoverWithKey` (key-only; Trinity provisions a random key, so there's no passphrase UI).
- **`RecoveryKeyDisplayComponent`** — presentational; renders the key with copy
  (`navigator.clipboard`) and download (Blob + `<a download>`, hidden on native, object URL
  revoked in a `finally`). Outcomes are announced via a visually-hidden live region.

The **encryption banner** lives in `feature-rooms` (not `feature-crypto`) because the Nx
module boundary forbids feature→feature deps; it reads `CryptoService.status` from
`@trinity/core` and links to setup/unlock (and, for `needs-recovery`, also to device
verification). It's non-blocking — login/SSO still land on `/rooms`, and the banner only
nudges when crypto isn't `ready`. See [CRYPTO-BOOTSTRAP-PLAN.md](CRYPTO-BOOTSTRAP-PLAN.md).

## Device verification (Milestone 7)

The _other_ way a fresh device gets trusted (besides the recovery key): an interactive
**emoji-SAS** comparison with another signed-in session.

- **`VerificationService`** ([verification.service.ts](../libs/core/src/lib/matrix/verification.service.ts))
  wraps the SDK's `VerificationRequest`/`Verifier` so the UI never touches matrix-js-sdk.
  Instance-keyed `connect()/disconnect()` (like `CryptoService`) listen for
  `CryptoEvent.VerificationRequestReceived` and adopt any in-flight request. A single
  `active` signal exposes a plain `VerificationView` (stage, other device, the seven SAS
  emoji when shown); cold Observables drive the actions — `startSelfVerification`, `accept`,
  `startSas`, `confirmSas`, `mismatchSas`, `cancel`, `dismiss`. One verification at a time.
- **UI** in `@trinity/feature-crypto`: `SasCompareComponent` (presentational emoji grid,
  match/mismatch — each emoji announced by its **name**, the glyph `aria-hidden`) and
  `DeviceVerificationPage`, which renders every stage and works both as a route
  (`/encryption/verify`, self-initiated) and as modal content (incoming).
- **`VerificationHostComponent`** ([verification-host.component.ts](../apps/trinity/src/app/verification-host.component.ts))
  is mounted app-level in `app.component.html` (not a lib), so incoming requests are caught
  on **any** route. It owns `connect()` (once the client is live) and lazily presents the
  verification modal for incoming requests — keeping `feature-crypto` out of the main bundle.

MVP scope is self-verification over SAS; QR and cross-user verification are deferred.

## Native shells

Capacitor wraps the web build (`www/`) into `ios/` and `android/`. After any web
change, `pnpm build && pnpm exec cap sync` (or `pnpm exec cap copy`) pushes it into the shells.
iOS uses Swift Package Manager (Capacitor 8 default); Android needs `ANDROID_HOME`.

## Testing harnesses

Unit tests are **Vitest** (via the Analog Angular plugin), one suite per project, run
through Nx (`pnpm test`). [e2e/](../e2e/) holds standalone headless **Playwright**
drivers (raw `playwright`, not `@playwright/test`) that serve the production build and
assert real behavior:

- `crypto-spike.mjs` (parametrized by engine) and `smoke-login.mjs` — smoke checks;
  `smoke-login` makes live `.well-known` discovery calls to matrix.org.
- `verify-sas.mjs` — a two-client emoji-SAS **device-verification round-trip**, driven
  by `verify-sas-run.mjs` against a disposable bundled Synapse (`v1.119.0`) + Caddy
  Docker harness (`e2e/synapse/`), with a homeserver-free `verify-sas-selfcheck.mjs`
  fallback. The full SAS round-trip was run to PASS (2026-06-27).

See [e2e/README.md](../e2e/README.md) for the verification flow.
