# Commands

Every command here is run from the repository root with pnpm. If you have not set
the repo up yet, start with [Getting started](getting-started.md).

## Web and day to day

| Command             | What it does                                                               |
| ------------------- | -------------------------------------------------------------------------- |
| `pnpm start`        | `nx serve trinity` — dev server with hot reload on `http://localhost:4200` |
| `pnpm build`        | `nx build trinity` — **production** bundle into root `www/`                |
| `pnpm watch`        | Development build, rebuilt on change, no server                            |
| `pnpm test`         | `nx run-many -t test` — Vitest once across every project that has tests    |
| `pnpm lint`         | `nx run-many -t lint` — ESLint plus Nx module boundaries                   |
| `pnpm stylelint`    | Stylelint over `{apps,libs}/**/*.scss`                                     |
| `pnpm format`       | Prettier write, all files                                                  |
| `pnpm format:check` | Prettier verify, all files — what CI runs                                  |

Two of these surprise people:

- **`pnpm build` is a production build.** The `build` target sets
  `defaultConfiguration: production`, so a bare `nx build trinity` optimises,
  hashes filenames, swaps in `environment.prod.ts` and emits the service worker
  manifest. Every `electron:*`, `android:*` and `ios:*` script calls it, so those
  paths are production too. Only the end-to-end and spike scripts explicitly pass
  `--configuration=development`.
- **`pnpm stylelint` is not part of `pnpm lint`.** They are separate commands and
  separate CI steps. Running only `pnpm lint` will not catch a SCSS violation.

## Nx patterns

The `test` target is defined once in `nx.json` as an `nx:run-commands` target that
runs `vitest run` with `cwd` set to the project directory. Each project opts in
with an empty `"test": {}` in its own `project.json`. Because it is run-commands
rather than a Vitest executor, **Vitest arguments must come after `--`**, where
they are appended to the end of `vitest run`.

```bash
pnpm exec nx test util-matrix                          # one project
pnpm exec nx test feature-rooms --configuration=watch  # watch mode
pnpm exec nx test data-access-rooms -- message-list    # files matching a path substring
pnpm exec nx test data-access-rooms -- -t "sends a read receipt"   # one test by name
pnpm exec nx test data-access-rooms -- --coverage      # coverage is opt-in, no threshold
pnpm exec nx affected -t lint test                     # only what changed versus develop
pnpm exec nx show projects                             # the real project names
pnpm exec nx graph                                     # dependency graph in a browser
```

!!! warning "There is no Nx project called `core`"

    Older examples in this repository and its history use
    `pnpm exec nx test core`. `@trinity/core` was dissolved into per-domain
    libraries and no project by that name exists, so the command fails with
    `Cannot find configuration for task core:test`. Use a real project name —
    `util-matrix`, `data-access-rooms`, `feature-rooms`, and so on. Run
    `pnpm exec nx show projects` when in doubt.

`nx affected` diffs against `develop`, which is `defaultBase` in `nx.json`.

Caching: `test`, `lint` and `build` are all cached. To reproduce something
intermittent, add `--skip-nx-cache`.

| Reset command                            | Clears                                                            |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `pnpm exec nx reset`                     | Everything, including the daemon and the workspace data directory |
| `pnpm exec nx reset --onlyCache`         | Task results only, under `.nx/cache`                              |
| `pnpm exec nx reset --onlyWorkspaceData` | The metadata directory `.nx/workspace-data`                       |

Nx keeps its task history in a SQLite database under `.nx/workspace-data`, not in
`.nx/cache`. That is why `--onlyCache` does not clear a "Nx detected a flaky task"
warning: one historical failure keeps resurfacing on later green runs until the
workspace data goes too.

### What `pnpm test` does not cover

`pnpm test` runs 23 projects: the `data-access-*` libraries, `feature-auth`,
`feature-crypto`, `feature-rooms`, `feature-settings`, `feature-shell`,
`platform-native`, `ui`, `util-matrix`, the `overlay` spartan library, the
`trinity` app itself, and `scripts`.

