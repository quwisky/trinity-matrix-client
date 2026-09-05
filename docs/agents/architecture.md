# Architecture

**Nx integrated monorepo.** The deployable app is `apps/trinity`; reusable code lives in `libs/*`,
imported via `@trinity/*` path aliases (`tsconfig.base.json`) and guarded by Nx module boundaries.
The web build emits to root `www/` (not `dist/`), which Capacitor and Electron wrap unchanged.

**Layering — dependencies point inward, enforced by `@nx/enforce-module-boundaries`** (`type:*` +
`scope:*` + `ui:*` tags in each `project.json`). The former monolithic `@trinity/core` was dissolved into
typed, per-domain libs (do **not** import `@trinity/core` — it no longer exists):

- `@trinity/util/matrix` `[type:util]` — pure, DI-free Matrix models/helpers (`MediaPayload`,
  `MatrixSession`, markdown/sanitize, `crypto-wasm-loader`, attachment-crypto). No Angular DI.
  Everything may depend on it. Render-ready message models belong to Conversations.
- `@trinity/runtime/projection` `[type:data-access]`, `[role:kernel]` — Projection Runtime: the
  bounded active-account, all-live-accounts, exact-account, and exact-conversation lifecycle
  primitive. It owns attachment, coalesced reconciliation, generation-safe publication, reset,
  scoped reattachment, finite readiness barriers, and resource diagnostics without owning product
  state or SDK types. Active Account switches use `transition(active-account)` to rebind and
  acknowledge every live account-scoped projection before the Workspace is repaired.
- `@trinity/application/runtime` `[type:feature]`, `[role:application]` — Application Runtime:
  ordered host, preference, Account, session-capability, Workspace, and readiness stages; typed
  executable blocked recovery and visible optional warnings; explicit recover/stop/restart; and one owned session-long
  stream for deep links, Back, route focus, badges, updates, and surface registration. Its deep
  provider interface owns concrete adapters and cross-capability bindings; the app entrypoint
  supplies routes, environment values and lazy loaders, then starts its lifetime subscription.
- `@trinity/application/appearance` `[type:data-access]`, `[role:application]` — Appearance:
  four installation-scoped Design System descriptors compose with Conversations' two code
  presentation descriptors as one read-only six-axis value and per-axis state. The projection
  delegates all hydration and persistence to Preferences Store; any partial hydration retains
  independent defaults/failures and reduces to one recoverable startup warning. A platform-neutral
  resolver combines committed values with system Mode; one cold effect lifetime owns the system
  source, document-root carrier adapter, and Mode-only native-chrome projection. Application
  Runtime starts that lifetime immediately after preference hydration, before Account and
  Workspace routing, and owns it until runtime stop. The Settings controller binds all six
  descriptor commands, keeps committed values visible through failed writes, offers per-control
  Retry, and recovers only failed hydration axes; it observes resolved Appearance but does not own
  the effect. No platform compatibility facade or direct document writer remains.
- `@trinity/runtime/host` `[type:platform]`, `[role:kernel]` — Host Capabilities: narrow operation
  contracts and explicit supported/unavailable manifests for authentication handoff, deep links,
  Back, file export, notification presentation, location, badges, secure storage, lifecycle, and
  updates. Product commands are cold finite Observables; Web, Capacitor, and Electron selection
  stays in the composition adapter.
- `@trinity/runtime/preferences` `[type:platform]`, `[role:kernel]` — Preferences Store: a
  policy-free typed descriptor catalog and context-keyed signal store. Capabilities own defaults,
  validation, migration, sensitivity, editor metadata, and explicit installation, Account,
  Conversation, or server-authoritative scope. Hydration and updates are cold finite Observables;
  ordered legacy keys are read-only and upgrade into the authoritative current envelope before
  publication. Adapters enforce storage/export policy and diagnostics never expose values.
- `@trinity/platform-native` `[type:platform]` — Capacitor/native capabilities (session/secure storage,
  the device-preference adapter, Appearance status-bar projection, launcher badge, external browser, desktop bridge, error handler). Branches on
  `isNativePlatform()` internally. May depend only on `util`.
- `@trinity/data-access/accounts` `[type:data-access]` — Account Runtime: read-only lifecycle state plus
  cold, finite restoration, authenticated-establishment, atomic switch, explicit Account sign-out,
  and installation-reset commands with Active Account priority, bounded per-Account outcomes,
  cancellation before commit, uninterruptible post-commit cleanup, joinable identical attempts,
  explicit lifecycle conflicts, and secret-safe failure metadata. Authentication crosses into it
  through an opaque grant; its production adapter composes session storage with Matrix Runtime.
- `@trinity/data-access/matrix-client` `[type:data-access]` — `MatrixClientService` + the 4S key service;
  the client/session foundation every domain data-access lib depends on, and the Matrix adapter for
  the first Projection Runtime tracer (per-Account sync state and readiness acknowledgement).
