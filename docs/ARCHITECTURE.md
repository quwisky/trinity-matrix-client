# Architecture

How the codebase is organized, the rules it follows, and how data flows. For the
roadmap see [../PLAN.md](../PLAN.md); for dependency specifics see [../STACK.md](../STACK.md).

## Layering rules

1. **Components never import `matrix-js-sdk` directly.** They depend only on the
   `@trinity/data-access-*` services. (The former monolithic `@trinity/core` was
   dissolved into per-domain libs — it no longer exists.) This keeps the SDK swappable
   and the UI testable.
2. **Libs are typed and layered.** `@trinity/data-access-*` hold the Matrix domain
   services/state, over the shared `@trinity/data-access-matrix-client` client/session
   foundation; `@trinity/util-matrix` holds pure DI-free models/helpers;
   `@trinity/platform-native` wraps Capacitor/native capabilities; `@trinity/feature-*`
   are screens (incl. `feature-shell`, the app shell); `@trinity/ui` + `@trinity/helm/*`
   (spartan-ng **Helm** over headless **Brain** primitives, in `libs/spartan/*`) are
   presentational only. Dependencies point inward — `app → feature → {data-access, ui}
→ {util, platform}`, features never depend on features, and the `scope:shared` kernel
   (util/platform/matrix-client/ui/helm) never reaches into `scope:matrix` domain libs —
   all enforced by `@nx/enforce-module-boundaries` (`type:*` + `scope:*` tags in each
   `project.json`).
3. **Reactive state is exposed as Angular signals.** SDK `EventEmitter` streams are
   bridged into signals inside the data-access services, so components stay zone-friendly
   and change detection is cheap. Services expose state as read-only signals
   (`asReadonly()`); components are `OnPush`.
4. **Async operations are RxJS Observables.** Service methods that wrap SDK/Capacitor
   promises return cold Observables (`defer`/`from` + operators); components subscribe
   with `takeUntilDestroyed`. Signals are for state, Observables for one-shot actions.

```
          apps/trinity (thin: bootstrap + root routes + providers)
                              |
          @trinity/feature-*  (pages, containers; incl. feature-shell)
           /             |                         \
          v              v                          v
   @trinity/ui ──►  @trinity/helm/*     @trinity/data-access-* (services, guards)
 (presentational)  (spartan Brain +         |         \
                    Helm, Tailwind)         v          v
                              matrix-js-sdk + crypto   @trinity/util-matrix (pure)
                                                       @trinity/platform-native (Capacitor)
```

## Matrix domain services (`@trinity/data-access-*`)

