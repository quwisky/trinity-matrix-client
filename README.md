# Trinity

[![status-badge](https://crow.qwky.eu/api/v1/badges/2/status.svg)](https://crow.qwky.eu/repos/2)

A multiplatform [Matrix](https://matrix.org) client built with **Angular + spartan-ng**,
running from a single codebase on **Web (PWA), iOS, Android, and Desktop (Electron)**.
End-to-end encryption is a first-class, in-MVP feature.

> Status: **early development.** Scaffold, native platforms, the E2EE crypto spike,
> authentication (password + SSO, incl. native deep-link), a Discord-style room shell,
> and a working **timeline — read, send, edit, delete, react, reply, markdown, and
> emoji** — are done. **End-to-end encryption** is complete through device trust:
> crypto bootstrap (cross-signing, key backup, recovery) and **device verification**
> (emoji-SAS, with an incoming-request prompt). **Encrypted media** (M8 — sending and
> displaying images/files/video/audio with attachment encryption) and **MVP polish**
> (M9 — light/dark theme, offline cache + PWA service worker, settings with profile and
> device management, authenticated avatars) are done. See [Project status](#project-status) below.

## Documentation

| Doc                                          | What's in it                                             |
| -------------------------------------------- | -------------------------------------------------------- |
| [PLAN.md](PLAN.md)                           | Roadmap, milestones, scope, decisions, risks             |
| [STACK.md](STACK.md)                         | Pinned versions + integration notes for every dependency |
| [SPIKE.md](SPIKE.md)                         | E2EE crypto WASM validation results (the gating risk)    |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the code is organized and how data flows             |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)   | Setup, running, testing, troubleshooting                 |
| [docs/PUSH.md](docs/PUSH.md)                 | Push notifications: architecture + native/gateway setup  |
| [docs/REVIEW.md](docs/REVIEW.md)             | Whole-codebase review findings (2026-06-27)              |

## Tech stack

- **Monorepo:** Nx 23 (apps/libs, task graph + caching, enforced module boundaries)
- **UI:** Angular 21 (standalone components, signals) + **spartan-ng** — Brain
  (headless `@spartan-ng/brain`) + Helm (styled, copied into `libs/spartan/*`,
  aliased `@trinity/helm/*`) on **Tailwind CSS v4**
- **Native:** Capacitor 8 (iOS via SPM, Android) + a hand-rolled Electron desktop
  shell (`electron/`) for Windows/macOS/Linux
- **Protocol:** `matrix-js-sdk` 41
- **E2EE:** `@matrix-org/matrix-sdk-crypto-wasm` (Rust crypto / Vodozemac)
- **State:** Angular signals (UI state) + RxJS Observables (async service APIs)
- **Offline/PWA:** persistent IndexedDB sync store + Angular Service Worker
  (production web) precaching the app shell and crypto WASM
- **Testing:** Vitest (unit) + Playwright e2e (`@nx/playwright` app journeys +
  standalone crypto/protocol harnesses)
- **Quality gates:** ESLint (+ module boundaries), Prettier, Stylelint, and Husky
  hooks (lint-staged + commitlint / Angular commit convention), re-run on every
  push/PR by **Crow CI** (the badge above; see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#continuous-integration))

Exact versions and gotchas live in [STACK.md](STACK.md).

## Quick start

Requires **Node 22+** (matrix-js-sdk requirement; repo developed on Node 25) and
**pnpm** (`corepack enable` picks up the pinned version in `package.json`).

```bash
pnpm install
pnpm start           # web dev server at http://localhost:4200
```

You'll land on `/login`. Enter a homeserver (e.g. `matrix.org`) to discover its login
flows, then sign in with a real account. The dev-only E2EE spike lives at `/spike`.

For native and full testing details see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Common commands

| Command                             | Purpose                                                        |
| ----------------------------------- | -------------------------------------------------------------- |
| `pnpm start`                        | Web dev server (hot reload) at `:4200`                         |
| `pnpm build`                        | Production web build into `www/`                               |
| `pnpm test`                         | Vitest unit tests (`nx run-many -t test` for all projects)     |
| `pnpm lint`                         | ESLint + Nx module boundaries                                  |
| `pnpm stylelint`                    | Stylelint (SCSS)                                               |
| `pnpm format`                       | Prettier-format the workspace                                  |
| `pnpm smoke:login`                  | Headless: redirect→login + real matrix.org discovery           |
| `pnpm spike:chromium`               | Headless E2EE WASM check (Blink → Android WebView / Electron)  |
| `pnpm spike:webkit`                 | Headless E2EE WASM check (WebKit → iOS WKWebView)              |
| `pnpm e2e:verify`                   | Two-client emoji-SAS device verification (needs Docker)        |
| `pnpm exec nx e2e trinity-e2e`      | Playwright app journeys: login, settings, theme (needs Docker) |
| `pnpm exec cap run ios` / `android` | Build + launch on simulator/emulator                           |

## Project structure

Nx integrated monorepo: the deployable app lives in `apps/`, reusable code in
`libs/` (consumed through `@trinity/*` path aliases and guarded by Nx module
boundaries). The web build still emits to root `www/`, so Capacitor and the
native projects are unchanged.

```
apps/trinity/
  src/                thin app entry: main bootstrap + providers, root routes,
                      theme, environments (the shell UI lives in feature-shell)
  project.json        build/serve/test targets (Angular esbuild builder)
  vite.config.ts      Vitest setup (Analog Angular plugin)
libs/
  util-matrix/        @trinity/util-matrix — pure DI-free Matrix models/helpers
                      (MessageView/MediaPayload/MatrixSession, markdown, wasm loader,
                      attachment crypto)  [type:util]
  platform-native/    @trinity/platform-native — Capacitor/native capabilities
                      (session/secure storage, preferences, theme/status-bar, launcher
                      badge, desktop bridge, error handler)  [type:platform]
  data-access-matrix-client/
                      @trinity/data-access-matrix-client — MatrixClient lifecycle +
                      4S key service; the client/session foundation  [type:data-access]
  data-access-*/      @trinity/data-access-{media,rooms,timeline,crypto,profile,invites,
                      pinned,search,notifications,auth} — one lib per Matrix domain
                      (read models + write actions + guards)  [type:data-access]
  feature-shell/      @trinity/feature-shell — app shell (AppComponent, verification
                      host, nav-focus) + the dev-only /spike page  [type:feature]
  feature-auth/       @trinity/feature-auth — login + SSO callback  [type:feature]
  feature-rooms/      @trinity/feature-rooms — Discord-style shell (server rail =
                      Spaces, channel list, members) + message timeline (list,
                      composer + emoji picker, hover toolbar, reactions, replies,
                      encrypted media) + encryption/offline banners  [type:feature]
  feature-crypto/     @trinity/feature-crypto — encryption setup + recovery pages
                      + device-verification (emoji SAS)  [type:feature]
  feature-settings/   @trinity/feature-settings — Settings page: appearance
                      (light/dark/system theme), profile (name + avatar), and
                      device management (sign-out/verify)  [type:feature]
  ui/                 @trinity/ui — reusable presentational components (avatar +
                      mxc resolver token, banner, page header, media bubble,
                      message toolbar, encryption-dialog service); may use
                      @trinity/helm/* + @trinity/util-* but no data-access/state deps  [type:ui]
  spartan/*           @trinity/helm/* — styled spartan-ng Helm components over
                      headless Brain primitives (button, input, card, overlay,
                      dropdown-menu, …), generated via @spartan-ng/cli  [type:ui]
e2e/playwright/     @nx/playwright app-journey specs (run: nx e2e trinity-e2e)
e2e/                  standalone crypto/protocol harnesses (serve www/)
android/ ios/         Capacitor native projects (webDir: www)
www/                  web build output
```

Boundaries: features may depend on `core`, `ui`, and the Helm UI libs
(`@trinity/helm/*`); `ui` is presentational-only (may use `@trinity/helm/*`, no
`core`/state deps); `core` depends on nothing; the app may depend on anything.
New shared libs are added when first needed. Each component/page lives in its own directory
(`name/name.component.ts` + `.html`/`.scss`/`.spec.ts`). See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the rationale and data flow.

## Project status

| Milestone                                        | State                                                                                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Scaffold + crypto WASM spike                 | ✅ Done — E2EE validated on Blink + WebKit ([SPIKE.md](SPIKE.md))                                                                                                                                  |
| 2 — Auth (discovery, password, SSO, logout)      | ✅ Done — flow verified headlessly                                                                                                                                                                 |
| 3 — Crypto bootstrap (cross-signing, key backup) | ✅ Done — core services + setup/recovery UI and a non-blocking `/rooms` banner                                                                                                                     |
| 4 — Sync & room list                             | ✅ Done — live rooms, recency ordering, unread badges, encryption lock                                                                                                                             |
| 5 — Timeline (read)                              | ✅ Done — decrypted messages, markdown, auto-paginating history                                                                                                                                    |
| 6 — Compose (send)                               | ✅ Done — send/edit/delete, reactions, replies, emoji, local echo + retry                                                                                                                          |
| 7 — Device verification UI                       | ✅ Done — emoji SAS self-verification (QR / cross-user deferred)                                                                                                                                   |
| 8 — Media                                        | ✅ Done — display + send (image/file/video/audio), AES-CTR attachment crypto in-tree, server thumbnails + duration/dimension probing, native Camera picker + Filesystem/Share save (web fallbacks) |
| 9 — MVP polish                                   | ✅ Done — light/dark/system theme (+ native status bar), offline sync cache + web/PWA service worker, Settings (profile + device management), authenticated avatars                                |

Full breakdown in [PLAN.md](PLAN.md).

## Known limitations (current)

- No credentialed login test against a _public_ homeserver yet (the matrix.org
  `smoke:login` check is unauthenticated). The credentialed path is covered end-to-end
  by `e2e:verify` against a disposable local Synapse (live SAS round-trip verified
  2026-06-27); it is not yet wired into CI.
- Native SSO deep link (`eu.qwky.trinity://sso-callback`) is implemented end-to-end —
  system-browser login, the custom scheme registered on iOS/Android, warm + cold-start
  (`getLaunchUrl`) handling, and a single-use `state` nonce checked on the callback — but
  has not yet been exercised on a physical device against a real SSO provider.
- Session token stored via Preferences, not yet hardware-backed secure storage.

## License

TBD.