It does **not** run the Electron main-process specs. The `trinity-desktop` project
is inferred from `electron/` and exposes only a `lint` target — its `test` script
is not surfaced as an Nx target, so `nx run-many -t test` skips it entirely. A
change under `electron/src/` can pass locally and fail CI's `desktop` job. Run them
explicitly:

```bash
pnpm -C electron test
```

Also outside `pnpm test`: `trinity-e2e` (Playwright, run separately), `libs/testing`
(the shared render wrapper has no specs of its own), and the generated
`libs/spartan/*` Helm packages other than `overlay`, which are lint and build only.

## Desktop

| Command                            | What it does                                                      |
| ---------------------------------- | ----------------------------------------------------------------- |
| `pnpm electron:install`            | Install `electron/` dependencies and download the Electron binary |
| `pnpm electron:build`              | Web build, then copy `www/` into the shell and compile it         |
| `pnpm electron:start`              | Build, then launch the desktop app                                |
| `pnpm -C electron test`            | Electron main-process unit tests, Node environment                |
| `pnpm -C electron run compile`     | Type-check the shell only                                         |
| `pnpm electron:e2e`                | Playwright specs against the real built binary                    |
| `pnpm electron:package`            | Package for the host OS                                           |
| `pnpm electron:package:mac`        | macOS, ad-hoc dev-signed                                          |
| `pnpm electron:package:mac:signed` | macOS, Developer ID signed and notarized — needs credentials      |
| `pnpm electron:package:linux`      | Linux AppImage and deb                                            |
| `pnpm electron:package:win`        | Windows NSIS installer                                            |
| `pnpm electron:package:all`        | All three targets                                                 |

`electron:build` chains four steps: `pnpm build` (a production Angular build),
`electron:install`, the shell's own copy-plus-compile, and a macOS-only ad-hoc
codesign of the development Electron binary. Everything above it in the table
chains off it, which is why the desktop path is slower than it looks and why a
desktop run always exercises production output.

Two constraints on packaging:

- **Do not use `electron:build` or any `electron:package:*` in CI.** They end in
  the dev-signing step, which ad-hoc-codesigns the development Electron binary
  against a local self-signed `trinity-dev` identity that no runner has. It
  self-skips off macOS now, but the step is still useless in CI, so the release
  workflow runs the three useful steps directly instead.
- **`electron:package:mac` hardcodes an arm64 output path.** On an Intel Mac it
  builds the app into `release/mac/` and then dies trying to codesign
  `release/mac-arm64/Trinity.app`.

`pnpm electron:e2e` needs a display. On headless Linux or in a container, wrap it:

```bash
xvfb-run -a pnpm electron:e2e
```

## Native platforms

Each of these runs `pnpm build` and then `cap sync` before it does anything else,
so a web change is always included. Re-run a `*:sync` after any web change if you
are iterating in Xcode or Android Studio.

| Command                      | What it does                                         | Needs                          |
| ---------------------------- | ---------------------------------------------------- | ------------------------------ |
| `pnpm android:sync`          | Build and sync only                                  | Android SDK                    |
| `pnpm android:run`           | Build, sync, launch on a device or emulator          | Android SDK                    |
| `pnpm android:open`          | Open the project in Android Studio                   | Android Studio                 |
| `pnpm android:build`         | Debug APK into `android/app/build/outputs/apk/debug` | Android SDK                    |
| `pnpm android:build:release` | Release AAB                                          | Android SDK, signing keystore  |
| `pnpm ios:sync`              | Build and sync only                                  | macOS, Xcode                   |
| `pnpm ios:run`               | Build, sync, launch on a simulator                   | macOS, Xcode                   |
| `pnpm ios:open`              | Open the project in Xcode                            | macOS, Xcode                   |
| `pnpm ios:build`             | `cap build ios --scheme App`                         | macOS, Xcode, signing identity |

## End to end harnesses

There are three distinct kinds, and they do not share an entry point.

### The app journey suite

```bash
pnpm exec nx e2e trinity-e2e
pnpm exec nx e2e trinity-e2e -- --list        # enumerate specs without running them
pnpm exec nx e2e trinity-e2e -- --retries=0   # honest first-attempt result
```

