# Trinity — Implementation Plan

A multiplatform Matrix client built with **spartan-ng + Angular** on Tailwind v4, deployed to Web (PWA),
iOS, Android, and Desktop (Electron) from a single Angular codebase.

## Confirmed Decisions

- **Desktop:** Electron — reuses the web build; dedicated packaging config + milestone.
- **E2EE:** In MVP — WASM crypto spike moves into scaffold; crypto store + device
  verification are first-class MVP milestones (not phase 2).
- **Testing:** Vitest (unit) + Playwright (e2e).
- **State management:** signal-store services (no NgRx) — `matrix-js-sdk` is the
  source of truth. Revisit `@ngrx/signals` (SignalStore) for optimistic sends /
  persisted selection. See [ARCHITECTURE.md](ARCHITECTURE.md#state-management).

## 1. Goals & Scope

**MVP feature set:**

- Login (password + SSO), session persistence, logout
- Room list with unread badges, sync loop
- Timeline view: text messages, send/receive, pagination (lazy load history)
- Message composer with markdown + emoji picker; edit, delete (redact), reactions,
  and replies
- Member list & room info
- Media: image/file upload & display
- End-to-end encryption with device verification (emoji SAS / QR)

**Phase 2 (post-MVP):**

- Notifications — _landed_: **desktop/web local notifications** from live sync
  (`NotificationService`) and **mobile push** client plumbing (`PushService` + Matrix
  pusher via `@capacitor/push-notifications`); see [PUSH.md](PUSH.md).
  Remaining for mobile push: a deployed Sygnal gateway + FCM/APNs credentials +
  on-device verification (or UnifiedPush on Android to avoid running a gateway).
- Threads (edits, redactions, reactions, and replies landed early, in MVP)
- Voice/video calls (WebRTC / Element Call style)
- Spaces, room creation/invites, search
- Multi-account — concurrent background sync for every signed-in account (aggregate
  unread badge, per-account notifications, one pusher per account) with a user-panel
  account switcher. Design + phased milestones in [MULTI-ACCOUNT.md](MULTI-ACCOUNT.md).

## 2. Tech Stack

Pinned versions and integration notes live in [STACK.md](STACK.md).

| Concern         | Choice (version @ 2026-06-26)                                                                 | Rationale                                         |
| --------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| UI framework    | spartan-ng `@spartan-ng/brain` 1.0.4 on Tailwind v4 + Angular 22 (standalone, signals)        | Cross-platform UI, native feel                    |
| Native bridge   | Capacitor 8.4.1                                                                               | iOS/Android/Web; SPM on iOS, edge-to-edge Android |
| Desktop         | Electron (hand-rolled shell in `electron/`, packaged with electron-builder)                   | Reuses web build                                  |
| Matrix protocol | `matrix-js-sdk` 41.8.0 (needs Node 22+)                                                       | Official; handles sync/E2EE/crypto                |
| Crypto          | `@matrix-org/matrix-sdk-crypto-wasm` 18.3.1 (Rust crypto)                                     | Modern E2EE backend                               |
| State           | Angular signals for state (read-only from services) + RxJS Observables for async service APIs | Reactive UI; cancellable async flows              |
| Storage         | IndexedDB (sync + crypto store) via SDK; Capacitor Preferences for tokens                     | Persistent offline cache                          |
| Styling         | spartan-ng (Tailwind v4) + CSS variables (theming/dark mode)                                  |                                                   |
| Testing         | Vitest (Analog plugin, run via Nx) + Playwright (e2e)                                         |                                                   |

> Note: `matrix-js-sdk` is browser-oriented and runs under Capacitor's WebView.
> E2EE uses Rust crypto via WASM — loading must be validated on iOS/Android WebViews
> and Electron early (known risk area).

## 3. Architecture

> Layout note: the repo is now an **Nx monorepo**. The module map below is the logical
> design (parts still planned); physically it maps to `apps/trinity` (app shell) and
> `libs/` — Matrix logic lives in per-domain `@trinity/data-access-*` libs (+ `@trinity/util-matrix`,
> `@trinity/platform-native`) and each feature is a `@trinity/feature-*` lib. See
> [ARCHITECTURE.md](ARCHITECTURE.md) for the implemented structure.

```
src/app/
  core/
    matrix/
      matrix-client.service.ts   # wraps matrix-js-sdk lifecycle (create/start/stop)
      auth.service.ts            # login, SSO, token storage
      sync.service.ts            # exposes sync state, rooms as signals/observables
      timeline.service.ts        # per-room timeline window + pagination
      crypto.service.ts          # E2EE init, cross-signing, key backup
      verification.service.ts    # device verification flows
    storage/                     # token + settings persistence (Capacitor)
    guards/                      # authGuard
  features/
    auth/        (login, sso-callback pages)
    rooms/       (room-list page, room-list-item)
    chat/        (room page, timeline, message-bubble, composer)
    settings/    (profile, devices, appearance)
  shared/        (ui components, pipes: timestamp, mxc-url->http, sanitizer)
```

**Key design decisions:**

- Wrap the SDK behind services so components never touch `matrix-js-sdk` directly
  (testability, future SDK swaps).
- Bridge SDK `EventEmitter` events -> RxJS Observables / Angular signals.
- Angular standalone components + lazy-loaded routes per feature.

## 4. Milestones

1. **Scaffold + crypto spike** — Ionic Angular starter, Capacitor (iOS/Android),
   Electron target, Vitest + Playwright wired up. **Critical/gating:** prove
   `@matrix-org/matrix-sdk-crypto-wasm` loads and initializes in iOS WebView,
   Android WebView, and Electron _before_ proceeding. Surface platform failures now.
2. **Auth** — `.well-known` discovery, password + SSO login (deep-link callback on
   native), session + token persistence, auth guard, logout.
3. **Crypto bootstrap** — ✅ initialize Rust crypto, IndexedDB crypto store,
   cross-signing setup, key backup. Establishes the device identity messaging depends on.
   Core services (`CryptoService` + the 4S key callback) plus the `@trinity/feature-crypto`
   setup/recovery UI and a non-blocking `/rooms` encryption banner.
   See [CRYPTO-BOOTSTRAP-PLAN.md](CRYPTO-BOOTSTRAP-PLAN.md).
4. **Sync & room list** — start client with crypto enabled, render rooms
   (names/avatars/unread), live updates, encryption indicators.
5. **Timeline (read)** — ✅ render decrypted messages (markdown), backward pagination
   with auto-backfill, read receipts, "unable to decrypt" fallback UI.
6. **Compose (send)** — ✅ send text/markdown (+ emoji picker) with optimistic local
   echo + retry; edit (`m.replace`), delete (redact), reactions (`m.annotation`), and
   replies (`m.in_reply_to`) via a hover toolbar / Up-arrow shortcut.
7. **Device verification UI** — ✅ emoji SAS self-verification (verify your own
   other devices). `VerificationService` (core) + `feature-crypto` SAS UI + an
   app-level host for incoming requests. QR and cross-user verification deferred.
8. **Media** — 🚧 encrypted media display + send (image/file/video/audio). Attachment
   crypto (AES-CTR-256 + SHA-256) is inlined in `@trinity/util-matrix` (`attachment-crypto.ts`,
   replacing the unmaintained `matrix-encrypt-attachment`); the upload path encrypts for
   E2EE rooms. Picking uses Capacitor **Camera** on native with a web `<input type="file">`
   fallback (works on web and inside WebViews); the composer also accepts a **pasted image**
   from the clipboard (web `ClipboardEvent` — files + a WebKit `items` fallback), sent
   through the same media path. The upload path now **generates a
   client-side thumbnail** for images (canvas-downscaled to a 480px edge) and a
   **poster frame for videos** (seek past the start, draw the frame, encode), encrypted
   per-file for E2EE rooms — the only thumbnail an encrypted room can show, since the
   server can't scale an encrypted original. It also **probes audio/video duration +
   video dimensions** into `content.info` and surfaces a **determinate upload-progress
   bar** in the composer. Downloads save via a platform-branched `FileSaveService`:
   native uses Capacitor **Filesystem** (write to cache) + **Share** (the OS save/share
   sheet), with a web `<a download>` fallback. `cap sync` registered both new plugins
   for Android and iOS. **Remaining follow-up:** on-device verification of the native
   picker + save/share (a native rebuild is required to pick up the new plugins; iOS
   `Info.plist` keys + Android perms for picking already added, and the Filesystem-cache/
   Share path needs no extra permission).
9. **MVP polish** — ✅ dark mode, offline cache, settings/profile, device management
   (feature-complete; remaining items are on-device verification + the documented follow-ups below).
   Settings shell landed as `@trinity/feature-settings` (a `/settings` route reached
   from a gear button in the rooms header). **Appearance/dark mode** is done: a core
   `ThemeService` persists a light/dark/system preference (Capacitor Preferences),
   resolves `system` via `prefers-color-scheme`, and toggles Ionic's `.ion-palette-dark`
   class on `<html>` (light is the `:root` default; the dark palette + Ionic's
   `dark.class.css` tokens layer under the class), applied at startup via
   `provideAppInitializer`. On native the status bar style follows the resolved
   theme (Capacitor **StatusBar**), so the device chrome matches; the System option
   tracks the device's `prefers-color-scheme` (the `color-scheme` meta is set).
   _Android needs on-device verification_ that the WebView reports OS dark mode
   (DayNight activity) and that the status-bar icon contrast holds on the pre-edge-to-edge
   API range. **Profile** is done: a core `ProfileService` reads/updates display name +
   avatar (`getProfileInfo`/`setDisplayName`/`setAvatarUrl`/`uploadContent`, exposed as a
   signal that edits patch optimistically; a missing profile / 404 is treated as empty
   so a new account can still set one), surfaced as a Profile section in settings (avatar
   - name editor + image-validated change-avatar picker). **Device management** is done: a
     core `DevicesService` lists sessions (verified/current flags), renames
     (`setDeviceDetails`), and signs out (`deleteDevice`) driving the password UIA loop the
     homeserver requires; a Devices section renders the list with badges, alert-driven
     rename + sign-out (the current device is protected), and a link to the SAS verify flow.
     _Device follow-ups (done):_ a shared `runPasswordUia` helper (`password-uia.ts`) now
     backs both encryption setup and device sign-out, bailing clearly on SSO-only/multi-stage
     UIA instead of looping; a verify launched from settings returns there (`?returnTo`); and
     the list live-refreshes on `CryptoEvent.DevicesUpdated`.
     **Offline cache** is done: `MatrixClientService` persists the sync store to a
     per-account `IndexedDBStore` (falling back to in-memory off-browser), so rooms and
     timelines are cached for fast startup and offline reads; a `connectivity` signal
     (derived from sync state) drives an offline banner in the rooms shell. Offline
     **cold start** works on native/desktop (Capacitor/Electron bundle the JS + crypto
     WASM as local assets); on **web/PWA** an `@angular/service-worker` (`ngsw-config.json`,
     production-only) precaches the app shell + crypto WASM for the same offline cold start
     (needs in-browser verification of the offline/update flow). **Authenticated avatars**
     are done: a shared `AvatarService` resolves every `mxc://` avatar (rooms, spaces,
     members, timeline senders, profile, sidebar user) to a cached authenticated `blob:`
     URL via a ui-side `AVATAR_RESOLVER` token, so avatars load on v1.11
     authenticated-media-only homeservers instead of falling back to initials; the cache
     is revoked on logout (needs verification against a real authed-media homeserver).

Phase 2:

- **Push notifications** — ✅ mobile push (FCM/APNs → a Matrix pusher via a Sygnal
  gateway; `PushService`, gated to real iOS/Android) plus an in-app `NotificationService`
  driven by the live sync stream for desktop + web/PWA. On Electron, delivery goes
  through the **main process** (the `trinityDesktop` preload bridge → Electron
  `Notification`) so the OS attributes notifications to Trinity; the renderer Web
  Notification path stays for web/PWA. macOS still needs a signed + notarized build to
  actually deliver (see [DEVELOPMENT.md](DEVELOPMENT.md) → signing).
- **Threads** — ✅ full lifecycle. Reading (a core `ThreadsService`, "N replies" timeline
  indicators, a thread view; client runs with `threadSupport: true`); in-thread composing
  (reply/react/edit/delete, reusing the main-timeline paths via the SDK `threadId`);
  **starting** a thread from any message ("Reply in thread" in the hover toolbar — the
  thread is created lazily on the first send via `room.createThread`, since matrix-js-sdk
  won't form one from the sender's own first reply, and opening-then-abandoning leaves no
  empty thread); **history pagination** ("Load older replies"); **per-thread unread
  badges**; and a **threads-list** panel. Covered by an `e2e:threads` Playwright suite.
- **Spaces** — ✅ navigation + create/manage + hierarchy/join. A core `SpacesService`; the
  server rail lists joined spaces and selecting one filters the channel sidebar to its child
  rooms (Home = all). Also **create a space**, **create an (encrypted) room in the active
  space** (linked via `m.space.child` + `m.space.parent`), and **leave a space** — `+`
  affordances in the rail/sidebar plus a leave action. `openSpace` now fetches the full child
  set via `getRoomHierarchy` (MSC2946), so the channel sidebar surfaces a **"More Channels"**
  group of not-yet-joined rooms (Join, with "suggested" hints) and a **"Spaces"** group of
  sub-spaces (open/join), plus a **remove-from-space** action (`removeRoomFromSpace`, an
  empty-`m.space.child` tombstone). Covered by an `e2e:spaces` Playwright suite. Deferred:
  public-space directory discovery, nested-rail navigation, child reordering.
- **Room creation & invites** — ✅ `RoomsService` write actions: **create** an encrypted
  standalone room (`createRoom`), **start a DM** (`createDirectMessage` — reuses an existing
  `m.direct` room, else creates an `is_direct`/`trusted_private_chat` room and merges it into
  `m.direct`), **invite a user** to a room or space (`inviteUser`), and a directory **user
  search** (`searchUsers`); a `directRoomIds` signal flags DMs. Incoming invites get their
  own core `InvitesService` (`pendingInvites` read model + `acceptInvite`/`declineInvite`).
  Shared `room-create.ts` helpers (encryption `initial_state`, visibility/preset, MXID
  validation) back every create path, and `SpacesService` was refactored onto them. UI: a
  `UserPickerComponent` (MXID + live directory search), a "new chat" `+` in the Home sidebar
  (create room / start DM via an ActionSheet), invite buttons in the room + space headers, and
  an **Invites** group (Accept/Decline). Covered by an `e2e:rooms` Playwright suite.
- **Search** — ✅ a **quick switcher** (core `SearchService`): `localResults` ranks rooms,
  spaces, DMs, and invites synchronously client-side (no network, E2EE-safe) and `searchPeople`
  adds a directory lookup; a `QuickSwitcherComponent` opened with global **Cmd/Ctrl+K** (or a
  header button) jumps to a room/space/DM/person/invite. Plus **in-room message search**,
  E2EE-honest: `searchLoadedMessages` scans the already-loaded _decrypted_ timeline (the
  reliable path for an encrypted room, widened by `loadMoreHistory`), while
  `searchServerMessages` uses the homeserver `/search` and **refuses encrypted rooms**; the
  `MessageSearchComponent` carries a "loaded messages only" note for E2EE rooms and jumps to
  the matched event. Covered by an `e2e:search` Playwright suite.
- **Branding** — ✅ a Trinity app icon: three connected nodes (trinity + a Matrix
  federation/chat graph) in brand blurple `#5865f2`. A transparent SVG master + PNG set
  (favicon, PWA, apple-touch) wired into `index.html`, plus the Electron build icon
  (`electron/build/icon.png` → electron-builder generates `.icns`/`.ico`/png at package
  time). The plated variant is kept as `icon-plated.svg`.
- **Multi-account** — 📋 planned (design). Concurrent model: every signed-in account syncs
  in the background, with an aggregate unread badge, per-account notifications, and one
  pusher per account; the switcher lives in the channel-sidebar user panel. The master
  enabler is per-account crypto-store isolation via
  `initRustCrypto({ cryptoDatabasePrefix })` (the sync store is already per-user), so
  `MatrixClientService` becomes a multi-client registry whose `instance` tracks the active
  account — the viewing layer stays active-scoped while a thin aggregation layer spans all
  accounts. Ten milestones (M1 crypto/4S isolation → M10 hardening) with the crypto-migration
  and Sygnal fan-out risks called out. See [MULTI-ACCOUNT.md](MULTI-ACCOUNT.md).
- **Calls** — deferred / de-prioritized.

**Desktop (Electron) hardening (this iteration).** Hand-rolled Electron shell (privileged
`trinity://app` scheme, tray, deep-link SSO). Resolved this pass: dark theme on desktop
(production critical-CSS inlining deferred the stylesheet behind an `onload` that never
fires over `trinity://`, so `inlineCritical` is off; dark also uses `:root.ion-palette-dark`
to win the cascade unconditionally); an `IonRouterOutlet` navigation lock (ionic#30240 —
`focusManagerPriority` moves focus into the entering page before the leaving one is
`aria-hidden`); modal `componentProps` clobbering signal inputs (`useSetInputAPI: true`);
logout hanging ~25s on the Rust-crypto IndexedDB wipe (now backgrounded, with `init()`
gating re-login on it); unlock/verify presented as **modals** on the desktop layout;
**main-process notifications**; a **Discord-style login**; a **macOS signing + notarization**
scaffold; and an **Electron Playwright e2e** suite. See [ARCHITECTURE.md](ARCHITECTURE.md).

## 5. Key Risks (front-loaded)

- **WASM crypto in mobile WebViews** — ✅ CLEARED. Validated on Blink (Android/Electron)
  and WebKit (iOS) engines; required an asset/preload fix. See [SPIKE.md](SPIKE.md).
- **Background sync / push** — mobile OS background limits; rely on push-to-wake
  rather than persistent sockets.
- **SDK bundle size & change detection** — keep SDK off the zone where possible;
  throttle timeline updates.
- **iOS SSO/deep links & APNs setup** — requires Apple dev account + native config.

## 6. Deliverables of the Scaffold step

- Running Ionic app on web + at least one native target + Electron
- Verified WASM crypto init on all target platforms
- `MatrixClientService` connecting to a homeserver and logging in a test account
- Room list rendering live

## Environment

- Node v25.2.1, npm 11.6.2 (verified 2026-06-26)
- Working dir: /Users/quwisky/Projects/trinity-matrix-client
