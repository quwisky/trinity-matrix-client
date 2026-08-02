# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Trinity is a cross-platform [Matrix](https://matrix.org) client with first-class end-to-end
encryption, built from one codebase for **Web (PWA), iOS, Android, and Desktop (Electron)**.
Stack: Angular 22 (standalone + signals) + spartan-ng on Tailwind v4, `matrix-js-sdk` +
Rust crypto WASM, Capacitor 8, and a hand-rolled Electron shell, in an Nx monorepo.

**Companion docs** (read these for depth — do not duplicate them here):
`.claude/CLAUDE.md` (Angular/TypeScript style guide, always applies) · [`.claude/README.md`](.claude/README.md)
(skills · rules catalog) · `.claude/rules/code-quality.md`
(file-size / single-responsibility thresholds) ·
[docs/architecture/](docs/architecture/index.md) (layering · the state pattern ·
[Matrix and encryption](docs/architecture/matrix-and-encryption.md) ·
[UI and theming](docs/architecture/ui-and-theming.md) — design tokens, light/dark × palette,
adding a theme) · [docs/contributing/](docs/contributing/index.md) (setup · commands · testing ·
CI · conventions) · [docs/platforms/](docs/platforms/index.md) (web · desktop · mobile) ·
[docs/reference/stack.md](docs/reference/stack.md) (pinned versions + gotchas) ·
[docs/reference/troubleshooting.md](docs/reference/troubleshooting.md) (the gotcha index) ·
[docs/reference/push-notifications.md](docs/reference/push-notifications.md).

## Commands

This project is **pnpm-only** (a `preinstall` guard aborts npm/yarn) and needs **Node 24.15+**.
Run `corepack enable` once; it picks up the pinned pnpm version.

| Command                        | Purpose                                                               |
| ------------------------------ | --------------------------------------------------------------------- |
| `pnpm start`                   | Web dev server (hot reload) at `:4200` (`nx serve trinity`)           |
| `pnpm build`                   | Production web build → root `www/` (consumed by Capacitor + Electron) |
| `pnpm test`                    | Vitest unit tests, all projects once (`nx run-many -t test`)          |
| `pnpm lint`                    | ESLint + Nx module boundaries, all projects                           |
| `pnpm stylelint`               | Stylelint (SCSS) — **not** part of `pnpm lint`; run separately        |
| `pnpm format` / `format:check` | Prettier write / verify (CI uses `format:check`)                      |

**Single project / single test** — Vitest runs via an `nx:run-commands` target (`vitest run`,
`cwd` = the project dir), so forward Vitest args after `--`:

```bash
pnpm exec nx test data-access-rooms                        # one project
pnpm exec nx test data-access-rooms --configuration=watch  # watch mode
pnpm exec nx test data-access-rooms -- message-list        # files matching a path substring
pnpm exec nx test data-access-rooms -- -t "sends a read receipt"   # one test by name
pnpm exec nx affected -t lint test            # only what changed vs. the base branch
pnpm exec nx reset                            # clear Nx cache if results look stale
```

**Native (Capacitor)** — each `*:run`/`*:build` rebuilds `www/` and `cap sync`s first; re-run a
`*:sync` after any web change. Android needs `ANDROID_HOME`; iOS needs macOS + Xcode.

| Command                          | Purpose                                               |
| -------------------------------- | ----------------------------------------------------- |
| `pnpm android:run` / `ios:run`   | Build → sync → launch on emulator/simulator           |
| `pnpm android:open` / `ios:open` | Open Android Studio / Xcode                           |
| `pnpm android:sync` / `ios:sync` | Build → `cap sync` only                               |
| `pnpm android:build`             | Debug APK → `android/app/build/outputs/apk/debug/`    |
| `pnpm android:build:release`     | Release AAB (needs a signing keystore)                |
| `pnpm ios:build`                 | `cap build ios --scheme App` (needs signing identity) |

**Electron desktop** (hand-rolled shell in `electron/`, its own `package.json`):

