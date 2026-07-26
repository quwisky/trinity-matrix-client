# Development guide

Setup, running, testing, and troubleshooting. Architecture is in
[ARCHITECTURE.md](ARCHITECTURE.md); roadmap in [PLAN.md](PLAN.md).

## Workspace layout

Trinity is an **Nx integrated monorepo** (pnpm). The deployable app lives in
`apps/`, reusable code in `libs/` (imported via `@trinity/*` path aliases and
guarded by Nx module boundaries). Projects:

| Project                     | Path                             | Notes                                                                                                                                                                                            |
| --------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `trinity`                   | `apps/trinity`                   | the Angular/spartan-ng app (build, serve, test) `[type:app]`                                                                                                                                     |
| `util-matrix`               | `libs/util-matrix`               | `@trinity/util-matrix` — pure DI-free Matrix models/helpers (view models, media/session models, markdown, wasm loader) `[type:util]`                                                             |
| `platform-native`           | `libs/platform-native`           | `@trinity/platform-native` — Capacitor/native capabilities (storage, preferences, theme, badge, error handler) `[type:platform]`                                                                 |
| `data-access-matrix-client` | `libs/data-access-matrix-client` | `@trinity/data-access-matrix-client` — MatrixClient lifecycle + 4S key; the client/session foundation `[type:data-access]`                                                                       |
| `data-access-*`             | `libs/data-access-*`             | `@trinity/data-access-{media,rooms,timeline,crypto,profile,invites,pinned,search,notifications,auth}` — one lib per Matrix domain (services, read models, guards) `[type:data-access]`           |
| `feature-shell`             | `libs/feature-shell`             | `@trinity/feature-shell` — app shell (AppComponent, verification host, nav focus) + dev `/spike` page `[type:feature]`                                                                           |
| `feature-auth`              | `libs/feature-auth`              | `@trinity/feature-auth` — login + SSO callback `[type:feature]`                                                                                                                                  |
| `feature-rooms`             | `libs/feature-rooms`             | `@trinity/feature-rooms` — room shell + message timeline (incl. quick switcher, message search, user picker) `[type:feature]`                                                                    |
| `feature-crypto`            | `libs/feature-crypto`            | `@trinity/feature-crypto` — encryption setup/recovery + device verification `[type:feature]`                                                                                                     |
| `feature-settings`          | `libs/feature-settings`          | `@trinity/feature-settings` — settings: appearance (theme + palettes), profile, device management `[type:feature]`                                                                               |
| `ui`                        | `libs/ui`                        | `@trinity/ui` — reusable presentational components (avatar + `AVATAR_RESOLVER` token, banner, page header, media bubble, message toolbar, encryption-dialog service) + `runWithBusy` `[type:ui]` |
| `spartan/*`                 | `libs/spartan/*`                 | `@trinity/helm/*` — styled spartan-ng **Helm** components over headless **Brain** primitives (button, input, card, overlay, dropdown-menu, …), added via `@spartan-ng/cli` `[type:ui]`           |

The web build still emits to root `www/`, so Capacitor and the native projects
are unchanged. `pnpm exec nx graph` opens the dependency graph.

## Prerequisites

