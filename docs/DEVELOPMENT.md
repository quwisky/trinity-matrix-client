# Development guide

Setup, running, testing, and troubleshooting. Architecture is in
[ARCHITECTURE.md](ARCHITECTURE.md); roadmap in [../PLAN.md](../PLAN.md).

## Workspace layout

Trinity is an **Nx integrated monorepo** (pnpm). The deployable app lives in
`apps/`, reusable code in `libs/` (imported via `@trinity/*` path aliases and
guarded by Nx module boundaries). Projects:

| Project            | Path                    | Notes                                                                                                                                                                                            |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `trinity`          | `apps/trinity`          | the Angular/spartan-ng app (build, serve, test) `[type:app]`                                                                                                                                     |
| `core`             | `libs/core`             | `@trinity/core` — Matrix services, storage, guard `[type:core]`                                                                                                                                  |
| `feature-auth`     | `libs/feature-auth`     | `@trinity/feature-auth` — login + SSO callback `[type:feature]`                                                                                                                                  |
| `feature-rooms`    | `libs/feature-rooms`    | `@trinity/feature-rooms` — room shell + message timeline (incl. quick switcher, message search, user picker) `[type:feature]`                                                                    |
| `feature-crypto`   | `libs/feature-crypto`   | `@trinity/feature-crypto` — encryption setup/recovery + device verification `[type:feature]`                                                                                                     |
| `feature-settings` | `libs/feature-settings` | `@trinity/feature-settings` — settings: appearance (theme), profile, device management `[type:feature]`                                                                                          |
| `ui`               | `libs/ui`               | `@trinity/ui` — reusable presentational components (avatar + `AVATAR_RESOLVER` token, banner, page header, media bubble, message toolbar, encryption-dialog service) + `runWithBusy` `[type:ui]` |
| `spartan/*`        | `libs/spartan/*`        | `@trinity/helm/*` — styled spartan-ng **Helm** components over headless **Brain** primitives (button, input, card, overlay, dropdown-menu, …), added via `@spartan-ng/cli` `[type:ui]`           |

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
[`e2e/playwright/`](../e2e/playwright/) covering login/guard, theme, profile,
and device management. Builds the dev bundle, serves `www/`, and brings the Synapse
harness below up/down via global setup (auth specs skip themselves when Docker is absent):

```bash
pnpm exec nx e2e trinity-e2e            # all specs (Chromium)
pnpm exec nx e2e trinity-e2e -- --list  # enumerate without running
```

**Electron desktop (`@playwright/test` + `_electron`)** — specs in
[`e2e/electron/`](../e2e/electron/) launch the **built**
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
pnpm e2e:threads      # thread lifecycle: Reply-in-thread → first reply creates it, reopen, abandon (needs Docker)
pnpm e2e:spaces       # spaces create/manage: create space + channel (asserts m.space.child) + leave (needs Docker)
pnpm e2e:rooms        # room/DM creation + invites: create room, start DM, invite, accept/decline (needs Docker)
pnpm e2e:search       # search: quick switcher + in-room message search (needs Docker)
```

The Synapse-backed flows (`e2e:verify`/`media`/`threads`/`spaces`/`rooms`/`search`) each
start and tear down the **one** disposable Synapse Docker stack (fixed ports), so they
**must run sequentially**, never concurrently — e.g. `pnpm e2e:threads && pnpm e2e:spaces`.

All should print `RESULT: PASS`. The spike/smoke harnesses require the Playwright
browsers:

```bash
pnpm exec playwright install chromium webkit
```

`e2e/` holds `smoke-login.mjs`, `crypto-spike.mjs`, the two-client
`verify-sas.mjs` (+ its `verify-sas-run.mjs` orchestrator, `verify-sas-selfcheck.mjs`,
and a disposable `synapse/` Synapse+Caddy harness), the feature flows
`send-media.mjs` / `threads.mjs` / `spaces.mjs` / `rooms.mjs` / `search.mjs` (each with a
`*-run.mjs` orchestrator that owns the Synapse lifecycle), and a shared `support/serve.mjs`
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
  `e2e/features/verify-sas.mjs` already does credentialed login (twice) against the disposable
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
stay pending. Both currently produce **unsigned** artifacts; for the macOS signed +
notarized path see [macOS signing & notarization](#macos-signing--notarization) below.
Publishing the artifacts (release/object store) needs a separate upload plugin.

Steps share the cloned workspace, so the `node_modules` from `install` is reused by the
rest. `--frozen-lockfile` makes CI fail if `pnpm-lock.yaml` is out of sync with
`package.json` — commit lockfile changes alongside dependency edits. To reproduce a CI
failure locally, run the corresponding command from the **Mirrors locally** column; note
CI uses `format:check` (verifies, non-zero exit on drift) where you'd run `pnpm format`
to fix.

## macOS signing & notarization

The desktop app must be **signed with a Developer ID identity and notarized** to ship —
and macOS only delivers the app's **OS notifications** when it is signed + notarized (see
[PUSH.md → Local notifications](PUSH.md#local-notifications-desktop--web)). The build is
wired so signing/notarization kicks in automatically **when credentials are present**, and
local builds **without** a cert still succeed (unsigned/ad-hoc).

**Two build scripts:**

| Script                             | What it does                                                                                                                                                                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm electron:package:mac`        | **Unsigned/ad-hoc** dev build. Forces `CSC_IDENTITY_AUTO_DISCOVERY=false` so a stray cert in your keychain can't trigger a failing sign. No cert needed. **Do not ship.**                                                                                                         |
| `pnpm electron:package:mac:signed` | **Signed + notarized** release build. electron-builder auto-discovers the Developer ID cert and signs with the hardened runtime + `electron/build/entitlements.mac.plist`; the `afterSign` hook (`electron/build/notarize.cjs`) then notarizes **if** notarization creds are set. |

