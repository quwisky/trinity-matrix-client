# Development guide

Setup, running, testing, and troubleshooting. Architecture is in
[ARCHITECTURE.md](ARCHITECTURE.md); roadmap in [../PLAN.md](../PLAN.md).

## Workspace layout

Trinity is an **Nx integrated monorepo** (pnpm). The deployable app lives in
`apps/`, reusable code in `libs/` (imported via `@trinity/*` path aliases and
guarded by Nx module boundaries). Projects:

| Project            | Path                    | Notes                                                                                                                                            |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `trinity`          | `apps/trinity`          | the Ionic/Angular app (build, serve, test) `[type:app]`                                                                                          |
| `core`             | `libs/core`             | `@trinity/core` — Matrix services, storage, guard `[type:core]`                                                                                  |
| `feature-auth`     | `libs/feature-auth`     | `@trinity/feature-auth` — login + SSO callback `[type:feature]`                                                                                  |
| `feature-rooms`    | `libs/feature-rooms`    | `@trinity/feature-rooms` — room shell + message timeline `[type:feature]`                                                                        |
| `feature-crypto`   | `libs/feature-crypto`   | `@trinity/feature-crypto` — encryption setup/recovery + device verification `[type:feature]`                                                     |
| `feature-settings` | `libs/feature-settings` | `@trinity/feature-settings` — settings: appearance (theme), profile, device management `[type:feature]`                                          |
| `ui`               | `libs/ui`               | `@trinity/ui` — reusable presentational components (avatar + `AVATAR_RESOLVER` token, emoji picker, message toolbar) + `runWithBusy` `[type:ui]` |

The web build still emits to root `www/`, so Capacitor and the native projects
are unchanged. `pnpm exec nx graph` opens the dependency graph.

## Prerequisites

- **Node 22+** (matrix-js-sdk requirement; repo developed on Node 25) and **pnpm**
  (`corepack enable` installs the version pinned in `package.json`). This project is
  **pnpm-only** — a `preinstall` guard aborts `npm install` / `yarn install`.
- **iOS builds:** macOS with **Xcode** installed and selected
  (`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`). Capacitor 8
  uses Swift Package Manager — CocoaPods not required.
- **Android builds:** Android SDK (easiest via Android Studio). Export
  `ANDROID_HOME="$HOME/Library/Android/sdk"`. `android/local.properties` must point
  `sdk.dir` at it.

```bash
pnpm install
```