- `@trinity/data-access/*` `[type:data-access]` — capability and adapter libraries (`accounts`,
  `auth`, `discovery`, `gif`, `homeserver`, `identity`, `matrix-client`, `media`, `notifications`,
  `room-administration`, `room-library`, `timeline`, `trust`, `widgets`), each at
  `libs/data-access/<domain>`.
  Room Library owns room/space summaries, invitations, hierarchy, ordering, filtering and
  aggregate unread; its one-shot mutations, including account-scope and ordering persistence,
  favourite/priority writes, hierarchy changes and unread cleanup, are cold finite Observables.
  Room Administration owns authoritative joined-member and ban summaries, role classification and
  assignable presets, moderation, aliases,
  power-level policy, room configuration, and Conversation governance. Discovery owns remote
  homeserver, public-room, room-link and user-directory lookup; Global Search lives at
  `@trinity/application/search` and combines Discovery with Room Library. Cross-domain injects are
  explicit inter-lib edges (auth→accounts, notification→room-library/timeline, timeline→media).
- `@trinity/data-access/timeline` owns `ConversationRuntime` and Message Presentation: immutable
  Account-and-Room handles with one timeline child each, a two-entry per-Account retained LRU,
  permanent retirement, exact child-bound message search, a stable focused-timeline interface,
  and the Conversations privacy, code-size, and code-line presentation preference descriptors.
  Normalize SDK events first, then expose immutable `MessageView` models from this public
  entrypoint.
- `@trinity/feature/*` `[type:feature]` — screens/pages incl. `feature-shell` (the app shell moved out of
  `apps/trinity`). May depend on `data-access-*` + `ui` + `util` + `platform`, **never another feature**.
- `@trinity/components/{foundations,controls,generic-content,navigation-layout,overlay}`
  (`libs/components/*`) `[type:ui]`, tagged `ui:public` — the **public component tier**:
  five category-owned entrypoints plus the non-consumable Storybook host. It contains only
  domain-neutral Trinity APIs; every entrypoint uses named exports, and vendors remain behind
  those APIs. Product presentation such as the message toolbar and media bubble lives with
  Conversations under `feature/rooms`; application-surface loaders live in Application Runtime.
- `@trinity/util/ui` (`libs/util/ui`) `[type:util]` — the view-layer helpers that are not
  components: `runWithBusy`, `mediaQuerySignal` + the `MD_QUERY`/`BELOW_MD_QUERY` breakpoints,
  and `resolveInternalReturnTo`. DI-free like the rest of `type:util` — both helpers TAKE a
  `DestroyRef` rather than injecting one, so neither needs an injection context.
- `@trinity/helm/*` (`libs/spartan/*`) `[type:ui]`, tagged `ui:vendor-wrapper` — the vendored
  `@spartan-ng/cli`-generated kit, `hlm` prefix. Consume it through `@trinity/components/*`
  rather than directly.
  Both are **presentational** only; no state/SDK deps.
- **Third-party UI stops at the UI tier.** The `ui:*` tag splits it in two — `libs/components`
  is `ui:public`, the vendored kit is `ui:vendor-wrapper` — and `bannedExternalImports` keeps
  `@spartan-ng/brain`, `@angular/cdk`, `@ng-icons` and `@ctrl/ngx-emoji-mart` out of every
  tier below. Both UI tiers may name a vendor, because both ARE wrapper layers; what contains
  the public tier is the other direction, a `no-restricted-imports` ban stopping
  `libs/feature` and `apps` reaching past it into `@trinity/helm/*`. A new vendor import
  below the UI tier fails `pnpm lint`.
- **Scopes:** `scope:shared` (the kernel: util/platform/projection/matrix-client/ui/helm) may not reach into
  `scope:matrix` (domain data-access + feature libs); the thin `apps/trinity` composes both.

**The core rule: components never import `matrix-js-sdk` directly.** All SDK access is wrapped in the
`@trinity/data-access/*` services. New SDK interaction belongs there, not in a component. This keeps the
SDK swappable and the UI testable. A cross-feature dependency the boundary forbids (e.g. the encryption
banner needing crypto status) is resolved by reading the relevant `@trinity/data-access/*` signal from the
feature that owns the surface, or via an Application Runtime loader token
(`ENCRYPTION_DIALOG_COMPONENTS`, wired in `main.ts`) — never by importing the other feature.

**State pattern — the SDK is the single source of truth; there is no Redux store.** `matrix-js-sdk`
already owns rooms/timelines/crypto in memory + IndexedDB and emits events. Data-access services _project_
those `EventEmitter` streams into **read-only Angular signals** (`private writable → asReadonly() →
computed`); components are `OnPush` and read signals directly. **Async actions return cold RxJS
Observables** (`defer`/`from` + operators); components subscribe with `takeUntilDestroyed`. Signals =
state, Observables = one-shot actions. (Login pages wrap calls in `runWithBusy()` for busy/error state.)

**E2EE WASM loading — the single most important platform gotcha.** matrix-js-sdk resolves its
`.wasm` relative to bundled JS, which Angular's esbuild doesn't emit → 404. Fix: the build target
copies the file to `assets/crypto/`, and `crypto-wasm-loader.ts` calls `initAsync(url)` (memoized)
against that path **before** `initRustCrypto()`. Crypto-api types are a **deep import** —
`matrix-js-sdk/lib/crypto-api`, not re-exported from the package root (checked again in 42.x).

**Routing** — all lazy-loaded standalone routes in `apps/trinity/src/app/app.routes.ts`, most behind
`authGuard` (restores saved Accounts through Account Runtime or redirects to `/login`). On wide layouts the
`/encryption/*` routes are also presented as CDK dialogs. Production builds set
`optimization.styles.inlineCritical: false` — the deferred stylesheet `onload` never fires over
Electron's `trinity://` scheme, which broke the desktop dark theme.