| File                                                                                                     | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [matrix-client.service.ts](../libs/data-access-matrix-client/src/lib/matrix-client.service.ts)           | Owns the single `MatrixClient`. Lifecycle: `createClient → preload WASM → initRustCrypto → startClient`, wiring the 4S `cryptoCallbacks`. Idempotent: re-`init`/`stop` tears down the prior client and clears its recovery key, and a failed bootstrap rolls back rather than leaving `isInitialized` lying. Exposes `syncState` signal.                                                                                                                                                                |
| [auth.service.ts](../libs/data-access-auth/src/lib/auth.service.ts)                                      | Homeserver discovery (`.well-known`), password login, SSO URL + token exchange, logout. Persists session and starts the client on success.                                                                                                                                                                                                                                                                                                                                                              |
| [rooms.service.ts](../libs/data-access-rooms/src/lib/rooms.service.ts)                                   | Read model over the synced client (joined rooms / members as plain view models, read-only signals recomputed on sync events) **plus write actions**: `createRoom` (encrypted standalone room), `createDirectMessage` (reuse an `m.direct` room else create an `is_direct`/`trusted_private_chat` one + merge `m.direct`), `inviteUser` (room or space), `searchUsers` (directory). A `directRoomIds` signal flags DMs. Powers the room-list shell + the new-chat / user-picker UI.                      |
| [spaces.service.ts](../libs/data-access-rooms/src/lib/spaces.service.ts)                                 | Spaces read model + write actions. `spaces` signal (joined `m.space` rooms) + `childRoomIds`; `openSpace` fetches the full child set via `getRoomHierarchy` (MSC2946) into `openSpaceChildren` (incl. not-yet-joined rooms / sub-spaces + `suggested`). Writes behind the rail / sidebar: `createSpace`, `createRoomInSpace` (an encrypted room linked via `m.space.child` + `m.space.parent`), `leaveSpace`, `joinRoom` (via servers), and `removeRoomFromSpace` (an empty-`m.space.child` tombstone). |
| [room-create.ts](../libs/util-matrix/src/lib/room-create.ts)                                             | Shared room-creation helpers used by every create path (`RoomsService` + `SpacesService`): `roomEncryptionInitialState` (the Megolm `m.room.encryption` entry for `initial_state`, so a room is encrypted from its first event), `visibilityOptions` (public vs invite-only preset/visibility), and `isValidUserId` (client-side MXID shape check).                                                                                                                                                     |
| [invites.service.ts](../libs/data-access-invites/src/lib/invites.service.ts)                             | Read model over **incoming invites** (rooms/spaces where our membership is `invite`) — a sibling to `RoomsService` / `SpacesService`. `pendingInvites` signal (live as the client syncs) + `acceptInvite` (join) / `declineInvite` (leave). Powers the Invites group.                                                                                                                                                                                                                                   |
| [search.service.ts](../libs/data-access-search/src/lib/search.service.ts)                                | Search aggregator. `localResults` ranks rooms / spaces / DMs / invites synchronously from the live read-model signals (no network, E2EE-safe) for the quick switcher; `searchPeople` is a directory lookup. In-room message search: `searchLoadedMessages` scans the already-loaded _decrypted_ timeline (the reliable path for E2EE; widen with `loadMoreHistory`), and `searchServerMessages` wraps the homeserver `/search` but **refuses encrypted rooms**.                                         |
| [threads.service.ts](../libs/data-access-timeline/src/lib/threads.service.ts)                            | Threads read model + actions over `threadSupport`. Summaries ("N replies", per-thread unread) + a threads list; `openThread`/`closeThread`, `threadMessages`/`canPaginateThread`; `sendToThread`/`sendMediaToThread`/`editInThread`/`redactInThread`/`toggleReactionInThread`/`paginateOpenThread`. Lazily `room.createThread`s on the first reply (the SDK won't form one from the sender's own first send).                                                                                           |
| [timeline.service.ts](../libs/data-access-timeline/src/lib/timeline.service.ts)                          | Per-room timeline read model + actions. `open`/`close` attach to one room; `messages`/`loadingOlder`/`canLoadOlder` signals; `loadOlder` (scrollback), `send`, `edit` (`m.replace`), `redact`, `retry`, `toggleReaction` (`m.annotation`), `reply` (`m.in_reply_to`). Maps SDK events to `MessageView` (markdown HTML, edited/redacted/decryption-failed, reactions, reply preview, local-echo status). See [Messaging](#messaging--timeline).                                                          |
| [media.service.ts](../libs/data-access-media/src/lib/media.service.ts)                                   | Encrypted attachments: upload (encrypt → `mxc`) and resolve (download → decrypt → object URL) images/files, generate thumbnails, probe duration/dimensions. Authenticated-media aware. Object URLs are pinned/released per open room.                                                                                                                                                                                                                                                                   |
| [authed-media.ts](../libs/util-matrix/src/lib/authed-media.ts)                                           | Shared helper to fetch `mxc://` bytes with the access token (authenticated media, v1.11+) with a legacy-endpoint fallback. Used by `media.service` and `avatar.service`.                                                                                                                                                                                                                                                                                                                                |
| [avatar.service.ts](../libs/data-access-media/src/lib/avatar.service.ts)                                 | Resolves `mxc://` avatars to cached authenticated `blob:` URLs (always attempts authed, falls back to legacy; failures aren't cached). Revoked on logout/login. Bound through the `@trinity/ui` `AVATAR_RESOLVER` token so every `<trn-avatar>` works on authenticated-media-only homeservers.                                                                                                                                                                                                          |
| [profile.service.ts](../libs/data-access-profile/src/lib/profile.service.ts)                             | Signed-in user's profile: load + set display name + avatar (raw `mxc`). Powers the Settings profile editor.                                                                                                                                                                                                                                                                                                                                                                                             |
| [devices.service.ts](../libs/data-access-crypto/src/lib/devices.service.ts)                              | Device/session management: list (verified/current flags), rename, sign-out via shared password UIA; live refresh on `CryptoEvent.DevicesUpdated`. Powers the Settings device list.                                                                                                                                                                                                                                                                                                                      |
| [push.service.ts](../libs/data-access-notifications/src/lib/push.service.ts)                             | Native push: registers an FCM/APNs token (`@capacitor/push-notifications`) + a Matrix pusher (`setPusher`) at a push gateway; removes it on logout. Native-only + config-gated (`PUSH_CONFIG`). See [push notifications](../docs/PUSH.md).                                                                                                                                                                                                                                                              |
| [notification.service.ts](../libs/data-access-notifications/src/lib/notification.service.ts)             | Desktop/web OS notifications from the live sync stream (web `Notification` API): live, non-self events while unfocused, gated by `getPushActionsForEvent().notify`. No-op on native mobile (push owns it). See [push notifications](../docs/PUSH.md).                                                                                                                                                                                                                                                   |
| [crypto.service.ts](../libs/data-access-crypto/src/lib/crypto.service.ts)                                | E2EE secret layer over `getCrypto()`: bootstraps cross-signing + secret storage (4S) + key backup and recovers later devices. `status` signal (`unknown` / `ready` / `needs-setup` / `needs-recovery`), `keyBackupActive`, `thisDeviceVerified`; `setUp` / `recoverWithKey` / `recoverWithPassphrase`. See [Crypto bootstrap](#crypto-bootstrap--e2ee-secret-layer).                                                                                                                                    |
| [secret-storage-key.service.ts](../libs/data-access-matrix-client/src/lib/secret-storage-key.service.ts) | In-memory holder for the unlocked 4S key; backs the `getSecretStorageKey` / `cacheSecretStorageKey` `cryptoCallbacks`. Never persisted; zeroed on teardown.                                                                                                                                                                                                                                                                                                                                             |
| [verification.service.ts](../libs/data-access-crypto/src/lib/verification.service.ts)                    | Interactive device verification (emoji SAS). Wraps `VerificationRequest`/`Verifier`; instance-keyed `connect()/disconnect()` listen for incoming requests. `active` signal (a `VerificationView`); `startSelfVerification` / `accept` / `startSas` / `confirmSas` / `mismatchSas` / `cancel`. See [Device verification](#device-verification-milestone-7).                                                                                                                                              |
| [crypto-wasm-loader.ts](../libs/util-matrix/src/lib/crypto-wasm-loader.ts)                               | Preloads the Rust crypto WASM from a served asset path (see [WASM loading](#e2ee-wasm-loading)). Memoized.                                                                                                                                                                                                                                                                                                                                                                                              |
| [crypto-spike.service.ts](../libs/data-access-crypto/src/lib/crypto-spike.service.ts)                    | Dev smoke test that proves crypto initializes in the current runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [session.model.ts](../libs/util-matrix/src/lib/session.model.ts)                                         | `MatrixSession` shape (baseUrl, userId, deviceId, accessToken).                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Platform capabilities & guards (`@trinity/platform-native`, `@trinity/data-access-auth`)

- [session-storage.service.ts](../libs/platform-native/src/lib/session-storage.service.ts) —
  persists `MatrixSession` via **Capacitor Preferences** (native storage on device,
  localStorage on web).
- [auth.guard.ts](../libs/data-access-auth/src/lib/auth.guard.ts) — a `CanActivateFn` that lets
  routes through only when a client is live, attempting a one-time session **restore**
  first, otherwise redirecting to `/login`.
- [theme/theme.service.ts](../libs/platform-native/src/lib/theme.service.ts) — light/dark/system
  theme preference (persisted), toggling the retained `.ion-palette-dark` marker class on
  `<html>` (a leftover name — no Ionic behind it; the dark palette is defined by the
  trinity/spartan Tailwind tokens) and the native status-bar style. Drives the Settings
  _Appearance_ section.

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
  offline banner in the rooms shell — rendered, like the encryption prompt, through the
  shared `<trn-banner>` (`@trinity/ui`).
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
  same media bubble. All SDK/crypto stays in the `@trinity/data-access-*` services.

The UI lives in `@trinity/feature-rooms`: **message-list** (sender-grouped rows,
scroll-anchored pagination, hover row-highlight, Discord-style reply previews + reaction
pills), **message-composer** (Enter sends / Shift+Enter newline; edit and reply modes
with a banner; empty + Up arrow edits your last message; an **emoji-picker** for inserting
emoji; **paste an image** from the clipboard to send it via the same media path), and
**message-toolbar** (react / reply / copy / edit / delete — edit & delete
gated to own messages — with a quick-react picker). `RoomsPage` owns room selection and
forwards composer/toolbar actions to `TimelineService`. The shell also hosts a **quick
switcher** (`QuickSwitcherComponent`, global Cmd/Ctrl+K + a header button), **in-room
message search** (`MessageSearchComponent`), and a **user picker** (`UserPickerComponent`,
for create-room / DM / invite).

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

Every routed page builds its top bar from the shared `<trn-page-header>` shell
(`@trinity/ui`) — one `<header>` / one `<h1>`, with a `page` or `chat` variant and
projected leading / title / actions slots.

On the **desktop/wide split-pane layout** (≥`md`), `/encryption/unlock` and
`/encryption/verify` are presented as **Angular CDK dialogs** (via the helm overlay
`TrnDialogService`) rather than routed pages — the `EncryptionDialogService` (`@trinity/ui`)
decides modal-vs-route from the `md` breakpoint and lazy-loads the page components via the
`ENCRYPTION_DIALOG_COMPONENTS` token (wired in `main.ts`, so `ui`/`core` never import
`feature-crypto`); the routes remain the canonical deep-link / mobile target. Focus is
relocated into the entering page on each route change by `NavigationFocusService` (wired in
`main.ts`, replacing Ionic's focus manager). Production builds disable
`optimization.styles.inlineCritical` — its deferred stylesheet `onload` never fires over the
`trinity://` scheme, which broke the desktop dark theme.

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
  [crypto-wasm-loader.ts](../libs/util-matrix/src/lib/crypto-wasm-loader.ts) calls
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
  password challenge via the spartan `TrnAlertService` prompt (helm overlay), then shows
  the recovery key **once** behind an
  "I've saved it" confirm gate. The key lives only in a component signal (never persisted)
  and is dropped on continue.
- **`EncryptionUnlockPage`** (`/encryption/unlock`) — a recovery-key field that calls
  `recoverWithKey` (key-only; Trinity provisions a random key, so there's no passphrase UI).
- **`RecoveryKeyDisplayComponent`** — presentational; renders the key with copy
  (`navigator.clipboard`) and download (Blob + `<a download>`, hidden on native, object URL
  revoked in a `finally`). Outcomes are announced via a visually-hidden live region.

The **encryption banner** lives in `feature-rooms` (not `feature-crypto`) because the Nx
module boundary forbids feature→feature deps; it reads `CryptoService.status` from
`@trinity/data-access-crypto` and links to setup/unlock (and, for `needs-recovery`, also to device
verification). It's non-blocking — login/SSO still land on `/rooms`, and the banner only
nudges when crypto isn't `ready`. See [CRYPTO-BOOTSTRAP-PLAN.md](CRYPTO-BOOTSTRAP-PLAN.md).

## Device verification (Milestone 7)

The _other_ way a fresh device gets trusted (besides the recovery key): an interactive
**emoji-SAS** comparison with another signed-in session.

- **`VerificationService`** ([verification.service.ts](../libs/data-access-crypto/src/lib/verification.service.ts))
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

### Electron desktop

A hand-rolled Electron shell (`electron/`, own `package.json`) serves `www/` over a
privileged `trinity://app` scheme (a secure context, so IndexedDB / WASM / `crypto.subtle`
work). Hardened: `contextIsolation` + `sandbox` + `nodeIntegration: false`. The preload
exposes a minimal `trinityDesktop` bridge (`contextBridge`) — `isElectron`, `onDeepLink`
(OS SSO callback over the `eu.qwky.trinity://` scheme), and `showNotification` /
`onNotificationClick`. **Notifications** are posted from the **main process** (Electron
`Notification`, over a validated, sender-checked IPC channel) so the OS attributes them to
Trinity; a click focuses the window and routes to the room. `Capacitor.isNativePlatform()`
is **false** here, so platform branches that must treat desktop like web (service worker
off, push off, web-notification gate) key off the `trinityDesktop` marker too. Packaging is
electron-builder: `pnpm electron:package:mac` is unsigned (dev), `electron:package:mac:signed`
produces a signed + notarized build (Developer ID + an `@electron/notarize` afterSign hook)
— required before macOS will deliver notifications. See [DEVELOPMENT.md](DEVELOPMENT.md).

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
- `send-media-run.mjs`, `threads-run.mjs`, `spaces-run.mjs`, `rooms-run.mjs`,
  `search-run.mjs`, `reply-run.mjs`, `emoji-run.mjs` — full feature flows against the disposable Synapse: encrypted media
  send/receive; the thread lifecycle ("Reply in thread" → the first reply creates the
  thread, reopen, abandon-creates-nothing); spaces create/manage (create a space, create a
  channel in it asserting the `m.space.child`/`m.space.parent` links + child encryption,
  leave); room/DM creation + invites (create a room, start a DM, invite, accept/decline);
  search (the quick switcher + in-room message search); reply header/preview; and composer emoji (`:shortcode` autocomplete, inline conversion, and the ngx-emoji-mart picker). Each `*-run.mjs` owns the
  Synapse lifecycle, so they **must run sequentially** (one shared Docker stack on fixed
  ports), e.g. `pnpm e2e:threads && pnpm e2e:spaces`.

See [e2e/README.md](../e2e/README.md) for the verification flow.

There are also two **`@playwright/test`** suites under `e2e/`:

- `e2e/` (the `@nx/playwright` project, `nx e2e trinity-e2e`) — authenticated app journeys
  against the same disposable Synapse harness (login, settings/theme, devices,
  focus-relocation on navigation). Skips itself when Docker/Synapse is unavailable.
- `e2e/electron/` (`pnpm electron:e2e`, config `playwright.electron.config.mts`) — launches
  the **built desktop app** via Playwright's `_electron` API and asserts it boots over
  `trinity://app`, the preload bridge is exposed but Node isn't, dark mode applies (a
  regression for the critical-CSS bug), and crypto WASM loads. Each run gets a fresh
  `--user-data-dir`; on headless Linux/CI wrap with `xvfb-run` (and `pnpm electron:install`
  for the binary).
