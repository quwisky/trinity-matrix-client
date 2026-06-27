---
name: architecture-overview
description: Trinity Matrix client — Nx + Angular 20 + Ionic 8 standalone, feature-lib conventions, where state/data live
metadata:
  type: project
---

Trinity is an Nx workspace (Nx 23.0.1, pnpm) building a Discord-style Matrix client with Angular 20.3 + Ionic 8 (standalone components) + Capacitor 8.

**Why:** Matrix chat client; `@trinity/core` wraps matrix-js-sdk 41.x so UI never touches the SDK directly.
**How to apply:** Match these conventions when designing/extending UI.

Library layout (`libs/`):
- `core` (`@trinity/core`, tags `["type:core","scope:trinity"]`) — all matrix-js-sdk wrapping. Services are `@Injectable({providedIn:'root'})`, expose read-only `signal()`s + an idempotent `connect()` that bridges SDK events → signals, and cold `Observable`s for one-shot actions (errors thrown as `Error` with user-facing messages). Services: `MatrixClientService` (owns single client + lifecycle: createClient→preloadCryptoWasm→initRustCrypto→startClient, idempotent `init()` tears down first), `RoomsService`, `TimelineService` (one active room at a time), `AuthService`, `CryptoService` (4S/cross-signing/backup bootstrap+recovery, generation-token guard on computeStatus), `SecretStorageKeyService` (in-mem 4S key), `SessionStorageService` (Capacitor Preferences), `CryptoSpikeService` (M1 dev smoke test — STILL exported from barrel, dev-only). `authGuard` does lazy one-time session restore. All re-exported from `libs/core/src/index.ts` (flat barrel, ~11 exports).
- `feature-auth` (`@trinity/feature-auth`) — login + sso-callback pages behind `authGuard`. NO tests (no vite.config/test-setup/tsconfig.spec/test target). Uses a local `withBusy()` helper (busy+error signals) duplicated per page.
- `feature-rooms` (`@trinity/feature-rooms`) — the authed Discord-style shell (~31 files, ~2800 LOC): rooms.page (shell), server-rail, channel-sidebar, member-list, message-list, message-composer, message-reactions, message-toolbar, emoji-picker, avatar, encryption-banner. HAS full Vitest setup.
- `feature-crypto` (`@trinity/feature-crypto`) — encryption-setup + encryption-unlock pages + recovery-key-display. HAS Vitest setup.
- KNOWN SMELL: `EncryptionBannerComponent` lives in feature-rooms (not feature-crypto) only because `type:feature`→`type:feature` is banned by module boundaries. Points to a missing `type:ui`/`shared` layer.
- All feature libs: `projectType: library`, `prefix: trn`, tags `["type:feature","scope:trinity"]`, only `tsconfig.json` (lib, identical 3-field shape) + `tsconfig.spec.json` (no tsconfig.lib.json). Path aliases in `tsconfig.base.json`.
- CONFIG DRIFT: feature-rooms/feature-crypto vite.config use `tsconfigPaths({projects:['tsconfig.base.json']})` to resolve @trinity aliases in specs; core's omits `projects` (works only because core has no @trinity imports). All test targets are hand-written `nx:run-commands` running `vitest run` with cwd — no `@nx/vite:test` executor, no inputs/outputs/cache config.

Component conventions:
- Standalone, `ChangeDetectionStrategy.OnPush`, `selector: 'trn-*'`, `inject()` for DI, signals for all state, `input()`/`output()` for component IO.
- Pages = `*.page.ts` (route targets, inject services); reusable = `*.component.ts`. Small components use inline `template`; larger ones use `templateUrl`+`styleUrl(s)` separate `.html`/`.scss`. No SCSS file unless styling is needed (login.page has none).
- Observables subscribed via `.pipe(takeUntilDestroyed(this.destroyRef))`; shared busy/error handled with a `withBusy()` helper (busy + error signals, catchError→EMPTY, finalize). Navigation via `Router.navigateByUrl(..., {replaceUrl:true})`.
- Theming: CSS custom properties from `apps/trinity/src/theme/variables.scss` — `--trinity-rail/sidebar/chat/hover/active/divider`, `--trinity-text(-muted/-bright)`, `--trinity-accent(-hover)`, `--trinity-green`, `--trinity-radius`. Ionic primary is mapped onto blurple. Use these tokens, do not invent.

Routing: `apps/trinity/src/app/app.routes.ts`, all lazy via `loadComponent: () => import('@trinity/...')`. Authed routes use `canActivate: [authGuard]`.

State/data: no global store library; signals on root services are the shared state. Data fetching/caching lives in `@trinity/core` services. CSR only (Ionic SPA, Capacitor) — no SSR/SSG.

Testing: Vitest + Angular TestBed, `@analogjs/vite-plugin-angular`. test-setup at `src/test-setup.ts` (initTestEnvironment). Component specs: `TestBed.configureTestingModule({imports:[Component]})`, `setInput()` for inputs, `.subscribe()` on outputs, query `nativeElement`. Core-service specs: provide a hand-rolled fake of the SDK surface via `{provide: MatrixClientService, useValue: fake}`. Ionic web components need `server.deps.inline: [/@ionic/, /ionicons/]` in vite.config. No `@nx/vite:test` executor — test target is `nx:run-commands` running `vitest run` with `cwd` set to the lib.

Capacitor deps present: app, haptics, keyboard, status-bar, preferences. NO `@capacitor/filesystem` — file download must be a web Blob+anchor, not native FS.