| Command                                           | Purpose                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm electron:install`                           | Install the shell's deps and download the Electron binary   |
| `pnpm electron:start`                             | Build + run the desktop shell                                    |
| `pnpm electron:package[:mac\|:linux\|:win\|:all]` | Package for the host OS (or a named target)                      |
| `pnpm electron:package:mac:signed`                | Signed + notarized macOS build (needs Developer ID / creds)      |
| `pnpm electron:e2e`                               | Playwright `_electron` specs against the built app               |

**E2E / protocol harnesses** — Playwright. Install browsers once with
`pnpm exec playwright install chromium webkit`.

| Command                                                                | Purpose                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm exec nx e2e trinity-e2e`                                         | App-journey specs (`@nx/playwright`); skips itself if Docker is absent |
| `pnpm smoke:login`                                                     | Headless redirect→login + live matrix.org `.well-known` discovery      |
| `pnpm spike:chromium` / `spike:webkit`                                 | E2EE WASM check in Blink / WebKit                                      |
| `pnpm e2e:verify`                                                      | Two-client emoji-SAS device verification (needs Docker)                |
| `pnpm e2e:media` / `threads` / `reply` / `spaces` / `rooms` / `search` / `emoji` | Feature round-trips vs. disposable Synapse (needs Docker)              |
| `pnpm e2e:verify:up` / `e2e:verify:down`                               | Start / stop the Synapse Docker harness manually                       |

The Synapse-backed flows (`e2e:verify`, `e2e:media`, `e2e:threads`, `e2e:reply`, `e2e:spaces`,
`e2e:rooms`, `e2e:search`, `e2e:emoji`) each own **one** disposable Synapse Docker stack on fixed ports, so they
**must run sequentially, never concurrently** (e.g. `pnpm e2e:threads && pnpm e2e:spaces`). See
[docs/contributing/testing.md](docs/contributing/testing.md).

## Architecture

**Nx integrated monorepo.** The deployable app is `apps/trinity`; reusable code lives in `libs/*`,
imported via `@trinity/*` path aliases (`tsconfig.base.json`) and guarded by Nx module boundaries.
The web build emits to root `www/` (not `dist/`), which Capacitor and Electron wrap unchanged.

**Layering — dependencies point inward, enforced by `@nx/enforce-module-boundaries`** (`type:*` +
`scope:*` tags in each `project.json`). The former monolithic `@trinity/core` was dissolved into
typed, per-domain libs (do **not** import `@trinity/core` — it no longer exists):

- `@trinity/util-matrix` `[type:util]` — pure, DI-free Matrix models/helpers (`MessageView` +
  `buildMessageView`/`initialOf`/`isEditableMessage`, `MediaPayload`, `MatrixSession`, markdown/sanitize,
  `crypto-wasm-loader`, attachment-crypto). No Angular DI. Everything may depend on it.
- `@trinity/platform-native` `[type:platform]` — Capacitor/native capabilities (session/secure storage,
  preferences, theme/status-bar, launcher badge, desktop bridge, error handler). Branches on
  `isNativePlatform()` internally. May depend only on `util`.
- `@trinity/data-access/matrix-client` `[type:data-access]` — `MatrixClientService` + the 4S key service;
  the client/session foundation every domain data-access lib depends on.
- `@trinity/data-access/*` `[type:data-access]` — one lib per Matrix domain (`media`, `rooms`,
  `timeline`, `crypto`, `profile`, `invites`, `pinned`, `search`, `notifications`, `auth`, `gif`),
  each at `libs/data-access/<domain>`.
  Cross-domain injects are inter-lib edges (search→rooms/invites, auth→media/notifications, notification→timeline).
- `@trinity/feature-*` `[type:feature]` — screens/pages incl. `feature-shell` (the app shell moved out of
  `apps/trinity`). May depend on `data-access-*` + `ui` + `util` + `platform`, **never another feature**.
- `@trinity/ui` + `@trinity/helm/*` (`libs/spartan/*`) `[type:ui]` — **presentational** only; no
  state/SDK deps. Helm is `@spartan-ng/cli`-generated.
- **Scopes:** `scope:shared` (the kernel: util/platform/matrix-client/ui/helm) may not reach into
  `scope:matrix` (domain data-access + feature libs); the thin `apps/trinity` composes both.

**The core rule: components never import `matrix-js-sdk` directly.** All SDK access is wrapped in the
`@trinity/data-access/*` services. New SDK interaction belongs there, not in a component. This keeps the
SDK swappable and the UI testable. A cross-feature dependency the boundary forbids (e.g. the encryption
banner needing crypto status) is resolved by reading the relevant `@trinity/data-access/*` signal from the
feature that owns the surface, or via a provided-loader token (`ENCRYPTION_DIALOG_COMPONENTS`, wired in
`main.ts`) — never by importing the other feature.