**Signing identity** — provide a "Developer ID Application" cert via either:

- the **login keychain** (Xcode / `security import`), or
- `CSC_LINK` (path or base64 of a `.p12`) + `CSC_KEY_PASSWORD`.

**Notarization credentials** — set **one** of these styles (App Store Connect API key is
preferred; it's keychain-free and CI-friendly):

```bash
# App Store Connect API key
export APPLE_API_KEY=/abs/path/AuthKey_XXXXXXXXXX.p8   # the .p8 file
export APPLE_API_KEY_ID=XXXXXXXXXX                     # 10-char Key ID
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-...     # issuer UUID

# …or Apple ID
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop  # app-specific password
export APPLE_TEAM_ID=ABCDE12345
```

If no notarization creds are set, `notarize.cjs` logs `skipping notarization — no
credentials` and the (still-signed, if a cert was found) `.app` is left un-notarized.

**CI:** [`.crow/electron-macos.yaml`](../.crow/electron-macos.yaml) runs the **unsigned**
path on tags today. To produce a signed + notarized artifact, switch it to
`pnpm electron:package:mac:signed` and provide the cert + notarization values as Crow
**secrets** wired into the step's `environment:` (commented examples are in that file).

> Cannot be verified on Linux/CI without an Apple Developer cert — the signed path needs a
> real macOS host with a Developer ID identity and notarization credentials.

### Local notification testing without an Apple Developer account

Electron 42 posts macOS notifications through `UNUserNotification`, which **requires a
stable code signature**. The unsigned/ad-hoc `package:mac` build therefore can't display
them — the OS rejects the post with `UNErrorDomain error 1` (now logged by the main
process — see the `failed` handler in `electron/src/main.ts`). **Notarization is not
required for this — only a stable signature** — so you can test notifications locally with
a free **self-signed** cert. (Plain ad-hoc `codesign --sign -` does NOT work: no stable
identity.)

1. Create a self-signed code-signing identity named `trinity-dev`, once (or via Keychain
   Access → Certificate Assistant → Create a Certificate → Self-Signed Root + Code Signing):

   ```bash
   cat > /tmp/edev.conf <<'EOF'
   [ req ]
   distinguished_name = dn
   x509_extensions = ext
   prompt = no
   [ dn ]
   CN = trinity-dev
   [ ext ]
   keyUsage = critical, digitalSignature
   extendedKeyUsage = critical, codeSigning
   basicConstraints = critical, CA:false
   EOF
   openssl req -x509 -newkey rsa:2048 -keyout /tmp/edev-key.pem -out /tmp/edev.pem \
     -days 3650 -nodes -config /tmp/edev.conf
   openssl pkcs12 -export -legacy -macalg sha1 -inkey /tmp/edev-key.pem -in /tmp/edev.pem \
     -out /tmp/edev.p12 -passout pass:electron -name "trinity-dev"
   security import /tmp/edev.p12 -k ~/Library/Keychains/login.keychain-db -P electron -T /usr/bin/codesign
   security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db /tmp/edev.pem
   rm -f /tmp/edev*.pem /tmp/edev.p12 /tmp/edev.conf
   ```

2. Sign with it. For a packaged build (notarization auto-skips with no Apple creds):

   ```bash
   CSC_NAME="trinity-dev" pnpm electron:package:mac:signed
   ```

   For the `pnpm electron:start` dev runner, sign the Electron binary instead:
   `pnpm electron:sign:dev`.

3. Launch the app (right-click → **Open** to clear Gatekeeper — it isn't notarized) and
   click **Always Allow** on the first keychain prompt (it persists for the stable
   `trinity-dev` identity). Notifications now display. For a shippable build, swap the
   self-signed cert for a real Developer ID + notarization (above).

**Quick check:** launch the app's binary with `TRINITY_NOTIFY_TEST=1` to post a test
notification ~3s after startup (no login or incoming message needed). The main process
logs `[notify-test] …` — `shown` on success, or `FAILED: UNErrorDomain error 1` when the
signature isn't stable. Launch from a terminal to see it:

```bash
TRINITY_NOTIFY_TEST=1 "/path/to/Trinity.app/Contents/MacOS/Trinity"
```

## App icon

The Trinity icon is three connected nodes (trinity + a Matrix federation/chat graph) in
brand blurple `#5865f2`. The vector master is
[`apps/trinity/src/assets/icon/icon.svg`](../apps/trinity/src/assets/icon/icon.svg)
(transparent); a blurple-plate variant is kept alongside as `icon-plated.svg`. Rasters in
the same folder — `favicon.png` (wired in `index.html`), `icon-192/512/1024.png`,
`apple-touch-icon.png` — plus `electron/build/icon.png` (1024), the **Electron** app icon
from which electron-builder generates the macOS `.icns` / Windows `.ico` / Linux png set
at package time. There is no `sharp`/`rsvg` in the toolchain: the PNGs were rasterized
from the SVG through the bundled Chromium (Playwright). Note iOS composites transparency
onto black, so `apple-touch-icon.png` ideally keeps a solid plate (`icon-plated.svg`).

## Troubleshooting

| Symptom                                                     | Cause / fix                                                                                                                                                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebAssembly … HTTP status is not ok` / crypto 404          | The WASM asset isn't served. Ensure the build target (`apps/trinity/project.json`) copies it to `assets/crypto/` and you ran `pnpm build`. See [ARCHITECTURE.md](ARCHITECTURE.md#e2ee-wasm-loading). |
| Crypto fails only on device                                 | Check Capacitor serves `.wasm` as `application/wasm`; if a CSP is set, allow `wasm-unsafe-eval`.                                                                                                     |
| `xcodebuild requires Xcode`                                 | Command Line Tools are selected, not Xcode. Run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.                                                                                   |
| Android: "Unable to infer default Android SDK"              | Export `ANDROID_HOME` and confirm `android/local.properties` `sdk.dir`.                                                                                                                              |
| Build warns about non-ESM modules (`loglevel`, `events`, …) | Harmless CommonJS-interop notices from matrix-js-sdk deps.                                                                                                                                           |
| `Cannot find module '@trinity/…'`                           | Path aliases live in `tsconfig.base.json`; the Vite/Vitest side resolves them via `vite-tsconfig-paths`. Run `pnpm exec nx reset` if the graph looks stale.                                          |
| Stale Nx task results                                       | `pnpm exec nx reset` clears the cache.                                                                                                                                                               |
| Stuck "logged in" / weird crypto state                      | Clear localStorage + IndexedDB (web) or reinstall the app (device).                                                                                                                                  |

## Conventions

- Standalone Angular components with `ChangeDetectionStrategy.OnPush`; build UI from
  spartan-ng **Brain** primitives (`@spartan-ng/brain`) and the styled **Helm**
  components (`@trinity/helm/*`). Each component/page lives in its own directory
  (`name/name.component.ts` + `.html`/`.scss`/`.spec.ts`).
- Helm components under `libs/spartan/*` are generated/owned via `@spartan-ng/cli`
  (config in root `components.json`) — add or regenerate them with the CLI rather than
  hand-authoring, and they are intentionally exempt from the `trn`-prefix selector /
  class-suffix ESLint rules.
- **State via signals** — services keep state in private signals exposed as
  `asReadonly()`. **Async service APIs return RxJS Observables** (`defer`/`from` +
  `switchMap`/`map`/`catchError`); components subscribe with `takeUntilDestroyed`
  (see the `angular-rxjs-patterns` skill). The login page wraps its calls in the
  shared `runWithBusy()` helper (via a local `withBusy()` method) for busy/error handling.
- New SDK interaction belongs in `@trinity/core` (`libs/core`), not in a component;
  feature pages live in `@trinity/feature-*` libs. Respect the module boundaries.
- Cross-lib imports use the `@trinity/*` aliases; imports within a lib stay relative.
- Component SCSS shares mixins from `libs/feature-rooms/src/lib/styles/_mixins.scss`.
- Keep `data-testid` hooks on interactive elements that the headless scripts drive.