Chromium only. Its own `webServer` produces a **development** build and serves
`www/` statically, and its global setup brings the disposable Synapse stack up and
tears it down. Without Docker the authenticated specs skip themselves; under `CI`
that graceful degradation is deliberately turned off and a missing Docker fails the
run instead, so a runner that cannot reach Docker cannot report green.

The config sets `retries: 2` unconditionally, including locally. A spec that fails
once and passes on retry is reported as _flaky_, not failed, which is easy to skim
past — pass `--retries=0` when you want the truth.

### Standalone protocol harnesses

Raw Playwright scripts under `e2e/features/`, each serving `www/` on its own port
and printing `RESULT: PASS` or `RESULT: FAIL`. Every one of them builds the app with
`--configuration=development` first, which matters: the `/spike` route the crypto
harnesses drive is compiled out of production builds entirely.

| Command               | What it proves                                                        | Docker  |
| --------------------- | --------------------------------------------------------------------- | ------- |
| `pnpm spike:chromium` | E2EE crypto WASM initialises in Blink                                 | no      |
| `pnpm spike:webkit`   | The same in WebKit, standing in for iOS WKWebView                     | no      |
| `pnpm smoke:login`    | Unauthenticated redirect to `/login` plus live `matrix.org` discovery | no      |
| `pnpm e2e:verify`     | Two-device emoji-SAS verification round trip                          | **yes** |
| `pnpm e2e:media`      | Encrypted attachment upload with a caption, through the composer      | **yes** |
| `pnpm e2e:threads`    | Thread lifecycle, including lazy thread creation                      | **yes** |
| `pnpm e2e:reply`      | Reply header and preview rendering                                    | **yes** |
| `pnpm e2e:spaces`     | Space creation, channel creation, sidebar state                       | **yes** |
| `pnpm e2e:rooms`      | Room and DM creation, invite lifecycle                                | **yes** |
| `pnpm e2e:search`     | Quick switcher and in-room message search                             | **yes** |
| `pnpm e2e:emoji`      | Shortcode autocomplete and the emoji picker in the composer           | **yes** |

`smoke:login` reaches the public internet: it performs real `.well-known`
discovery against `matrix.org`. It needs no credentials.

To hold the Synapse stack up across several manual runs:

```bash
pnpm e2e:verify:up     # start Synapse, Caddy and Dex
pnpm e2e:verify:down   # stop and delete their state
```

!!! danger "The Synapse-backed suites must run one at a time"

    Every Docker-backed entry point owns *the same* stack: fixed ports 8008, 8448
    and 5556, and one shared `e2e/synapse/data` state directory. Running two of
    them at once, or running one alongside `nx e2e trinity-e2e`, means two
    orchestrators fighting over one homeserver and one state directory, and the
    second teardown deletes the first run's data underneath it. Chain them with
    `&&` instead: `pnpm e2e:threads && pnpm e2e:spaces`.

### Desktop specs

```bash
pnpm electron:e2e            # on a machine with a display
xvfb-run -a pnpm electron:e2e   # headless Linux or CI
```

These launch the real packaged-shape binary through Playwright's `_electron`, each
spec with a fresh user-data directory so the app always boots unauthenticated. They
are the only browser-driven gate on the **production** build, and the only gate on
the custom `trinity://app` scheme, the preload bridge and the desktop dark theme.

## Reading a failed unit run

Two failure modes look nothing alike:

| What you see                                           | What happened                                                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| A `Killed` line and a missing project summary          | The process was OOM-killed. The tests did not fail, they never reported.                                                   |
| All summaries present plus an `Unhandled Errors` block | Something escaped a test's lifetime, usually a timer firing after teardown. Exit code is non-zero with every test passing. |

In both cases, judge by the exit code. Grepping the output for "error" matches
neither, because Nx and esbuild print `✘ [ERROR]` and `Failed tasks`.

More on what each layer of the test suite is for, and the traps inside the specs
themselves, is in [Testing](testing.md).