**State pattern — the SDK is the single source of truth; there is no Redux store.** `matrix-js-sdk`
already owns rooms/timelines/crypto in memory + IndexedDB and emits events. Data-access services _project_
those `EventEmitter` streams into **read-only Angular signals** (`private writable → asReadonly() →
computed`); components are `OnPush` and read signals directly. **Async actions return cold RxJS
Observables** (`defer`/`from` + operators); components subscribe with `takeUntilDestroyed`. Signals =
state, Observables = one-shot actions. (Login pages wrap calls in `runWithBusy()` for busy/error state.)

**E2EE WASM loading — the single most important platform gotcha.** matrix-js-sdk resolves its
`.wasm` relative to bundled JS, which Angular's esbuild doesn't emit → 404. Fix: the build target
copies the file to `assets/crypto/`, and `crypto-wasm-loader.ts` calls `initAsync(url)` (memoized)
against that path **before** `initRustCrypto()`. Crypto-api types are a **deep import** —
`matrix-js-sdk/lib/crypto-api`, not re-exported from the package root in 41.x.

**Routing** — all lazy-loaded standalone routes in `apps/trinity/src/app/app.routes.ts`, most behind
`authGuard` (restores a persisted session or redirects to `/login`). On wide layouts the
`/encryption/*` routes are also presented as CDK dialogs. Production builds set
`optimization.styles.inlineCritical: false` — the deferred stylesheet `onload` never fires over
Electron's `trinity://` scheme, which broke the desktop dark theme.

## Conventions specific to this repo

- **Component structure**: each component/page in its own directory as `name/name.component.ts` +
  `.html` + `.scss` + `.spec.ts` (logic in `.ts`, styles in `.scss`, template in `.html`).
- **Selectors**: `trn` prefix — elements kebab-case (`trn-avatar`), directives camelCase. Class
  suffix must be `Page` or `Component`.
- **`libs/spartan/*` is generated and owned via `@spartan-ng/cli`** (config in root
  `components.json`). Add/regenerate Helm components with the CLI rather than hand-authoring;
  it's intentionally exempt from the `trn`-prefix and class-suffix ESLint rules. Where upstream
  is wrong we *do* diverge — but on the record: comment it at the site, add it to the banner at
  the top of the file, pin it with a test, and list it under **Vendored spartan overrides** in
  [docs/architecture/ui-and-theming.md](docs/architecture/ui-and-theming.md).
- **Commits use the Conventional Commits convention** (commitlint `commit-msg` hook via
  `@commitlint/config-conventional`): `type(scope): subject` where `type` ∈
  `feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert`. A `pre-commit` hook
  runs lint-staged (eslint --fix + prettier); a module-boundary violation fails the commit.
- **Cross-lib imports use `@trinity/*` aliases**; imports within a lib stay relative.
- **Keep `data-testid` hooks** on interactive elements — the headless Playwright harnesses drive them.
- Shared SCSS mixins live in `libs/feature/rooms/src/lib/styles/_mixins.scss`.
- **Component SCSS references design tokens** (`--trinity-*`; alert **text/icons** =
  `--trinity-danger`, a filled danger badge = `--trinity-danger-solid` +
  `--trinity-danger-solid-foreground`, on-accent text = `--trinity-accent-foreground`, which
  tracks the Helm `--primary-foreground` so a palette overrides one value). Never hardcode
  colours, or they won't re-theme with light/dark or the palette; and never
  use Helm's `--destructive` as a foreground — it's a fill/tint-only token whose dark value
  is a near-black maroon (in a template the alert-text utility is `text-danger`, **not**
  `text-destructive`). Rendered `[innerHTML]` markdown is styled globally in
  `apps/trinity/src/rendered-markdown.scss` (not `::ng-deep`). See [docs/architecture/ui-and-theming.md](docs/architecture/ui-and-theming.md).
- **Desktop detection**: Capacitor's `isNativePlatform()` is `false` in the Electron shell — branch on
  the `trinityDesktop` preload marker to treat desktop like web (service worker off, push off).

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->