> pnpm blocks dependency build scripts by default. The ones this project needs
> (`esbuild`, `@parcel/watcher`, `lmdb`, `msgpackr-extract`, `@swc/core`, `nx`) are
> allowlisted under `pnpm.onlyBuiltDependencies` in `package.json`, so they build on
> install. Installing also runs the `prepare` script, which activates the Husky git
> hooks (see [Code quality](#code-quality--git-hooks)).

## Running on the web

```bash
pnpm start         # nx serve trinity → http://localhost:4200, hot reload
```

- Unauthenticated, you land on `/login`. Enter a homeserver (`matrix.org`), then sign
  in with a real account.
- E2EE spike UI: `http://localhost:4200/spike` → "Run crypto spike".
- **Reset local state:** DevTools → Application → clear localStorage + IndexedDB,
  then reload. (Session lives in Preferences/localStorage; crypto store in IndexedDB.)

## Running on device / simulator

Each `pnpm` script below builds the web app (`www/`), `cap sync`s it into the native
project, then runs/opens/builds. `export ANDROID_HOME="$HOME/Library/Android/sdk"` first
for Android.

```bash
pnpm android:run      # build → sync → run on an emulator/device (Android SDK)
pnpm android:open     # open Android Studio
pnpm android:sync     # build → cap sync android only

pnpm ios:run          # build → sync → run on a simulator (macOS + Xcode)
pnpm ios:open         # open Xcode
pnpm ios:sync         # build → cap sync ios only
```

### Build artifacts

```bash
pnpm android:build            # debug APK → android/app/build/outputs/apk/debug/
pnpm android:build:release    # release AAB (needs a signing keystore — see below)
pnpm ios:build                # cap build ios --scheme App (macOS + Xcode + signing)
```

- **Android** needs the Android SDK; `android:build` (gradlew `assembleDebug`) is
  debug-signed and works out of the box. `android:build:release` (`bundleRelease`)
  needs a release keystore wired into `android/` signing config (`keystore.properties`
  / Gradle signingConfigs) — not committed.
- **iOS** builds **only on macOS with Xcode** and a signing identity (Apple Developer
  account / provisioning); `ios:build` uses `cap build ios`. For an unsigned simulator
  build, use `ios:open` and build/run from Xcode.

After **every** web-code change, re-run a `*:sync` (or `pnpm exec cap copy` when only web
assets changed) to push it into the shells.

## Nx tasks

Run a target on a project with `pnpm exec nx <target> <project>`; the top-level
`pnpm` scripts wrap the common ones for the `trinity` app:

| Command       | Underlying              | Purpose                                  |
| ------------- | ----------------------- | ---------------------------------------- |
| `pnpm start`  | `nx serve trinity`      | dev server, hot reload                   |
| `pnpm build`  | `nx build trinity`      | production build → `www/`                |
| `pnpm test`   | `nx run-many -t test`   | Vitest unit tests, all projects (once)   |
| `pnpm lint`   | `nx run-many -t lint`   | ESLint + module boundaries, all projects |
| `pnpm format` | `nx format:write --all` | Prettier-format the workspace            |

Other useful Nx commands:

```bash
pnpm exec nx run-many -t lint test        # all projects
pnpm exec nx affected -t lint test        # only what changed vs. the base branch
pnpm exec nx test trinity --configuration=watch   # Vitest watch mode
pnpm exec nx graph                        # interactive dependency graph
pnpm exec nx reset                        # clear the Nx cache if results look stale
```

Nx caches `build`/`test`/`lint`; a second run on unchanged inputs is instant.

## Testing

**Unit tests — Vitest** (via the Analog Angular plugin), configured per project in
`vite.config.ts` with `src/test-setup.ts`:

```bash
pnpm test                                 # nx run-many -t test (once)
pnpm exec nx test trinity --configuration=watch
```

**App journeys (`@nx/playwright`)** — `@playwright/test` specs in
[`apps/trinity/e2e/`](../apps/trinity/e2e/) covering login/guard, theme, profile,
and device management. Builds the dev bundle, serves `www/`, and brings the Synapse
harness below up/down via global setup (auth specs skip themselves when Docker is absent):

```bash
pnpm exec nx e2e trinity            # all specs (Chromium)
pnpm exec nx e2e trinity -- --list  # enumerate without running
```

**Electron desktop (`@playwright/test` + `_electron`)** — specs in
[`apps/trinity/e2e-electron/`](../apps/trinity/e2e-electron/) launch the **built**
desktop app (`electron/dist/main.js` serving `www/` over `trinity://app`) and assert it
boots, exposes the preload bridge but no Node, and renders dark mode (a regression test
for the critical-CSS/Electron dark-theme bug):

```bash
pnpm electron:install   # once — downloads the Electron binary (normal install skips it)
pnpm electron:e2e       # builds the app, then runs the Electron specs
# headless Linux/CI: wrap with xvfb (Electron needs a display):
xvfb-run -a pnpm electron:e2e
```

**Crypto/protocol harnesses** — headless Playwright drivers in [`e2e/`](../e2e/) that
build, serve `www/`, and assert real behavior (including live `.well-known`
discovery against matrix.org):

```bash
pnpm smoke:login      # redirect→login + real .well-known discovery
pnpm spike:chromium   # E2EE WASM in Blink  (Android WebView / Electron proxy)
pnpm spike:webkit     # E2EE WASM in WebKit (iOS WKWebView proxy)
pnpm e2e:verify       # two-client emoji-SAS device verification (needs Docker; see e2e/README)
pnpm e2e:media        # note-to-self encrypted media send round-trip (needs Docker; see e2e/README)
```

All should print `RESULT: PASS`. The spike/smoke harnesses require the Playwright
browsers:

```bash
pnpm exec playwright install chromium webkit
```

`e2e/` holds `smoke-login.mjs`, `crypto-spike.mjs`, the two-client
`verify-sas.mjs` (+ its `verify-sas-run.mjs` orchestrator, `verify-sas-selfcheck.mjs`,
and a disposable `synapse/` Synapse+Caddy harness), and a shared `support/serve.mjs`
static server. See [e2e/README.md](../e2e/README.md) for the verification flow and how
to point it at your own homeserver. The verification harness needs a homeserver over
**https** because the app CSP only allows `https:`/`wss:` for `connect-src`.

### What is NOT covered yet

- These e2e harnesses **in CI**. The full `e2e:verify` SAS round-trip has been run to
  PASS **locally** (2026-06-27, against the bundled Synapse `v1.119.0` + Caddy Docker
  harness), but CI (`.crow/ci.yaml`) runs only lint/stylelint/format/`test`/build —
  there is no e2e step yet. Wiring one in needs Docker registry access on the runner
  (or an external https homeserver via `TRINITY_HS`).
- A **credentialed** plain login → sync → logout cycle against the _public_ homeserver
  (the matrix.org `smoke:login` is unauthenticated; no throwaway account is wired in).
  `e2e/verify-sas.mjs` already does credentialed login (twice) against the disposable
  Synapse, so the credentialed path itself is exercised end-to-end — just not against
  matrix.org.
- On-device WebView runtime (the Playwright engine runs are faithful proxies, but a
  simulator/emulator run is the real thing — see [../SPIKE.md](../SPIKE.md)).
- The **native SSO deep link** (`eu.qwky.trinity://sso-callback`) — wired with a state
  nonce, but the round-trip needs on-device validation (`cap sync` then a real SSO).

## Code quality & git hooks

- **ESLint** — flat config in [`eslint.config.mjs`](../eslint.config.mjs)
  (`angular-eslint` + `typescript-eslint`). `@nx/enforce-module-boundaries` enforces
  the layering via project `tags`: `feature-*` may depend on `core` + `ui`; `ui` is
  presentational-only (depends on nothing but `ui`); `core` depends on nothing; the app
  may depend on anything. Run with `pnpm lint` / `pnpm exec nx run-many -t lint`.
- **Prettier** — [`.prettierrc.json`](../.prettierrc.json) (`singleQuote`, with the
  Angular parser forced for `*.page.html` templates). `pnpm format` writes,
  `pnpm format:check` verifies.
- **Stylelint** — [`.stylelintrc.json`](../.stylelintrc.json)
  (`stylelint-config-standard-scss`) lints SCSS. Run `pnpm stylelint`.
- **Husky + lint-staged** — `pnpm install` activates a **pre-commit** hook
  (`.husky/pre-commit` → `lint-staged`): staged `apps`/`libs` TypeScript gets
  `eslint --fix` + `prettier --write`, staged SCSS gets `stylelint --fix` +
  `prettier --write`, and everything else gets `prettier --write` (see
  [`.lintstagedrc.json`](../.lintstagedrc.json)). A module-boundary violation fails
  the commit.
- **Commitlint** — a **commit-msg** hook validates the message against the Angular
  convention ([`.commitlintrc.json`](../.commitlintrc.json) →
  `@commitlint/config-angular`): `type(scope): subject`, where `type` is one of
  `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`
  (note: **no** `chore`).

## Continuous integration

[Crow CI](https://crowci.dev) runs the same gates on the server, on every **push**
and **pull request** — and on **tags** it also builds the Electron Linux package
(config: [`.crow/ci.yaml`](../.crow/ci.yaml); status badge in the
[README](../README.md)). The `node:22` image has no pnpm, so each step runs
`corepack enable` first — Corepack (bundled with Node) activates the version pinned in
`package.json`'s `packageManager` field; `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` keeps its
first download non-interactive so CI doesn't hang on a prompt.

| Step                   | Command                             | Mirrors locally               |
| ---------------------- | ----------------------------------- | ----------------------------- |
| `install`              | `pnpm install --frozen-lockfile`    | `pnpm install`                |
| `lint`                 | `pnpm lint`                         | `pnpm lint`                   |
| `stylelint`            | `pnpm stylelint`                    | `pnpm stylelint`              |
| `format`               | `pnpm format:check`                 | `pnpm format`                 |
| `test`                 | `pnpm test`                         | `pnpm test`                   |
| `build`                | `pnpm build`                        | `pnpm build`                  |
| `electron`             | `pnpm -C electron run compile`      | (Electron TS compile check)   |
| `electron-build-linux` | `electron-builder --linux AppImage` | `pnpm electron:package:linux` |

`electron` (Electron main/preload compile check) runs on push/PR. The **per-OS Electron
packages build only on `tag` events** (electron-builder downloads the Electron binary +
tooling — too heavy for every push). electron-builder can't cross-build, so each OS is a
**separate workflow** routed to its own runner via a `labels` filter (labels are
per-workflow in Crow, not per-step):

| Workflow file                           | Runner label    | Builds                               |
| --------------------------------------- | --------------- | ------------------------------------ |
| `ci.yaml` (`electron-build-linux` step) | _default agent_ | Linux AppImage → `electron/release/` |
| `electron-macos.yaml`                   | `os: macos`     | macOS `.dmg` + `.zip` (macOS host)   |
| `electron-windows.yaml`                 | `os: windows`   | Windows NSIS `.exe` (Windows host)   |

The macOS/Windows workflows need a Crow **agent connected on that OS advertising the
matching label** (e.g. `CROW_AGENT_LABELS="os=macos"`); without one, those tag workflows
stay pending. Both currently produce **unsigned** artifacts — wire signing creds on the
runners (`electron-builder.yml` TODOs). Publishing the artifacts (release/object store)
needs a separate upload plugin.

Steps share the cloned workspace, so the `node_modules` from `install` is reused by the
rest. `--frozen-lockfile` makes CI fail if `pnpm-lock.yaml` is out of sync with
`package.json` — commit lockfile changes alongside dependency edits. To reproduce a CI
failure locally, run the corresponding command from the **Mirrors locally** column; note
CI uses `format:check` (verifies, non-zero exit on drift) where you'd run `pnpm format`
to fix.

## Troubleshooting

| Symptom                                                                   | Cause / fix                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WebAssembly … HTTP status is not ok` / crypto 404                        | The WASM asset isn't served. Ensure the build target (`apps/trinity/project.json`) copies it to `assets/crypto/` and you ran `pnpm build`. See [ARCHITECTURE.md](ARCHITECTURE.md#e2ee-wasm-loading).         |
| Crypto fails only on device                                               | Check Capacitor serves `.wasm` as `application/wasm`; if a CSP is set, allow `wasm-unsafe-eval`.                                                                                                             |
| `xcodebuild requires Xcode`                                               | Command Line Tools are selected, not Xcode. Run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.                                                                                           |
| Android: "Unable to infer default Android SDK"                            | Export `ANDROID_HOME` and confirm `android/local.properties` `sdk.dir`.                                                                                                                                      |
| Build warns about non-ESM modules (`loglevel`, `events`, …)               | Harmless CommonJS-interop notices from matrix-js-sdk deps.                                                                                                                                                   |
| Vitest: `Cannot use import statement outside a module` from `@ionic/core` | A spec renders an Ionic web component (e.g. `ion-icon`). `@ionic/core` ships ESM in a CJS package — inline it for Vitest: `test.server.deps.inline` in the project's `vite.config.ts` (see `feature-rooms`). |
| `Cannot find module '@trinity/…'`                                         | Path aliases live in `tsconfig.base.json`; the Vite/Vitest side resolves them via `vite-tsconfig-paths`. Run `pnpm exec nx reset` if the graph looks stale.                                                  |
| Stale Nx task results                                                     | `pnpm exec nx reset` clears the cache.                                                                                                                                                                       |
| Stuck "logged in" / weird crypto state                                    | Clear localStorage + IndexedDB (web) or reinstall the app (device).                                                                                                                                          |

## Conventions

- Standalone Angular components with `ChangeDetectionStrategy.OnPush`; import Ionic
  from `@ionic/angular/standalone`. Each component/page lives in its own directory
  (`name/name.component.ts` + `.html`/`.scss`/`.spec.ts`).
- **State via signals** — services keep state in private signals exposed as
  `asReadonly()`. **Async service APIs return RxJS Observables** (`defer`/`from` +
  `switchMap`/`map`/`catchError`); components subscribe with `takeUntilDestroyed`
  (see the `angular-rxjs-patterns` skill). The login page wraps its calls in a
  shared `withBusy()` helper for busy/error handling.
- New SDK interaction belongs in `@trinity/core` (`libs/core`), not in a component;
  feature pages live in `@trinity/feature-*` libs. Respect the module boundaries.
- Cross-lib imports use the `@trinity/*` aliases; imports within a lib stay relative.
- Component SCSS shares mixins from `libs/feature-rooms/src/lib/styles/_mixins.scss`.
- Keep `data-testid` hooks on interactive elements that the headless scripts drive.
