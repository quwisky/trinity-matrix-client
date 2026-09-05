# Commands

This is the canonical command reference. Run Nx through the workspace package manager:
`pnpm nx …`. This package script calls `scripts/nx.mjs`, which normalizes the
command environment before starting the installed Nx CLI. See the
[validation warning ledger](validation-warnings.md). The repository needs Node `^24.15.0` and pnpm `11.19.0`; see
[Getting started](getting-started.md) for installation and [Testing](testing.md) for
which command is meaningful for a change.

## Web, workspace, and formatting

| Command                   | Purpose                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- |
| `pnpm start`              | Start the development web server, normally on port 4200                           |
| `pnpm build`              | Build the production web bundle into root `www/`                                  |
| `pnpm watch`              | Rebuild the development bundle on change without serving it                       |
| `pnpm test`               | Run every Nx `test` target once                                                   |
| `pnpm lint`               | Run every Nx `lint` target                                                        |
| `pnpm stylelint`          | Check SCSS and CSS; it is separate from `pnpm lint`                               |
| `pnpm format:check`       | Check Prettier formatting                                                         |
| `pnpm format`             | Write Prettier formatting                                                         |
| `pnpm architecture:check` | Validate repository architecture, host, design-system, and E2E registry contracts |
| `pnpm storybook`          | Start the shared public-component Storybook                                       |
| `pnpm storybook:build`    | Build that Storybook                                                              |

`pnpm test` executes project test targets; the application libraries use Vitest, while
the desktop shell uses its own Vitest installation and Node-environment configuration. These tests do **not** type-check source or specs. A change that
needs type safety also needs a relevant `typecheck` target; see
[Testing](testing.md#tests-type-checking-and-style-are-separate).

## Inspect and focus Nx work

A project is not always named after its folder. Inspect resolved configuration before
choosing a target:

```bash
pnpm nx show project trinity --json
pnpm nx show project data-access-room-library --json
```

The application-library Vitest targets use `nx:run-commands` and forward arguments.
Put Vitest arguments after `--`; inspect other projects before assuming the same runner:

```bash
pnpm nx test data-access-room-library
pnpm nx test data-access-room-library --configuration=watch
pnpm nx test data-access-room-library -- account-scope.service
pnpm nx test data-access-room-library -- -t "refuses to hide the active account"
pnpm nx run-many -t typecheck
pnpm nx affected -t lint test
pnpm nx reset
```

`affected` compares with the configured or supplied base, so check that base in a
nonstandard branch workflow. `reset` clears Nx state when results look inconsistent.
Neither replaces a focused behavior check.

## Desktop

Electron has separate dependencies under `electron/`.

| Command                   | Purpose                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `pnpm electron:install`   | Install shell dependencies and ensure the Electron binary is present |
| `pnpm electron:start`     | Build and launch the development shell                               |
| `pnpm electron:test`      | Run desktop unit tests                                               |
| `pnpm electron:typecheck` | Type-check the desktop shell                                         |
| `pnpm electron:verify`    | Run the static desktop host contract                                 |
| `pnpm electron:e2e`       | Run full launched-shell E2E                                          |
| `pnpm electron:e2e:smoke` | Run the focused launched-shell smoke check                           |
| `pnpm electron:package`   | Package for the current host                                         |

Named package commands (`electron:package:mac`, `:linux`, `:win`, and `:all`) need
the matching host and signing prerequisites. See [Desktop](../platforms/desktop.md) before
packaging or signing.

## Native hosts

| Command                                     | Purpose                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm android:sync` / `pnpm ios:sync`       | Build web output and synchronize it to Capacitor                              |
| `pnpm android:open` / `pnpm ios:open`       | Open the generated native project in its host IDE                             |
| `pnpm android:run` / `pnpm ios:run`         | Build, synchronize, and launch a native host                                  |
| `pnpm android:build` / `pnpm ios:build`     | Build the Android debug APK or iOS app                                        |
| `pnpm android:build:release`                | Build the Android release AAB; unsigned unless external signing is configured |
| `pnpm android:verify` / `pnpm ios:verify`   | Check static host contracts                                                   |
| `pnpm nx run trinity-android:verify-native` | Run Android native unit validation                                            |
| `pnpm nx run trinity-ios:verify-native`     | Build unsigned iOS simulator target; requires macOS and Xcode                 |

Android needs its SDK; iOS needs macOS and Xcode. Platform prerequisites, artifacts, and
signing limits are in [Mobile](../platforms/mobile.md).

## End-to-end and protocol checks

Install browser binaries before a browser suite:

```bash
pnpm exec playwright install chromium webkit
```

| Command                                                                                            | Purpose                                                   |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `pnpm e2e`                                                                                         | Run the pull-request-classified E2E aggregate             |
| `pnpm e2e:all`                                                                                     | Run every locally available required E2E suite            |
| `pnpm e2e:scheduled`                                                                               | Run the scheduled E2E aggregate                           |
| `pnpm e2e:browser`                                                                                 | Run canonical browser journeys against disposable Synapse |
| `pnpm e2e:components`                                                                              | Run registered component, styling, and scrollbar suites   |
| `pnpm nx run trinity-e2e-browser:e2e -- conversations/message-links.spec.mts`                      | Focus a browser journey by path                           |
| `pnpm nx run trinity-e2e-browser:e2e -- --grep "message link"`                                     | Focus a browser journey by title                          |
| `pnpm nx run trinity-e2e-web:production-pwa`                                                       | Run Docker-free production Web/PWA host checks            |
| `pnpm e2e:web`                                                                                     | Run Web/PWA host and production-renderer checks           |
| `pnpm e2e:protocol`                                                                                | Run registered protocol/system suites                     |
| `pnpm e2e:electron`                                                                                | Run registered Electron E2E suites                        |
| `pnpm smoke:login`                                                                                 | Run redirect-to-login and live discovery smoke            |
| `pnpm spike:chromium` / `pnpm spike:webkit`                                                        | Run focused crypto renderer spikes                        |
| `pnpm e2e:verify` / `pnpm e2e:verify:qr`                                                           | Run two-client SAS or QR verification                     |
| `pnpm e2e:verify:up` / `pnpm e2e:verify:down`                                                      | Manually start or stop the disposable Synapse harness     |
| `pnpm e2e:media`, `e2e:threads`, `e2e:reply`, `e2e:spaces`, `e2e:rooms`, `e2e:search`, `e2e:emoji` | Run focused Synapse-backed protocol journeys              |
| `pnpm e2e:android`                                                                                 | Run shared journeys in a managed Android WebView          |
| `pnpm electron:e2e`                                                                                | Run Electron shell E2E                                    |

Synapse-backed targets share a fixed-port disposable stack. Run them sequentially, never
in parallel; the aggregate owns safe sequencing. Missing Docker, a browser, an Android
emulator, or an Electron display is unavailable validation or a failed preflight, not a
passing skipped suite. See [E2E architecture](e2e-architecture.md) for ownership and
[the E2E router](../../e2e/README.md) for task-based entry points.
