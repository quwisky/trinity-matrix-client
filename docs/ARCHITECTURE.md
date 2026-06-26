# Architecture

How the codebase is organized, the rules it follows, and how data flows. For the
roadmap see [../PLAN.md](../PLAN.md); for dependency specifics see [../STACK.md](../STACK.md).

## Layering rules

1. **Components never import `matrix-js-sdk` directly.** They depend only on the
   services in `@trinity/core` (`libs/core/src/lib/matrix/`). This keeps the SDK
   swappable and the UI testable.
2. **`@trinity/core` is framework-of-the-app logic**, the `@trinity/feature-*` libs are
   screens, future shared UI becomes its own lib. Dependencies point inward:
   `feature-* → core`, never the reverse — enforced by `@nx/enforce-module-boundaries`
   (project `tags` in each `project.json`).
3. **Reactive state is exposed as Angular signals.** SDK `EventEmitter` streams are
   bridged into signals inside the core services, so components stay zone-friendly
   and change detection is cheap.

```
feature-* libs (pages)     shared libs (ui, pipes)
        \                  /
         v                v
        @trinity/core (services, guards)
                   |
                   v
            matrix-js-sdk + crypto WASM
```

## @trinity/core — matrix

| File                                                                             | Responsibility                                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [matrix-client.service.ts](../libs/core/src/lib/matrix/matrix-client.service.ts) | Owns the single `MatrixClient`. Lifecycle: `createClient → preload WASM → initRustCrypto → startClient`. Exposes `syncState` signal.       |
| [auth.service.ts](../libs/core/src/lib/matrix/auth.service.ts)                   | Homeserver discovery (`.well-known`), password login, SSO URL + token exchange, logout. Persists session and starts the client on success. |
| [crypto-wasm-loader.ts](../libs/core/src/lib/matrix/crypto-wasm-loader.ts)       | Preloads the Rust crypto WASM from a served asset path (see [WASM loading](#e2ee-wasm-loading)). Memoized.                                 |
| [crypto-spike.service.ts](../libs/core/src/lib/matrix/crypto-spike.service.ts)   | Dev smoke test that proves crypto initializes in the current runtime.                                                                      |
| [session.model.ts](../libs/core/src/lib/matrix/session.model.ts)                 | `MatrixSession` shape (baseUrl, userId, deviceId, accessToken).                                                                            |

## @trinity/core — storage & guards

- [session-storage.service.ts](../libs/core/src/lib/storage/session-storage.service.ts) —
  persists `MatrixSession` via **Capacitor Preferences** (native storage on device,
  localStorage on web).
- [auth.guard.ts](../libs/core/src/lib/guards/auth.guard.ts) — a `CanActivateFn` that lets
  routes through only when a client is live, attempting a one-time session **restore**
  first, otherwise redirecting to `/login`.

## Routing

Defined in [app.routes.ts](../apps/trinity/src/app/app.routes.ts), all lazy-loaded standalone:

| Path            | Page                            | Guard       |
| --------------- | ------------------------------- | ----------- |
| `/login`        | login                           | —           |
| `/sso-callback` | SSO token exchange              | —           |
| `/rooms`        | authenticated landing (default) | `authGuard` |
| `/spike`        | dev E2EE crypto spike           | —           |

## Authentication flow

```
LoginPage
  ─ discoverHomeserver(input) ──► AutoDiscovery.findClientConfig (.well-known)
  ─ getSupportedFlows(baseUrl) ─► loginFlows()           (show password / SSO)
  ─ loginWithPassword() ────────► client.login('m.login.password')
        └─ SessionStorage.save() ─► MatrixClientService.init() ─► /rooms
  ─ startSso() ─► stash baseUrl in sessionStorage ─► redirect to homeserver SSO
        └─ returns to /sso-callback?loginToken=… ─► completeSsoLogin() ─► /rooms
```

On app launch, `authGuard` calls `MatrixClientService.restore()`, which reloads the
persisted session and re-runs the client lifecycle (including crypto).

## E2EE WASM loading

The single most important platform detail (full story in [../SPIKE.md](../SPIKE.md)):

- matrix-js-sdk's default loader resolves its `.wasm` **relative to the bundled JS**,
  which Angular's esbuild does not emit — so it **404s**.
- Fix: the build target (`apps/trinity/project.json`) copies the file to
  `assets/crypto/`, and
  [crypto-wasm-loader.ts](../libs/core/src/lib/matrix/crypto-wasm-loader.ts) calls
  `initAsync(url)` against that path **before** `initRustCrypto()`. The loader memoizes
  its module promise, so the SDK's own internal `initAsync()` reuses our instance.
- Validated headless on **Blink** (Android WebView / Electron) and **WebKit** (iOS).

## Native shells

Capacitor wraps the web build (`www/`) into `ios/` and `android/`. After any web
change, `pnpm build && pnpm exec cap sync` (or `pnpm exec cap copy`) pushes it into the shells.
iOS uses Swift Package Manager (Capacitor 8 default); Android needs `ANDROID_HOME`.

## Testing harnesses

[e2e/](../e2e/) holds headless Playwright drivers used as smoke/regression
checks: `crypto-spike.mjs` (parametrized by engine) and `smoke-login.mjs`. They
serve the production build and assert real behavior, including live network calls to
matrix.org for discovery. These are the seed of the eventual Vitest + Playwright suite.