- **Node 24** (what CI runs and the repo is developed on) and **pnpm**
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
> approved under `allowBuilds` in `pnpm-workspace.yaml`, so they build on install.
> (pnpm 11 removed the older `pnpm.onlyBuiltDependencies` list that used to live in
> `package.json`; `strictDepBuilds` now defaults to true, so any other build-script
> dependency must be listed there too — see `less: false`.) Installing also runs the
> `prepare` script, which activates the Husky git hooks (see
> [Code quality](#code-quality--git-hooks)).

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

Nx runs three projects at a time, and each project's Vitest runs in the **`forks`** pool —
one isolated process per test file, so memory is reclaimed between files. The pool is set
explicitly in `vite.base.config.ts` and the comment there explains why: the Analog Angular
plugin defaults it to `vmThreads`, which reuses long-lived workers and pushed `feature-rooms`
to a 4.3 GB peak, getting it OOM-killed on about half of all full runs.

**Reading a failed run.** The two ways this suite fails look nothing alike, and neither
announces itself:

| Symptom                                                      | What it is                                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| A `Killed` line and a **missing** project summary — 21 of 22 | The process was OOM-killed. Tests did not fail; they never finished reporting.                                              |
| All 22 summaries present, plus an `Unhandled Errors` block   | Something escaped a test's lifetime — usually a timer firing after teardown. Exit code is non-zero with every test passing. |

Two traps worth knowing:

- **Check the exit code, not the output.** Nx and esbuild print `✘ [ERROR]` and `Failed tasks`;
  a grep for `error` matches neither, so a failing run and a silent one look identical.
- **`nx reset --onlyCache` does not clear flaky history.** Nx keeps task history in SQLite under
  `.nx/workspace-data/`, keyed by task _hash_, so one historical failure makes "Nx detected a
  flaky task" reappear on later runs that passed. `pnpm exec nx reset` (or
  `--onlyWorkspaceData`) clears it. And because `test` is cached, reproducing anything
  intermittent needs `--skip-nx-cache` or a pass may just be a replay.

**App journeys (`@nx/playwright`)** — `@playwright/test` specs in
[`e2e/playwright/`](../e2e/playwright/) covering the app shell/login guard, navigation, notifications, pinned
messages, favourite and room lists, unread badges, timeline virtualization, and settings
(theme, profile, device management). Builds the dev bundle, serves `www/`, and brings the Synapse
harness below up/down via global setup (auth specs skip themselves when Docker is absent —
except under `CI`, where a missing Synapse is a hard failure instead of a quietly green run):

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
pnpm e2e:reply        # reply header/preview: reply-in-timeline round-trip (needs Docker)
pnpm e2e:emoji        # composer emoji: :shortcode autocomplete, inline conversion, picker (needs Docker)
```

The Synapse-backed flows (`e2e:verify`/`media`/`threads`/`reply`/`spaces`/`rooms`/`search`/`emoji`) each
start and tear down the **one** disposable Synapse Docker stack (fixed ports), so they
**must run sequentially**, never concurrently — e.g. `pnpm e2e:threads && pnpm e2e:spaces`.

All should print `RESULT: PASS`. The spike/smoke harnesses require the Playwright
browsers:

```bash
pnpm exec playwright install chromium webkit
```

`e2e/features/` holds `smoke-login.mjs`, `crypto-spike.mjs`, the two-client
`verify-sas.mjs` (+ `verify-sas-selfcheck.mjs`); the `e2e/runners/*-run.mjs` orchestrators own the
disposable `e2e/synapse/` Synapse+Caddy harness, the feature flows
`send-media.mjs` / `threads.mjs` / `reply.mjs` / `spaces.mjs` / `rooms.mjs` / `search.mjs` / `emoji.mjs` (each with a
`*-run.mjs` orchestrator that owns the Synapse lifecycle), and a shared `support/serve.mjs`
static server. See [e2e/README.md](../e2e/README.md) for the verification flow and how
to point it at your own homeserver. The verification harness needs a homeserver over
**https** because the app CSP only allows `https:`/`wss:` for `connect-src`.

### What is NOT covered yet

- The **standalone** harnesses in CI. The Playwright app journeys (`trinity-e2e`) now run
  on every PR against the disposable Synapse, but the `e2e/runners/*` flows —
  including the full `e2e:verify` SAS round-trip, run to PASS **locally** on 2026-06-27
  against the bundled Synapse `v1.119.0` + Caddy — are still hand-run. Each owns the same
  fixed-port Docker stack, so they cannot run concurrently with the Playwright job.
- The **Electron** e2e specs (`pnpm electron:e2e`): CI compiles and unit-tests the main
  process but never launches the app, which would need the ~100 MB binary plus `xvfb`.
- A **credentialed** plain login → sync → logout cycle against the _public_ homeserver
  (the matrix.org `smoke:login` is unauthenticated; no throwaway account is wired in).
  `e2e/features/verify-sas.mjs` already does credentialed login (twice) against the disposable
  Synapse, so the credentialed path itself is exercised end-to-end — just not against
  matrix.org.
- On-device WebView runtime (the Playwright engine runs are faithful proxies, but a
  simulator/emulator run is the real thing — see [SPIKE.md](SPIKE.md)).
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
- **Commitlint** — a **commit-msg** hook validates the message against the Conventional
  Commits convention ([`.commitlintrc.json`](../.commitlintrc.json) →
  `@commitlint/config-conventional`): `type(scope): subject`, where `type` is one of
  `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
  or `revert`.

## Continuous integration

**GitHub Actions** runs the same gates on every **push** to `develop`/`master` and every
**pull request** (config: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml); status
badge in the [README](../README.md)). Five jobs run **in parallel**, each on its own runner,
so a failure names itself in the checks list and the long e2e never queues behind the unit
tests:

| Job       | Commands                                                 | Mirrors locally                                         |
| --------- | -------------------------------------------------------- | ------------------------------------------------------- |
| `quality` | `pnpm lint` · `pnpm stylelint` · `pnpm format:check`     | same (`pnpm format` fixes what `format:check` verifies) |
| `test`    | `pnpm test`                                              | `pnpm test`                                             |
| `build`   | `pnpm build`                                             | `pnpm build`                                            |
| `desktop` | `pnpm -C electron install` · `run compile` · `test`      | `pnpm -C electron test`                                 |
| `e2e`     | _prepare prerequisites_ · `pnpm exec nx e2e trinity-e2e` | `pnpm exec nx e2e trinity-e2e`                          |

Every job starts with the composite step
[`.github/actions/setup`](../.github/actions/setup/action.yml): `pnpm/action-setup` (which
takes the version from `package.json`'s `packageManager` field, so it must **not** also be
passed a `version:` input, and must run _before_ `setup-node`, whose `cache: pnpm` shells out
to pnpm to find the store), Node 24, and `pnpm install --frozen-lockfile`.

**There is deliberately no Nx cache step.** Caching `.nx/cache` across runs looks obvious and
does nothing: Nx 23 keeps the hash→result index in a SQLite database under
`.nx/workspace-data` — not `.nx/cache` — and that database is keyed by machine ID, so an
ephemeral runner gets a **0% hit rate** while still paying to upload and download it
(measured). The supported answer for ephemeral runners is a remote cache (Nx Cloud or a
self-hosted equivalent), which this repo does not use.

Every action is pinned to a **commit SHA**, not a tag, with the version in a trailing
comment. Tags are mutable, and retargeting one is how CVE-2025-30066 reached ~23k
repositories; the release workflow's packaging job holds signing certificates in its
environment. Renovate keeps those pins from rotting (below).

### Dependency updates (Renovate)

[`.github/workflows/renovate.yml`](../.github/workflows/renovate.yml) runs Renovate on a
**daily cron at 00:00 UTC**, plus on demand (`workflow_dispatch`, with a **dry run** option
for trying config changes without opening anything). The repo config is
[`.github/renovate.json`](../.github/renovate.json), and it only ever targets **`develop`**
(`baseBranches`) — no update PR is opened against `master`.

| Setting                        | Why                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build(deps): …` commits       | Matches the repo's existing convention and passes the commitlint hook                                                                                                          |
| Grouped families               | angular · nx · matrix-js-sdk (+ crypto WASM) · capacitor · spartan-ng · playwright · vitest · eslint · tailwind — each is version-locked, so a partial bump breaks the build   |
| `electron/` on its own         | Separate package and lockfile; it pins TypeScript 5.9 against the workspace's 6.x, and must never be merged into a root group                                                  |
| `automerge: false`             | Nothing Renovate opens ever merges itself — every update is reviewed and merged by a human, including patches and lock-file maintenance                                        |
| Everything opens a PR          | No rule uses `dependencyDashboardApproval`, so **every** update reaches a PR eventually, framework majors included — the limits below throttle the rate, they never cancel one |
| 5 open / 2 per hour            | `prConcurrentLimit` / `prHourlyLimit` keep the queue reviewable and stop a burst saturating the runners; the rest follow as slots free up                                      |
| `minimumReleaseAge: 3 days`    | Skips a release that gets yanked hours after publishing — the one thing that delays a PR (by three days), waived for `vulnerabilityAlerts`                                     |
| `android/**`, `ios/**` ignored | Capacitor owns those native projects                                                                                                                                           |

Two operational notes. It needs a **`RENOVATE_TOKEN` secret** — a PAT with repo scope, or a
GitHub App token, **not** the default `GITHUB_TOKEN`: pull requests opened with the latter do
not trigger other workflows, so every Renovate PR would sit there with no CI run against it.
And the cron **is** the schedule: Renovate's own `schedule` is deliberately left open, because
setting both is the classic way to get a bot that never runs — the job fires outside
Renovate's window, Renovate declines, nothing happens.

There is no Dependabot config; Renovate covers the same ground including the GitHub Actions
digests, and running both would open duplicate PRs for the same updates.

Nothing is ever withheld and nothing ever self-merges: the limits decide only **when** a PR
appears, so a backlog drains a few at a time (five open, two an hour) instead of arriving as
one burst that saturates the runners — each PR triggers the full CI matrix, including the
45-minute e2e job.

A framework **major** opens a PR like anything else, but it will usually fail CI until the
corresponding migration is run (`nx migrate`, Angular update schematics, an SDK deep-import
change): treat that PR as the notification, not as something to merge.

`automerge: false` binds Renovate only. What stops _anything_ — a bot or a person — merging
into `develop` unreviewed is a **branch protection rule** requiring a pull request and an
approving review; that lives in repo settings, not in this file.

Two things worth knowing about the jobs that are new to CI:

- **`desktop`** exists because `electron/`'s specs are part of no other command — `pnpm test`
  is `nx run-many -t test`, and the `trinity-desktop` project exposes only a `lint` target.
  It sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1`: nothing here launches Electron, so the ~100 MB
  binary is dead weight.
- **`e2e`** runs the Playwright journeys against the disposable Synapse + Caddy stack in
  Docker. Its first step runs three independent things **concurrently** — the
  browser install, the Synapse/Caddy image pull, and the dev build — because Playwright
  otherwise does them in sequence (it orders `webServer` before `globalSetup`, and the
  browser install precedes both). Worth ~25-45s on the only job on the critical path; the
  pre-build is not duplicated work, since the suite's own `webServer` replays it from the
  in-job Nx cache. A failed browser install is fatal, a failed image pre-pull is only a
  warning — `compose up` in global setup pulls anything missing anyway. The harness normally degrades gracefully when Docker is missing (auth specs skip
  themselves), which in CI would mean a **green run that tested almost nothing** — so
  `e2e/playwright/support/global-setup.mts` rethrows instead whenever `CI` is set. Override
  with `TRINITY_E2E_ALLOW_NO_SYNAPSE=1` only if you deliberately want the unauthenticated
  subset. Traces use `retain-on-failure`, not `on-first-retry` — the latter captures the
  retry, which for a flaky spec is the attempt that _passed_, leaving the failure with no
  trace. The HTML report, traces and blob report upload as the `playwright-report` artifact
  on **`always()`** — `timeout-minutes` _cancels_ a job rather than failing it, and
  `if: failure()` does not fire on a cancellation, which would lose the traces in exactly
  the run that needs them.

  **Running CI on a containerised runner** (Forgejo's `act_runner` with a dind sidecar,
  and anything else where the job is a container talking to a separate Docker daemon) needs
  two environment variables. Both are unset on a developer machine and on a GitHub-hosted
  runner — where the job runs directly on the VM — so those paths are untouched:

  | Variable                        | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
  | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `TRINITY_E2E_STATE_DIR`         | A bind mount is resolved by the _daemon_, against the daemon's filesystem. Point this at a directory that means the same thing to the job and the daemon (under `act_runner`, a path beneath the `/workspace` both mount from one host directory). Choose a path **outside the checkout**: the runner mounts the workspace over it, which shadows the shared bind underneath. Without this, `generate` writes the config somewhere the job cannot see and start-up fails with `ENOENT ... homeserver.yaml`. |
  | `TRINITY_E2E_NETWORK_CONTAINER` | Compose publishes to the _daemon's_ loopback, which the job cannot reach — not on `localhost`, and not via the daemon's gateway (both measured). Set to the job container's id and the stack joins that container's network namespace instead, so `localhost:8008`/`:8448` behave as they do locally and Caddy's `localhost` certificate stays valid. `ci.yml` already sets it from `${{ job.container.id }}`, which is empty off a container runner.                                                       |

  For `act_runner`, the state directory belongs in the runner's own config rather than the
  workflow, since it is a property of that runner's layout:

  ```yaml
  # config.yml
  runner:
    envs:
      TRINITY_E2E_STATE_DIR: /workspace/.trinity-e2e-state
  container:
    valid_volumes: ['/workspace', '/workspace/**']
  ```

  The harness passes `UID`/`GID` into the Synapse container ([`e2e/synapse/start.mjs`](../e2e/synapse/start.mjs),
  [`docker-compose.yml`](../e2e/synapse/docker-compose.yml)). Without it the image runs as
  its built-in `991` and chowns the bind-mounted `e2e/synapse/data`, after which the config
  patch fails `EACCES` and teardown cannot delete the directory. It only ever _looked_ fine
  because a filesystem that remaps ownership (virtiofs, FUSE, Docker Desktop) hides it —
  on a plain Linux runner it fails every time.

`--frozen-lockfile` makes CI fail if `pnpm-lock.yaml` is out of sync with `package.json` —
commit lockfile changes alongside dependency edits. To reproduce a CI failure locally, run the
command from the **Mirrors locally** column.

### Desktop releases

Pushing a **`vX.X.X` tag** runs [`.github/workflows/release.yml`](../.github/workflows/release.yml),
which packages the Electron app on all three desktop platforms and attaches the installers to a
**draft** GitHub Release — nothing is downloadable until you review it and press publish.

| Job               | Runner           | Produces                                                                                                                  |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `verify`          | `ubuntu-latest`  | ancestry + version checks, then `lint`, `stylelint`, `format:check`, `test`, `build` + the Electron specs — **not** `e2e` |
| `package (linux)` | `ubuntu-latest`  | `.AppImage`, `.deb`                                                                                                       |
| `package (mac)`   | `macos-latest`   | `.dmg`, `.zip` (**arm64 only** — the runner's own architecture)                                                           |
| `package (win)`   | `windows-latest` | `.exe` (NSIS installer)                                                                                                   |
| `draft-release`   | `ubuntu-latest`  | the draft Release, with every artifact attached                                                                           |

**A tag triggers no `ci.yml` run at all**, so `verify` is the only gate a release gets —
which is why it runs `lint`, `stylelint`, `format:check`, `test` **and** `build`, not just the
tests. It also refuses a tag whose commit is not contained in `develop` or `master`, so a
release can only be cut from code that went through a PR.

Re-run a failed release with **`workflow_dispatch`** (Actions → Release → Run workflow, giving
the existing tag) rather than by moving the tag: artifacts are immutable per run, and the
uploads set `overwrite: true` so a re-run replaces them cleanly. If one platform fails, the
other two are still drafted — `draft-release` runs on `!cancelled()` and annotates which
installer is missing, because a matrix job reports failure if any leg fails and the default
`success()` would silently throw the good artifacts away. Re-running against an **already
published** release is refused outright: `--clobber` deletes live assets, and rebuilt
installers are not byte-identical.

Three things about this are easy to get wrong:

- **Do not use `pnpm electron:build` in CI.** It ends with `electron:sign:dev`, which runs
  `codesign` against a local `trinity-dev` identity — absent on every runner, and absent
  entirely off macOS. The workflow runs the three useful steps directly instead
  (`pnpm build` → `pnpm -C electron install` → `pnpm -C electron run build`), then
  `electron-builder`.
- **The tag must match `package.json` and `electron/package.json`.** electron-builder names
  artifacts after the manifest version, not the tag, so a mismatch would ship
  `Trinity Setup 0.1.0.exe` for `v0.3.0`. `verify` refuses the tag instead — bump both
  versions in the release commit (see [semver](../.claude/rules/git/semver.md)) before tagging.
- **Artifacts are unsigned unless secrets are configured.** Signing is wired but inert: set
  `MAC_CSC_LINK` + `MAC_CSC_KEY_PASSWORD` (base64 `.p12` and its password) and macOS signing
  turns itself on; add `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` and
  `build/notarize.cjs` notarizes too. Windows uses `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`.
  See [macOS signing & notarization](#macos-signing--notarization) below.

  **When you add those secrets, configure the `release` environment first.** The `package`
  job already declares `environment: release`; until you set required reviewers on it in
  repo settings that declaration does nothing. It matters once a certificate exists, because
  electron-builder runs repo-controlled hooks (`electron/afterPack.cjs`,
  `electron/build/notarize.cjs`) in the same process that holds `CSC_KEY_PASSWORD` — so
  anyone able to push a tag could otherwise mint a signed installer, or exfiltrate the cert
  itself, unattended.

Pre-release tags (`v1.2.3-beta.1`) deliberately do not match the trigger. Android/iOS builds
remain manual.

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

**CI:** the `package (mac)` job in
[`.github/workflows/release.yml`](../.github/workflows/release.yml) builds the macOS `.dmg`
and `.zip` on every `vX.X.X` tag, and the signing path is already wired — it is simply
**inert until the secrets exist**. Add these as GitHub repository secrets and the same job
starts producing signed, notarized artifacts with no workflow change:

| Secret                                                       | Effect                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| `MAC_CSC_LINK` + `MAC_CSC_KEY_PASSWORD`                      | base64 of the Developer ID `.p12` and its password → signing on |
| `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` | `build/notarize.cjs` notarizes and staples the signed `.app`    |

Without `MAC_CSC_LINK` the job sets `CSC_IDENTITY_AUTO_DISCOVERY=false`, so it produces a
cleanly unsigned build instead of failing on a half-found identity. The API-key notarization
style (`APPLE_API_KEY` …) is **not** wired, because that variable must be a _path_ to a `.p8`
file, which a secret cannot be without an extra write-to-disk step.

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
  class-suffix ESLint rules. Where upstream is wrong we do diverge, deliberately and on the
  record — see **Vendored spartan overrides** below.

### Vendored spartan overrides

Local changes to generated Helm code. A regenerate silently drops all of these, so each is
commented at its site, listed in a banner at the top of its file, and **pinned by a test** —
a lost override fails the suite rather than shipping.

| File                                                       | Override                                                                                                             | Guarded by                                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `dropdown-menu` · `HlmDropdownMenuSubTrigger`              | Shadow CDK's `_handleClick` so a sub-trigger click opens the submenu instead of toggling it closed under zoneless CD | `libs/spartan/overlay/src/lib/dropdown-menu-submenu.spec.ts`, `e2e/playwright/room-notifications.spec.mts` |
| `dropdown-menu` · `HlmDropdownMenuSubTrigger`              | The same shadow re-does CDK's focus move, so keyboard Enter/Space lands inside the submenu                           | as above                                                                                                   |
| `dropdown-menu` · `HlmDropdownMenuSubTrigger`              | `side` defaults to `'right'`, so a submenu opens beside its parent rather than over it (#28)                         | `libs/spartan/overlay/src/lib/dropdown-menu-submenu.spec.ts`                                               |
| `dropdown-menu` · `HlmDropdownMenu` / `HlmDropdownMenuSub` | `CdkTargetMenuAim` host directive (#28)                                                                              | `libs/spartan/overlay/src/lib/dropdown-menu-submenu.spec.ts`                                               |
| `dropdown-menu` · `HlmDropdownMenuItem`                    | A destructive item's text and icon use `text-danger`, not upstream's `text-destructive` (#38)                        | `libs/spartan/overlay/src/lib/dropdown-menu-submenu.spec.ts`                                               |

The destructive one is a theming rule, not a behaviour fix. Helm's `--destructive` is a
fill/tint token whose dark value is a near-black maroon (`hsl(0 62.8% 30.6%)`); used as a
foreground on the dark popover surface it measures **1.38:1**, so a "Leave room" row read as an
empty strip. `--trinity-danger` is the token for alert text and icons — see the rule in
`CLAUDE.md` and the token table in [THEMING.md](THEMING.md). The `bg-destructive/10` hover
tints are left as upstream wrote them: a tint is exactly what that token is for.

The last one is a consequence of the one above it. CDK closes an open submenu the moment the
pointer enters any non-trigger sibling row, unless a `MENU_AIM` is provided — and upstream Helm
provides none. While submenus opened _over_ their parent that was unreachable; opening them
beside it means the pointer now travels across those rows. Measured in a browser: without
`CdkTargetMenuAim` a diagonal move into the submenu closes it before you arrive.

Note `libs/spartan/dropdown-menu` has no test target — `libs/spartan/overlay` is the only
spartan lib that runs Vitest, which is why its specs import across the lib boundary.

`hlm-dropdown-menu.ts` has also already diverged in _shape_: the generator emits ~16
one-directive files where the repo keeps a single module. Reconciling a regenerate is manual
work regardless of these overrides.

- **State via signals** — services keep state in private signals exposed as
  `asReadonly()`. **Async service APIs return RxJS Observables** (`defer`/`from` +
  `switchMap`/`map`/`catchError`); components subscribe with `takeUntilDestroyed`.
  The login page wraps its calls in the
  shared `runWithBusy()` helper (via a local `withBusy()` method) for busy/error handling.
- New SDK interaction belongs in the relevant `@trinity/data-access-*` lib, not in a component;
  feature pages live in `@trinity/feature-*` libs. Respect the module boundaries.
- Cross-lib imports use the `@trinity/*` aliases; imports within a lib stay relative.
- Component SCSS shares mixins from `libs/feature-rooms/src/lib/styles/_mixins.scss`.
- Keep `data-testid` hooks on interactive elements that the headless scripts drive.
