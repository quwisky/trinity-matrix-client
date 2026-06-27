# Trinity — Implementation Plan

A multiplatform Matrix client built with **Ionic + Angular**, deployed to Web (PWA),
iOS, Android, and Desktop (Electron) from a single Angular codebase.

## Confirmed Decisions

- **Desktop:** Electron — reuses the web build; dedicated packaging config + milestone.
- **E2EE:** In MVP — WASM crypto spike moves into scaffold; crypto store + device
  verification are first-class MVP milestones (not phase 2).
- **Testing:** Vitest (unit) + Playwright (e2e).
- **State management:** signal-store services (no NgRx) — `matrix-js-sdk` is the
  source of truth. Revisit `@ngrx/signals` (SignalStore) for optimistic sends /
  persisted selection. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#state-management).

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

- Push notifications (FCM/APNs via Capacitor; sygnal / UnifiedPush)
- Threads (edits, redactions, reactions, and replies landed early, in MVP)
- Voice/video calls (WebRTC / Element Call style)
- Spaces, room creation/invites, search

## 2. Tech Stack

Pinned versions and integration notes live in [STACK.md](STACK.md).

| Concern         | Choice (version @ 2026-06-26)                                                                 | Rationale                                         |
| --------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| UI framework    | Ionic `@ionic/angular` 8.8.12 + Angular 20 (standalone, signals)                              | Cross-platform UI, native feel                    |
| Native bridge   | Capacitor 8.4.1                                                                               | iOS/Android/Web; SPM on iOS, edge-to-edge Android |
| Desktop         | Electron via `@capacitor-community/electron` 5.0.1                                            | Reuses web build                                  |
| Matrix protocol | `matrix-js-sdk` 41.8.0 (needs Node 22+)                                                       | Official; handles sync/E2EE/crypto                |
| Crypto          | `@matrix-org/matrix-sdk-crypto-wasm` 18.3.1 (Rust crypto)                                     | Modern E2EE backend                               |
| State           | Angular signals for state (read-only from services) + RxJS Observables for async service APIs | Reactive UI; cancellable async flows              |
| Storage         | IndexedDB (sync + crypto store) via SDK; Capacitor Preferences for tokens                     | Persistent offline cache                          |
| Styling         | Ionic components + CSS variables (theming/dark mode)                                          |                                                   |
| Testing         | Vitest (Analog plugin, run via Nx) + Playwright (e2e)                                         |                                                   |

> Note: `matrix-js-sdk` is browser-oriented and runs under Capacitor's WebView.
> E2EE uses Rust crypto via WASM — loading must be validated on iOS/Android WebViews
> and Electron early (known risk area).

## 3. Architecture

> Layout note: the repo is now an **Nx monorepo**. The module map below is the logical
> design (parts still planned); physically it maps to `apps/trinity` (app shell) and
> `libs/` — `core/*` lives in `@trinity/core` (`libs/core/src/lib/…`) and each
> `features/*` becomes a `@trinity/feature-*` lib. See
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the implemented structure.

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
   See [docs/CRYPTO-BOOTSTRAP-PLAN.md](docs/CRYPTO-BOOTSTRAP-PLAN.md).
4. **Sync & room list** — start client with crypto enabled, render rooms
   (names/avatars/unread), live updates, encryption indicators.
5. **Timeline (read)** — ✅ render decrypted messages (markdown), backward pagination
   with auto-backfill, read receipts, "unable to decrypt" fallback UI.
6. **Compose (send)** — ✅ send text/markdown (+ emoji picker) with optimistic local
   echo + retry; edit (`m.replace`), delete (redact), reactions (`m.annotation`), and
   replies (`m.in_reply_to`) via a hover toolbar / Up-arrow shortcut.
7. **Device verification UI** — emoji SAS / QR verification flows.
8. **Media** — encrypted media upload/display (Capacitor Camera/Filesystem).
9. **MVP polish** — dark mode, offline cache, settings/profile, device management.

Phase 2: push notifications, threads, calls, spaces.

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
- Working dir: /Users/quwisky/Projects/matrix (empty, not a git repo)
