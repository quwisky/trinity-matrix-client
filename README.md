# Trinity

[![CI](https://github.com/quwisky/trinity-matrix-client/actions/workflows/ci.yml/badge.svg)](https://github.com/quwisky/trinity-matrix-client/actions/workflows/ci.yml)

A multiplatform [Matrix](https://matrix.org) client built with **Angular + spartan-ng**,
running from a single codebase on **Web (PWA), iOS, Android, and Desktop (Electron)**.
End-to-end encryption is a first-class, in-MVP feature.

> Status: **early development.** Scaffold, native platforms, the E2EE crypto spike,
> authentication (password + SSO, incl. native deep-link), a Discord-style room shell,
> and a working **timeline — read, send, edit, delete, react, reply, markdown,
> emoji, and GIFs** (KLIPY/GIPHY search, configured in Settings) — are done. **End-to-end encryption** is complete through device trust:
> crypto bootstrap (cross-signing, key backup, recovery) and **device verification**
> (emoji-SAS, with an incoming-request prompt). **Encrypted media** (M8 — sending and
> displaying images/files/video/audio with attachment encryption) and **MVP polish**
> (M9 — light/dark theme with selectable colour palettes, offline cache + PWA service worker,
> settings with profile and device management, authenticated avatars) are done. See
> [Project status](#project-status) below.

## Documentation

Everything lives under [`docs/`](docs/index.md), grouped by who is reading.

| Section                                              | What's in it                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Using Trinity](docs/users/index.md)                 | What the app can do, installing, signing in, encryption, messaging, settings       |
| [Contributing](docs/contributing/index.md)           | First run, the command reference, testing, CI and releases, conventions            |
| [Architecture](docs/architecture/index.md)           | Libraries and boundaries, the state pattern, Matrix and encryption, UI and theming |
| [Platforms](docs/platforms/index.md)                 | Web, the Electron desktop shell, and the Capacitor mobile targets                  |
| [Stack reference](docs/reference/stack.md)           | Pinned versions and the integration note for each dependency                       |
| [Troubleshooting](docs/reference/troubleshooting.md) | The gotcha index: symptom, cause, fix                                              |

## Tech stack

- **Monorepo:** Nx 23 (apps/libs, task graph + caching, enforced module boundaries)
- **UI:** Angular 22 (standalone components, signals) + **spartan-ng** — Brain
  (headless `@spartan-ng/brain`) + Helm (styled, copied into `libs/spartan/*`,
  aliased `@trinity/helm/*`) on **Tailwind CSS v4**
- **Native:** Capacitor 8 (iOS via SPM, Android) + a hand-rolled Electron desktop
  shell (`electron/`) for Windows/macOS/Linux
- **Protocol:** `matrix-js-sdk` 42
- **E2EE:** `@matrix-org/matrix-sdk-crypto-wasm` (Rust crypto / Vodozemac)
- **State:** Angular signals (UI state) + RxJS Observables (async service APIs)
- **Offline/PWA:** persistent IndexedDB sync store + Angular Service Worker
  (production web) precaching the app shell and crypto WASM
- **Testing:** Vitest (unit) + Playwright e2e (`@nx/playwright` app journeys +
  standalone crypto/protocol harnesses)
- **Quality gates:** ESLint (+ module boundaries), Prettier, Stylelint, and Husky
  hooks (lint-staged + commitlint / Angular commit convention), re-run on every PR
  (and on pushes to `develop`/`master`) by **GitHub Actions** — alongside the unit tests, the production build, the
  Electron main-process checks, and the Playwright e2e journeys (the badge above; see
  [CI and releases](docs/contributing/ci-and-releases.md))

Exact versions and gotchas live in the [stack reference](docs/reference/stack.md).

## Quick start

Requires **Node 24.15+** (what CI runs and the repo is developed on; 25.x is excluded — see the stack reference) and
**pnpm** (`corepack enable` picks up the pinned version in `package.json`).

```bash
pnpm install
pnpm start           # web dev server at http://localhost:4200
```

You'll land on `/login`. Enter a homeserver (e.g. `matrix.org`) to discover its login
flows, then sign in with a real account. The dev-only E2EE spike lives at `/spike`.

For native and full testing details see the [contributor docs](docs/contributing/index.md).

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
  util/
    matrix/           @trinity/util/matrix — pure DI-free Matrix models/helpers
                      (MessageView/MediaPayload/MatrixSession, markdown, wasm loader,
                      attachment crypto)  [type:util]
  testing/            @trinity/testing — the zoneless render() wrapper every
                      component spec must use  [type:util]
  platform-native/    @trinity/platform-native — Capacitor/native capabilities
                      (session/secure storage, preferences, theme/status-bar, launcher
                      badge, desktop bridge, error handler)  [type:platform]
  data-access/
    matrix-client/    @trinity/data-access/matrix-client — MatrixClient lifecycle +
                      4S key service; the client/session foundation  [type:data-access]
    */                @trinity/data-access/{media,rooms,timeline,crypto,profile,invites,
                      pinned,search,notifications,auth,gif} — one lib per Matrix domain
                      (read models + write actions + guards)  [type:data-access]
  feature/
    shell/            @trinity/feature/shell — app shell (AppComponent, verification
                      host, nav-focus) + the dev-only /spike page  [type:feature]
    auth/             @trinity/feature/auth — login + SSO callback  [type:feature]
    rooms/            @trinity/feature/rooms — Discord-style shell (server rail =
                      Spaces, channel list, members) + message timeline (list,
                      composer + emoji picker, hover toolbar, reactions, replies,
                      encrypted media) + encryption/offline banners  [type:feature]
    crypto/           @trinity/feature/crypto — encryption setup + recovery pages
                      + device-verification (emoji SAS)  [type:feature]
    settings/         @trinity/feature/settings — Settings page: appearance
                      (light/dark/system theme), profile (name + avatar), and
                      device management (sign-out/verify)  [type:feature]
  ui/                 @trinity/ui — reusable presentational components (avatar +
                      mxc resolver token, banner, page header, media bubble,
                      message toolbar, encryption-dialog service); may use
                      @trinity/helm/* + @trinity/util/* but no data-access/state deps  [type:ui]
  spartan/*           @trinity/helm/* — styled spartan-ng Helm components over
                      headless Brain primitives (button, input, card, overlay,
                      dropdown-menu, …), generated via @spartan-ng/cli  [type:ui]
e2e/playwright/     @nx/playwright app-journey specs (run: nx e2e trinity-e2e)
e2e/                  standalone crypto/protocol harnesses (serve www/)
android/ ios/         Capacitor native projects (webDir: www)
www/                  web build output
```

Boundaries are enforced by `@nx/enforce-module-boundaries` on two independent axes,
`type:` and `scope:`, with no exceptions configured. Dependencies point inward —
`app → feature → {data-access, ui} → {util, platform}` — and one feature may never
import another. `ui` is presentational only and cannot reach a data-access lib at all.
A library is named three different ways and they no longer coincide: the directory
(`libs/data-access/rooms`), the import alias (`@trinity/data-access/rooms`) and the Nx
project name (`data-access-rooms`). Commands take the project name — `nx test
data-access-rooms` — while imports take the alias.

New shared libs are added when first needed, under the parent for their layer. Each
component/page lives in its own directory
(`name/name.component.ts` + `.html`/`.scss`/`.spec.ts`). See
[the architecture docs](docs/architecture/index.md) for the rationale and data flow.

## Project status

| Milestone                                        | State                                                                                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Scaffold + crypto WASM spike                 | ✅ Done — E2EE validated on Blink + WebKit                                                                                                                                                         |
| 2 — Auth (discovery, password, SSO, logout)      | ✅ Done — flow verified headlessly                                                                                                                                                                 |
| 3 — Crypto bootstrap (cross-signing, key backup) | ✅ Done — core services + setup/recovery UI and a non-blocking `/rooms` banner                                                                                                                     |
| 4 — Sync & room list                             | ✅ Done — live rooms, recency ordering, unread badges, encryption lock                                                                                                                             |
| 5 — Timeline (read)                              | ✅ Done — decrypted messages, markdown, auto-paginating history                                                                                                                                    |
| 6 — Compose (send)                               | ✅ Done — send/edit/delete, reactions, replies, emoji, local echo + retry                                                                                                                          |
| 7 — Device verification UI                       | ✅ Done — emoji SAS, self and cross-user (QR deferred)                                                                                                                                             |
| 8 — Media                                        | ✅ Done — display + send (image/file/video/audio), AES-CTR attachment crypto in-tree, server thumbnails + duration/dimension probing, native Camera picker + Filesystem/Share save (web fallbacks) |
| 9 — MVP polish                                   | ✅ Done — light/dark/system theme (+ native status bar), offline sync cache + web/PWA service worker, Settings (profile + device management), authenticated avatars                                |

A current capability list, including what is deliberately not supported yet, is in
[Using Trinity](docs/users/index.md).

## Known limitations (current)

- No credentialed login test against a _public_ homeserver yet (the matrix.org
  `smoke:login` check is unauthenticated). The credentialed path is covered end-to-end
  against a disposable local Synapse — the Playwright app journeys run in CI on every PR, and the standalone `e2e:verify` SAS round-trip (verified 2026-06-27) is still
  run by hand.
- Native SSO deep link (`eu.qwky.trinity://sso-callback`) is implemented end-to-end —
  system-browser login, the custom scheme registered on iOS/Android, warm + cold-start
  (`getLaunchUrl`) handling, and a single-use `state` nonce checked on the callback — but
  has not yet been exercised on a physical device against a real SSO provider.
- Session token stored via Preferences, not yet hardware-backed secure storage.

## License

TBD.
