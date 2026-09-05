# Commands

This project is **pnpm-only** (a `preinstall` guard aborts npm/yarn) and needs **Node 24.15+**.
Run `corepack enable` once; it picks up the pinned pnpm version.

| Command                        | Purpose                                                                    |
| ------------------------------ | -------------------------------------------------------------------------- |
| `pnpm start`                   | Web dev server (hot reload) at `:4200` (`nx serve trinity`)                |
| `pnpm build`                   | Production web build → root `www/` (consumed by Capacitor + Electron)      |
| `pnpm test`                    | Vitest unit tests, all projects once (`nx run-many -t test`)               |
| `pnpm lint`                    | ESLint + Nx module boundaries, all projects                                |
| `pnpm stylelint`               | Stylelint (SCSS **and CSS**) — **not** part of `pnpm lint`; run separately |
| `pnpm format` / `format:check` | Prettier write / verify (CI uses `format:check`)                           |
| `pnpm storybook`               | Storybook for the whole `libs/components/*` tier (one host project)        |
| `pnpm storybook:build`         | Static Storybook build                                                     |

**Single project / single test** — Vitest runs via an `nx:run-commands` target (`vitest run`,
`cwd` = the project dir), so forward Vitest args after `--`. Note the argument is the **Nx
project name**, which since the libs were nested is neither the directory nor the alias:
`data-access-room-library` is at `libs/data-access/room-library` and imports as
`@trinity/data-access/room-library`.

```bash
pnpm nx test data-access-room-library                        # one project
pnpm nx test data-access-room-library --configuration=watch  # watch mode
pnpm nx test data-access-room-library -- message-list        # path substring
pnpm nx test data-access-room-library -- -t "marks a room read" # one test
pnpm nx affected -t lint test            # only what changed vs. the base branch
pnpm nx reset                            # clear Nx cache if results look stale
```

**`pnpm test` does not typecheck.** Vitest transpiles specs without checking them, so a type
error in a spec passes the test run and only fails `nx run-many -t typecheck`. Run both before
claiming a tree is green, and check exit codes rather than grepping output — Nx prints
`✘ [ERROR]` and `Failed tasks:` in forms a naive grep misses.

**jsdom has no layout and evaluates no media queries.** It cannot see a rendered size, an element
covering another, a cascade result, or anything behind a `@media` rule — a unit test asserting
those passes for the wrong reason. Those claims belong in `e2e/browser/journeys/`, and a mobile one
needs a real device profile (`devices['Pixel 5']`), not `hasTouch`: a touch-emulated desktop
Chromium keeps its desktop user agent and silently takes the desktop path. Note also that
Playwright counts `opacity: 0` as **visible**, so assert on the class that hides a thing rather
than on its visibility.

**`scripts/*.spec.mjs` are source-shape guards** encoding decisions the type system
cannot: the module boundaries, the styling idiom LEDGER, the breakpoint copies, the
`hostDirectives` contract, the config-key ledger, the `trn-message-row` consumer list. When one
fails, read its docstring before changing the code — it usually knows something you do not.
Deleting a component stylesheet means pruning `styling-idiom.spec.mjs`, which asserts exact
equality.

**Never commit design prototypes, screenshots, GIF proof, or pixel baselines.** Generate UI proof
under ignored test output and attach it directly to the pull request. Application assets such as
icons, splash screens and bundled artwork remain tracked in their platform/app asset directories.
`scripts/repository-media-policy.spec.mjs` enforces the distinction.

**Native (Capacitor)** — `trinity-android` and `trinity-ios` are explicit Nx applications.
Each `*:run`/`*:build` rebuilds `www/` and `cap sync`s first; re-run a `*:sync` after any web
change. Android needs `ANDROID_HOME`; iOS needs macOS + Xcode.

| Command                              | Purpose                                               |
| ------------------------------------ | ----------------------------------------------------- |
| `pnpm android:run` / `ios:run`       | Build → sync → launch on emulator/simulator           |
| `pnpm android:open` / `ios:open`     | Open Android Studio / Xcode                           |
| `pnpm android:sync` / `ios:sync`     | Build → `cap sync` only                               |
| `pnpm android:build`                 | Debug APK → `android/app/build/outputs/apk/debug/`    |
| `pnpm android:build:release`         | Release AAB (needs a signing keystore)                |
| `pnpm ios:build`                     | `cap build ios --scheme App` (needs signing identity) |
| `pnpm android:verify` / `ios:verify` | Static Nx/artifact/capability host contract           |

The direct toolchain gates are `pnpm nx run trinity-android:verify-native` and
`pnpm nx run trinity-ios:verify-native`; the latter requires macOS and Xcode.

**Electron desktop** (hand-rolled shell in `electron/`, its own `package.json`):

| Command                                           | Purpose                                                     |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm electron:install`                           | Install the shell's deps and download the Electron binary   |
| `pnpm electron:test` / `electron:typecheck`       | Run the Nx-owned shell unit and type contracts              |
| `pnpm electron:verify`                            | Static Nx/artifact/bridge/security/package contract         |
| `pnpm electron:start`                             | Build + run the desktop shell                               |
| `pnpm electron:package[:mac\|:linux\|:win\|:all]` | Package for the host OS (or a named target)                 |
| `pnpm electron:package:mac:signed`                | Signed + notarized macOS build (needs Developer ID / creds) |
| `pnpm electron:e2e`                               | Playwright `_electron` specs against the built app          |
| `pnpm electron:e2e:smoke`                         | Docker-free launched-shell protocol/security proof          |

**E2E / protocol harnesses** — Playwright. Install browsers once with
`pnpm exec playwright install chromium webkit`.

| Command                                                                          | Purpose                                                              |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm nx run trinity-e2e-browser:e2e`                                            | Capability-owned app journeys against disposable Synapse             |
| `pnpm nx run trinity-e2e-web:production-pwa`                                     | Production Web/PWA startup, deep-link and offline check; no Docker   |
| `pnpm e2e:web`                                                                   | Web/PWA host plus renderer matrix; renderer needs Docker             |
| `pnpm smoke:login`                                                               | Headless redirect→login + live matrix.org `.well-known` discovery    |
| `pnpm spike:chromium` / `spike:webkit`                                           | E2EE WASM check in Blink / WebKit                                    |
| `pnpm e2e:verify`                                                                | Two-client emoji-SAS device verification (needs Docker)              |
| `pnpm e2e:verify:qr`                                                             | Two-client QR verification through a synthetic camera (needs Docker) |
| `pnpm e2e:media` / `threads` / `reply` / `spaces` / `rooms` / `search` / `emoji` | Feature round-trips vs. disposable Synapse (needs Docker)            |
| `pnpm e2e:verify:up` / `e2e:verify:down`                                         | Start / stop the Synapse Docker harness manually                     |

The Synapse-backed flows (`e2e:verify`, `e2e:verify:qr`, `e2e:media`, `e2e:threads`, `e2e:reply`, `e2e:spaces`,
`e2e:rooms`, `e2e:search`, `e2e:emoji`) each own **one** disposable Synapse Docker stack on fixed ports, so they
**must run sequentially, never concurrently** (e.g. `pnpm e2e:threads && pnpm e2e:spaces`). See
[docs/contributing/testing.md](../contributing/testing.md).
