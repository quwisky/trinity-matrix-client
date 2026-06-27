# Trinity

[![status-badge](https://crow.qwky.eu/api/v1/badges/2/status.svg)](https://crow.qwky.eu/repos/2)

A multiplatform [Matrix](https://matrix.org) client built with **Ionic + Angular**,
running from a single codebase on **Web (PWA), iOS, Android, and Desktop (Electron)**.
End-to-end encryption is a first-class, in-MVP feature.

> Status: **early development.** Scaffold, native platforms, the E2EE crypto spike,
> authentication, a Discord-style room shell, and a working **timeline — read, send,
> edit, delete, react, reply, markdown, and emoji** — are done. **Crypto bootstrap**
> (cross-signing, key backup, recovery) is now complete end to end — core services plus
> the setup/recovery UI and a non-blocking `/rooms` encryption banner. Device-to-device
> verification (emoji SAS / QR) is next. See [Project status](#project-status) below.

## Documentation

| Doc                                          | What's in it                                             |
| -------------------------------------------- | -------------------------------------------------------- |
| [PLAN.md](PLAN.md)                           | Roadmap, milestones, scope, decisions, risks             |
| [STACK.md](STACK.md)                         | Pinned versions + integration notes for every dependency |
| [SPIKE.md](SPIKE.md)                         | E2EE crypto WASM validation results (the gating risk)    |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the code is organized and how data flows             |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)   | Setup, running, testing, troubleshooting                 |
| [docs/REVIEW.md](docs/REVIEW.md)             | Whole-codebase review findings (2026-06-27)              |

## Tech stack

- **Monorepo:** Nx 23 (apps/libs, task graph + caching, enforced module boundaries)
- **UI:** Ionic 8 + Angular 20 (standalone components, signals)
- **Native:** Capacitor 8 (iOS via SPM, Android) + Electron (planned) for desktop
- **Protocol:** `matrix-js-sdk` 41
- **E2EE:** `@matrix-org/matrix-sdk-crypto-wasm` (Rust crypto / Vodozemac)
- **State:** Angular signals (UI state) + RxJS Observables (async service APIs)
- **Testing:** Vitest (unit) + Playwright-driven headless checks
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

| Command                             | Purpose                                                       |
| ----------------------------------- | ------------------------------------------------------------- |
| `pnpm start`                        | Web dev server (hot reload) at `:4200`                        |
| `pnpm build`                        | Production web build into `www/`                              |
| `pnpm test`                         | Vitest unit tests (`nx run-many -t test` for all projects)    |
| `pnpm lint`                         | ESLint + Nx module boundaries                                 |
| `pnpm stylelint`                    | Stylelint (SCSS)                                              |
| `pnpm format`                       | Prettier-format the workspace                                 |
| `pnpm smoke:login`                  | Headless: redirect→login + real matrix.org discovery          |
| `pnpm spike:chromium`               | Headless E2EE WASM check (Blink → Android WebView / Electron) |
| `pnpm spike:webkit`                 | Headless E2EE WASM check (WebKit → iOS WKWebView)             |
| `pnpm exec cap run ios` / `android` | Build + launch on simulator/emulator                          |

## Project structure

Nx integrated monorepo: the deployable app lives in `apps/`, reusable code in
`libs/` (consumed through `@trinity/*` path aliases and guarded by Nx module
boundaries). The web build still emits to root `www/`, so Capacitor and the
native projects are unchanged.

```
apps/trinity/
  src/                app shell (main, routes, AppComponent, theme, environments,
                      assets) + the dev-only /spike page
  project.json        build/serve/test targets (Angular esbuild builder)
  vite.config.ts      Vitest setup (Analog Angular plugin)
libs/
  core/               @trinity/core  — MatrixClient lifecycle, auth, RoomsService
                      read model, crypto loader, session model, storage, authGuard
                      [type:core]
  feature-auth/       @trinity/feature-auth — login + SSO callback  [type:feature]
  feature-rooms/      @trinity/feature-rooms — Discord-style shell (server rail =
                      Spaces, channel list, members) + message timeline (list,
                      composer + emoji picker, hover toolbar, reactions, replies)
                      + encryption banner, wired to synced rooms  [type:feature]
  feature-crypto/     @trinity/feature-crypto — encryption setup + recovery pages
                      with one-time recovery-key display  [type:feature]
  ui/                 @trinity/ui — reusable presentational components (avatar,
                      emoji picker, message toolbar); no core/state deps  [type:ui]
e2e/                  headless validation harnesses (serve www/)
android/ ios/         Capacitor native projects (webDir: www)
www/                  web build output
```

Boundaries: features may depend on `core` and `ui`; `ui` is presentational-only
(no `core`/state deps); `core` depends on nothing; the app may depend on anything.
New shared chat / settings libs are added when first needed. Each component/page lives in its own directory
(`name/name.component.ts` + `.html`/`.scss`/`.spec.ts`). See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the rationale and data flow.

## Project status

| Milestone                                        | State                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| 1 — Scaffold + crypto WASM spike                 | ✅ Done — E2EE validated on Blink + WebKit ([SPIKE.md](SPIKE.md))              |
| 2 — Auth (discovery, password, SSO, logout)      | ✅ Done — flow verified headlessly                                             |
| 3 — Crypto bootstrap (cross-signing, key backup) | ✅ Done — core services + setup/recovery UI and a non-blocking `/rooms` banner |
| 4 — Sync & room list                             | ✅ Done — live rooms, recency ordering, unread badges, encryption lock         |
| 5 — Timeline (read)                              | ✅ Done — decrypted messages, markdown, auto-paginating history                |
| 6 — Compose (send)                               | ✅ Done — send/edit/delete, reactions, replies, emoji, local echo + retry      |
| 7 — Device verification UI                       | ⬜                                                                             |
| 8 — Media                                        | ⬜                                                                             |
| 9 — MVP polish                                   | ⬜                                                                             |

Full breakdown in [PLAN.md](PLAN.md).

## Known limitations (current)

- No credentialed end-to-end login test yet (needs a test account).
- Native SSO deep link (`eu.qwky.trinity://sso-callback`) is stubbed, not implemented.
- Session token stored via Preferences, not yet hardware-backed secure storage.

## License

TBD.
