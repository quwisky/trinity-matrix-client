# CLAUDE.md

Guidance for Claude Code in this repository. This file loads into every session.

## Project

Cross-platform application built with **Ionic + Angular + Capacitor + Electron**, targeting **iOS, Android, desktop (Windows/macOS/Linux), and web/PWA** from a single codebase.

> Fill in: app name, one-line purpose, and any domain context worth knowing.

## Stack

- **Ionic Framework** (Angular integration) — UI components and theming
- **Angular** — standalone components, signals, typed reactive forms, `inject()`
- **Capacitor** — native bridge for iOS/Android, device plugins
- **Electron** — desktop runtime for Windows/macOS/Linux (main/renderer/preload, packaging, auto-update)
- **Vitest** + Angular **TestBed** — unit/component tests
- **Playwright** — end-to-end tests

## Subagent delegation

Specialized agents live in `.claude/agents/`. Route work to them proactively:

| When the task is about…                                                                         | Delegate to               |
|-------------------------------------------------------------------------------------------------|---------------------------|
| App structure, routing, services, state, scaffolding a feature                                  | `ionic-angular-architect` |
| Device APIs, native plugins, permissions, platform differences, `capacitor.config`, `cap sync`  | `capacitor-native`        |
| Desktop runtime, Electron main/preload, IPC, native menus, packaging, code signing, auto-update | `electron-desktop`        |
| Styling, theming, Ionic components, responsive layout, accessibility                            | `ionic-ui-designer`       |
| Unit/component tests for components, services, guards, pipes                                    | `angular-test-engineer`   |
| End-to-end user journeys and regression coverage                                                | `e2e-test-engineer`       |
| Slowness, bundle size, startup time, pre-release tuning                                         | `mobile-performance`      |

Orchestration defaults:

- For a new feature, start with `ionic-angular-architect` for structure, implement, then hand off to `angular-test-engineer` for coverage.
- For anything touching a device API, consult `capacitor-native` first so web fallbacks and permissions are handled.
- After non-trivial code changes, proactively run `angular-test-engineer`; before a release, run `mobile-performance`.
- Keep verbose work (test runs, bundle analysis, codebase exploration) inside subagents so the main context stays clean.

## Conventions

- Standalone components only; no NgModules in new code.
- Signals for local and computed state; RxJS for streams and async orchestration. Bridge with `toSignal`/`toObservable`.
- `inject()` over constructor injection; typed reactive forms; no `any`.
- Structure as `core/` (singletons, guards, interceptors), `shared/` (reusable UI), and `feature/` folders that own their routes and lazy-load.
- Theme via Ionic CSS variables and `theme/variables.scss`; no hard-coded colors or `!important`.
- Centralize platform branching behind a service (`Platform` from `@ionic/angular`), not ad-hoc `Capacitor.getPlatform()` checks scattered through components. Treat desktop (Electron) as a first-class branch alongside ios/android/web.

## Cross-platform guardrails

- Always feature-detect native plugins (`Capacitor.isNativePlatform()` / `Capacitor.isPluginAvailable()`) and provide a web fallback.
- Never store secrets or tokens in `localStorage` or `Preferences` — use secure storage backed by Keychain/Keystore.
- Run `npx cap sync` after any native dependency or config change; call out when a native rebuild is required.
- Handle the Android hardware back button, safe-area insets, and keyboard/status-bar differences explicitly.
- Respect both Ionic (`ionViewWillEnter`/`ionViewDidLeave`) and Angular lifecycle hooks — don't conflate them.
- On desktop (Electron), keep `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`; expose only a minimal preload API via `contextBridge` and validate all IPC in the main process.
- Detect desktop at runtime and don't call mobile-only Capacitor plugins there — provide a desktop/Electron equivalent or a web fallback.
- Sign and notarize desktop builds; ship auto-updates only over a signed, signature-verified channel.

## Commands

> Adjust to your actual `package.json` scripts.

- Dev server: `pnpm run start`
- Build (web): `pnpm run build`
- Unit tests: `pnpm run test` (Vitest)
- Sync native: `pnpx cap sync`
- Lint: `pnpm run lint`

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
