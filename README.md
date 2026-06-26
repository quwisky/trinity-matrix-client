# Trinity

A multiplatform [Matrix](https://matrix.org) client built with **Ionic + Angular**,
running from a single codebase on **Web (PWA), iOS, Android, and Desktop (Electron)**.
End-to-end encryption is a first-class, in-MVP feature.

> Status: **early development.** Scaffold, native platforms, the E2EE crypto spike,
> and authentication are done. See [Project status](#project-status) below.

## Documentation
| Doc | What's in it |
|---|---|
| [PLAN.md](PLAN.md) | Roadmap, milestones, scope, decisions, risks |
| [STACK.md](STACK.md) | Pinned versions + integration notes for every dependency |
| [SPIKE.md](SPIKE.md) | E2EE crypto WASM validation results (the gating risk) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the code is organized and how data flows |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Setup, running, testing, troubleshooting |

## Tech stack
- **UI:** Ionic 8 + Angular 20 (standalone components, signals)
- **Native:** Capacitor 8 (iOS via SPM, Android) + Electron (planned) for desktop
- **Protocol:** `matrix-js-sdk` 41
- **E2EE:** `@matrix-org/matrix-sdk-crypto-wasm` (Rust crypto / Vodozemac)
- **Testing:** Vitest + Playwright (target); Playwright-driven headless checks today

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
| Command | Purpose |
|---|---|
| `pnpm start` | Web dev server (hot reload) at `:4200` |
| `pnpm build` | Production web build into `www/` |
| `pnpm smoke:login` | Headless: redirect→login + real matrix.org discovery |
| `pnpm spike:chromium` | Headless E2EE WASM check (Blink → Android WebView / Electron) |
| `pnpm spike:webkit` | Headless E2EE WASM check (WebKit → iOS WKWebView) |
| `pnpm exec cap run ios` / `android` | Build + launch on simulator/emulator |

## Project structure
```
src/app/
  core/
    matrix/      MatrixClient lifecycle, auth, crypto loader, session model
    storage/     session persistence (Capacitor Preferences)
    guards/      authGuard (session restore / redirect)
  features/
    auth/        login + SSO callback pages
    rooms/       authenticated landing (room list to come)
    chat/        timeline + composer (to come)
    settings/    profile, devices, appearance (to come)
  shared/        reusable UI, pipes
scripts/         headless validation harnesses
android/ ios/    Capacitor native projects
```
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the rationale and data flow.

## Project status
| Milestone | State |
|---|---|
| 1 — Scaffold + crypto WASM spike | ✅ Done — E2EE validated on Blink + WebKit ([SPIKE.md](SPIKE.md)) |
| 2 — Auth (discovery, password, SSO, logout) | ✅ Done — flow verified headlessly |
| 3 — Crypto bootstrap (cross-signing, key backup) | ⬜ Next |
| 4 — Sync & room list | ⬜ |
| 5 — Timeline (read) | ⬜ |
| 6 — Compose (send) | ⬜ |
| 7 — Device verification UI | ⬜ |
| 8 — Media | ⬜ |
| 9 — MVP polish | ⬜ |

Full breakdown in [PLAN.md](PLAN.md).

## Known limitations (current)
- No credentialed end-to-end login test yet (needs a test account).
- Native SSO deep link (`eu.qwky.trinity://sso-callback`) is stubbed, not implemented.
- Session token stored via Preferences, not yet hardware-backed secure storage.
- Test runner is still the scaffold default (Karma); Vitest migration is a later step.

## License
TBD.
