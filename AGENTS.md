# AGENTS.md

Guidance for coding agents working in this repository — Claude Code, Codex, Cursor, and
whatever comes next. `CLAUDE.md` points here; this is the file to edit.

Trinity is a cross-platform [Matrix](https://matrix.org) client with first-class end-to-end
encryption, built from one codebase for **Web (PWA), iOS, Android, and Desktop (Electron)**.
Stack: Angular 22 (standalone + signals) + spartan-ng on Tailwind v4, `matrix-js-sdk` +
Rust crypto WASM, Capacitor 8, and a hand-rolled Electron shell, in an Nx monorepo.

**Companion docs** (read these for depth — do not duplicate them here):
`.claude/CLAUDE.md` (Angular/TypeScript style guide, always applies) · [`.agents/README.md`](.agents/README.md)
(skills · rules catalog) · `.agents/rules/code-quality.md`
(file-size / single-responsibility thresholds) ·
[docs/architecture/](docs/architecture/index.md) (layering · the state pattern ·
[Matrix and encryption](docs/architecture/matrix-and-encryption.md) ·
[UI and theming](docs/architecture/ui-and-theming.md) — design tokens, light/dark × palette,
adding a theme) · [docs/contributing/](docs/contributing/index.md) (setup · commands · testing ·
CI · conventions) · [docs/platforms/](docs/platforms/index.md) (web · desktop · mobile) ·
[docs/reference/stack.md](docs/reference/stack.md) (pinned versions + gotchas) ·
[docs/reference/troubleshooting.md](docs/reference/troubleshooting.md) (the gotcha index) ·
[docs/reference/push-notifications.md](docs/reference/push-notifications.md).

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues for `quwisky/trinity-matrix-client`. See
`docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five canonical mattpocock/skills labels. See
`docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses a single-context layout. See `docs/agents/domain.md`.

## Commands

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
[docs/contributing/testing.md](docs/contributing/testing.md).

## Architecture

**Nx integrated monorepo.** The deployable app is `apps/trinity`; reusable code lives in `libs/*`,
imported via `@trinity/*` path aliases (`tsconfig.base.json`) and guarded by Nx module boundaries.
The web build emits to root `www/` (not `dist/`), which Capacitor and Electron wrap unchanged.

**Layering — dependencies point inward, enforced by `@nx/enforce-module-boundaries`** (`type:*` +
`scope:*` + `ui:*` tags in each `project.json`). The former monolithic `@trinity/core` was dissolved into
typed, per-domain libs (do **not** import `@trinity/core` — it no longer exists):

- `@trinity/util/matrix` `[type:util]` — pure, DI-free Matrix models/helpers (`MediaPayload`,
  `MatrixSession`, markdown/sanitize, `crypto-wasm-loader`, attachment-crypto). No Angular DI.
  Everything may depend on it. Render-ready message models belong to Conversations.
- `@trinity/runtime/projection` `[type:data-access]`, `[role:kernel]` — Projection Runtime: the
  bounded active-account, all-live-accounts, exact-account, and exact-conversation lifecycle
  primitive. It owns attachment, coalesced reconciliation, generation-safe publication, reset,
  scoped reattachment, finite readiness barriers, and resource diagnostics without owning product
  state or SDK types. Active Account switches use `transition(active-account)` to rebind and
  acknowledge every live account-scoped projection before the Workspace is repaired.
- `@trinity/application/runtime` `[type:feature]`, `[role:application]` — Application Runtime:
  ordered host, preference, Account, session-capability, Workspace, and readiness stages; typed
  executable blocked recovery and visible optional warnings; explicit recover/stop/restart; and one owned session-long
  stream for deep links, Back, route focus, badges, updates, and surface registration. Its deep
  provider interface owns concrete adapters and cross-capability bindings; the app entrypoint
  supplies routes, environment values and lazy loaders, then starts its lifetime subscription.
- `@trinity/runtime/host` `[type:platform]`, `[role:kernel]` — Host Capabilities: narrow operation
  contracts and explicit supported/unavailable manifests for authentication handoff, deep links,
  Back, file export, notification presentation, location, badges, secure storage, lifecycle, and
  updates. Product commands are cold finite Observables; Web, Capacitor, and Electron selection
  stays in the composition adapter.
- `@trinity/runtime/preferences` `[type:platform]`, `[role:kernel]` — Preferences Store: a
  policy-free typed descriptor catalog and context-keyed signal store. Capabilities own defaults,
  validation, migration, sensitivity, editor metadata, and explicit installation, Account,
  Conversation, or server-authoritative scope. Hydration and updates are cold finite Observables;
  ordered legacy keys are read-only and upgrade into the authoritative current envelope before
  publication. Adapters enforce storage/export policy and diagnostics never expose values.
- `@trinity/platform-native` `[type:platform]` — Capacitor/native capabilities (session/secure storage,
  the device-preference adapter, theme/status-bar, launcher badge, external browser, desktop bridge, error handler). Branches on
  `isNativePlatform()` internally. May depend only on `util`.
- `@trinity/data-access/accounts` `[type:data-access]` — Account Runtime: read-only lifecycle state plus
  cold, finite restoration, authenticated-establishment, atomic switch, explicit Account sign-out,
  and installation-reset commands with Active Account priority, bounded per-Account outcomes,
  cancellation before commit, uninterruptible post-commit cleanup, joinable identical attempts,
  explicit lifecycle conflicts, and secret-safe failure metadata. Authentication crosses into it
  through an opaque grant; its production adapter composes session storage with Matrix Runtime.
- `@trinity/data-access/matrix-client` `[type:data-access]` — `MatrixClientService` + the 4S key service;
  the client/session foundation every domain data-access lib depends on, and the Matrix adapter for
  the first Projection Runtime tracer (per-Account sync state and readiness acknowledgement).
- `@trinity/data-access/*` `[type:data-access]` — capability and adapter libraries (`accounts`,
  `auth`, `discovery`, `gif`, `homeserver`, `identity`, `matrix-client`, `media`, `notifications`,
  `room-administration`, `room-library`, `timeline`, `trust`, `widgets`), each at
  `libs/data-access/<domain>`.
  Room Library owns room/space summaries, invitations, hierarchy, ordering, filtering and
  aggregate unread; its one-shot mutations, including account-scope and ordering persistence,
  favourite/priority writes, hierarchy changes and unread cleanup, are cold finite Observables.
  Room Administration owns authoritative joined-member and ban summaries, role classification and
  assignable presets, moderation, aliases,
  power-level policy, room configuration, and Conversation governance. Discovery owns remote
  homeserver, public-room, room-link and user-directory lookup; Global Search lives at
  `@trinity/application/search` and combines Discovery with Room Library. Cross-domain injects are
  explicit inter-lib edges (auth→accounts, notification→room-library/timeline, timeline→media).
- `@trinity/data-access/timeline` owns `ConversationRuntime` and Message Presentation: immutable
  Account-and-Room handles with one timeline child each, a two-entry per-Account retained LRU,
  permanent retirement, exact child-bound message search, a stable focused-timeline interface, and the Conversations privacy
  preference descriptors. Normalize SDK events first, then expose immutable `MessageView` models
  from this public entrypoint.
- `@trinity/feature/*` `[type:feature]` — screens/pages incl. `feature-shell` (the app shell moved out of
  `apps/trinity`). May depend on `data-access-*` + `ui` + `util` + `platform`, **never another feature**.
- `@trinity/components/{foundations,controls,generic-content,navigation-layout,overlay}`
  (`libs/components/*`) `[type:ui]`, tagged `ui:public` — the **public component tier**:
  five category-owned entrypoints plus the non-consumable Storybook host. It contains only
  domain-neutral Trinity APIs; every entrypoint uses named exports, and vendors remain behind
  those APIs. Product presentation such as the message toolbar and media bubble lives with
  Conversations under `feature/rooms`; application-surface loaders live in Application Runtime.
- `@trinity/util/ui` (`libs/util/ui`) `[type:util]` — the view-layer helpers that are not
  components: `runWithBusy`, `mediaQuerySignal` + the `MD_QUERY`/`BELOW_MD_QUERY` breakpoints,
  and `resolveInternalReturnTo`. DI-free like the rest of `type:util` — both helpers TAKE a
  `DestroyRef` rather than injecting one, so neither needs an injection context.
- `@trinity/helm/*` (`libs/spartan/*`) `[type:ui]`, tagged `ui:vendor-wrapper` — the vendored
  `@spartan-ng/cli`-generated kit, `hlm` prefix. Consume it through `@trinity/components/*`
  rather than directly.
  Both are **presentational** only; no state/SDK deps.
- **Third-party UI stops at the UI tier.** The `ui:*` tag splits it in two — `libs/components`
  is `ui:public`, the vendored kit is `ui:vendor-wrapper` — and `bannedExternalImports` keeps
  `@spartan-ng/brain`, `@angular/cdk`, `@ng-icons` and `@ctrl/ngx-emoji-mart` out of every
  tier below. Both UI tiers may name a vendor, because both ARE wrapper layers; what contains
  the public tier is the other direction, a `no-restricted-imports` ban stopping
  `libs/feature` and `apps` reaching past it into `@trinity/helm/*`. A new vendor import
  below the UI tier fails `pnpm lint`.
- **Scopes:** `scope:shared` (the kernel: util/platform/projection/matrix-client/ui/helm) may not reach into
  `scope:matrix` (domain data-access + feature libs); the thin `apps/trinity` composes both.

**The core rule: components never import `matrix-js-sdk` directly.** All SDK access is wrapped in the
`@trinity/data-access/*` services. New SDK interaction belongs there, not in a component. This keeps the
SDK swappable and the UI testable. A cross-feature dependency the boundary forbids (e.g. the encryption
banner needing crypto status) is resolved by reading the relevant `@trinity/data-access/*` signal from the
feature that owns the surface, or via an Application Runtime loader token
(`ENCRYPTION_DIALOG_COMPONENTS`, wired in `main.ts`) — never by importing the other feature.

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
`matrix-js-sdk/lib/crypto-api`, not re-exported from the package root (checked again in 42.x).

**Routing** — all lazy-loaded standalone routes in `apps/trinity/src/app/app.routes.ts`, most behind
`authGuard` (restores saved Accounts through Account Runtime or redirects to `/login`). On wide layouts the
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
  is wrong we _do_ diverge — but on the record: comment it at the site, add it to the banner at
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
- **A Tailwind utility loses to an unlayered rule, whatever the specificity.** Theme Foundation's
  private Tailwind adapter
  imports Tailwind into `@layer utilities`; Angular component styles and `global.scss` are
  UNLAYERED, and an unlayered author declaration always wins. So `md:hidden` on a component with
  its own `:host { display: … }` does nothing, and pairing `.safe-*` with `p-3` REPLACES the
  padding on that side instead of adding to it. Three separate bugs came from this. If a utility
  "does nothing", check the layer before anything else — and compose an inset with its padding in
  one declaration (see `.panel-header` in `global.scss`) rather than stacking the two classes.
- **Platform vs capability are different questions, and both predicates exist.** `isMobileOs()`
  (`@trinity/platform-native`) asks the OS and picks the INTERACTION MODEL — a bottom sheet is an
  iOS/Android convention, and a touchscreen Windows laptop should not be handed one. A
  `(pointer: coarse)` media query asks whether a finger is driving, which is what decides how big
  a target must be. Use the one that matches the question; they are not interchangeable and are
  not in conflict.
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
