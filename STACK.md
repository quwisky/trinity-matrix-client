# Stack Reference — collected knowledge

Pinned versions and integration notes gathered 2026-06-26. This is the "skills"
reference for building the client; see [PLAN.md](PLAN.md) for the roadmap.

## Pinned versions (latest on npm, 2026-06-26)

| Package                              | Version | Notes                                                                                   |
| ------------------------------------ | ------- | --------------------------------------------------------------------------------------- |
| `@angular/core`                      | 20.3.25 | Standalone + signals; Ionic 8 supports Angular 16+                                      |
| `@ionic/angular`                     | 8.8.12  | 8.8 is the final Ionic 8 minor; Ionic 9 in development                                  |
| `@capacitor/core`                    | 8.4.1   | Capacitor 8: SPM default on iOS, edge-to-edge Android                                   |
| `electron` + `electron-builder`      | 42 / 26 | Hand-rolled desktop shell in `electron/` (own package.json); see Electron desktop below |
| `matrix-js-sdk`                      | 41.8.0  | Requires **Node.js 22+**; browser entry auto-configures IndexedDB                       |
| `@matrix-org/matrix-sdk-crypto-wasm` | 18.3.1  | Rust crypto WASM bindings; E2EE backend                                                 |
| `@capacitor/app`                     | 8.1.0   | App URL-open events — native SSO deep-link callback                                     |
| `@capacitor/browser`                 | 8.0.3   | System browser for native SSO (keeps the app webview alive)                             |
| `@capacitor/camera`                  | 8.2.0   | Native photo/gallery picker for sending media (web `<input>` fallback)                  |
| `@capacitor/filesystem`              | 8.1.2   | Write a downloaded attachment to cache before sharing it (native save)                  |
| `@capacitor/share`                   | 8.0.1   | Native OS save/share sheet for downloads (web `<a download>` fallback)                  |
| `@capacitor/status-bar`              | 8.0.2   | Sets the native status-bar style to match the light/dark theme                          |
| `@angular/service-worker`            | 20.3.25 | PWA service worker (production web): precaches the app shell + crypto WASM for offline  |
| `@capacitor/push-notifications`      | 8.1.1   | FCM/APNs device token for the Matrix pusher (see [docs/PUSH.md](docs/PUSH.md))          |
| `matrix-encrypt-attachment`          | —       | Removed (unmaintained since 2022); ported into `@trinity/core` `attachment-crypto.ts`   |
| `marked`                             | 18.0.5  | Markdown → HTML for the composer/timeline                                               |
| `dompurify`                          | 3.4.11  | Sanitizes inbound `formatted_body` HTML (Matrix allowlist)                              |

> Versions moved since the original plan draft: Capacitor is on **8** (not 6),
> Ionic on **8.8**. Angular is pinned at **20.3** (the Ionic 8 scaffold targets 20,
> not the newer npm-latest line).

## Dev tooling & quality gates

| Package                                           | Version       | Notes                                                        |
| ------------------------------------------------- | ------------- | ------------------------------------------------------------ |
| `nx`, `@nx/{angular,vite,eslint,js}`              | 23.0.1        | Monorepo task graph, caching, module boundaries              |
| `@nx/playwright` + `@playwright/test`             | 23.0.1 / 1.61 | `nx e2e trinity` app-journey tests (Playwright, Chromium)    |
| `vitest` + `@analogjs/*`                          | 3 / 2.6.2     | Unit tests; the Analog plugin compiles Angular for Vite      |
| `vite`, `vite-tsconfig-paths`, `jsdom`            | 6 / 6 / 25    | Vitest runtime + `@trinity/*` alias resolution + DOM env     |
| `eslint` + `angular-eslint` + `typescript-eslint` | 9 / 20.7 / 8  | Flat config (`eslint.config.mjs`) + module boundaries        |
| `prettier`                                        | 3.8           | `singleQuote`; Angular parser forced for `*.page.html`       |
| `stylelint` + `stylelint-config-standard-scss`    | 17 / 17       | SCSS lint                                                    |
| `@commitlint/{cli,config-angular}`                | 21            | `commit-msg` hook; Angular commit convention                 |
| `husky` + `lint-staged`                           | 9 / 17        | `pre-commit` (lint/format staged) + `commit-msg` hooks       |
| `typescript`                                      | 5.9           | `moduleResolution: bundler`; aliases in `tsconfig.base.json` |
| `@types/node`                                     | 22            | Node globals for `vite.config.ts` + the spec tsconfigs       |

## Ionic + Angular (standalone)

- Create with the Ionic CLI and select **Standalone Components** when prompted.
- Import all Ionic pieces from `@ionic/angular/standalone` (components, directives,
  providers, types) — enables treeshaking.
- Bootstrap via `bootstrapApplication(...)` and call `provideIonicAngular()` in
  providers **even if no config is passed**.
- Use lazy-loaded standalone routes per feature.

## Capacitor 8

- `pnpm add @capacitor/core @capacitor/cli`, then `pnpm exec cap add ios` / `... android`.
- iOS uses Swift Package Manager by default for new projects (CocoaPods still works).
- Android: built-in edge-to-edge via internal SystemBars plugin (mind safe-area insets).
- Web build output is synced into native shells with `pnpm exec cap sync`.
- Plugins likely needed: Preferences (token storage), Camera, Filesystem,
  Push Notifications (phase 2), App (deep links for SSO callback).

## matrix-js-sdk + E2EE

- `createClient({ baseUrl, accessToken, userId, deviceId })`, then `client.startClient()`.
- **Crypto setup:** call `await client.initRustCrypto()` BEFORE `startClient()`.
  - In a real browser/WebView, it uses **IndexedDB** as the crypto store by default.
  - Outside a browser (e.g. some Node test contexts) pass `{ useIndexedDB: false }`
    for an ephemeral in-memory store.
- The legacy `client.crypto` object is **gone** — use `client.getCrypto()` which
  returns the `CryptoApi` (main E2EE entry point) after `initRustCrypto()`.
- Crypto bootstrap sequence: init rust crypto -> cross-signing setup
  (`bootstrapCrossSigning`) -> key backup (`bootstrapSecretStorage` / key backup APIs).
  **Implemented (M3)** in `@trinity/core` `CryptoService` + `@trinity/feature-crypto`.
- Device verification via the `VerificationRequest`/`Verifier` APIs. **Implemented (M7):**
  emoji-SAS self-verification (`requestOwnUserVerification`) in `VerificationService` +
  `@trinity/feature-crypto`. QR and cross-user verification are deferred.
- WASM packaging "just works" for web-like environments (separate Node vs web entry
  points); the web entry reads the `.wasm` over fetch. A strict CSP ships in
  `apps/trinity/src/index.html`; it includes `wasm-unsafe-eval` for the Rust crypto WASM
  and scopes `connect-src`/`img-src` to `https:`/`wss:` (the homeserver is user-chosen).

### ⚠️ Gating risk to validate FIRST (Milestone 1 spike)

Prove `@matrix-org/matrix-sdk-crypto-wasm` loads + initializes the crypto store in:

- iOS WKWebView
- Android WebView (System WebView / Chrome)
- Electron renderer

Watch for: WASM MIME/streaming-compile issues in WebViews, IndexedDB availability,
and CSP/`Content-Security-Policy` blocking `wasm-unsafe-eval`. If a platform fails,
the architecture changes — find out before building UI on top.

## Electron desktop

- **Hand-rolled** (`electron/`), NOT `@capacitor-community/electron` (abandoned, stuck
  on Cap-5). The desktop app is the existing `www/` build in a hardened Electron shell;
  on desktop the app runs its web fallbacks (no Capacitor desktop bridge).
- The build is served over a custom **privileged** scheme (`trinity://app/`, registered
  standard + secure + fetch + stream) so the renderer is a secure context and the crypto
  WASM stream-instantiates. `contextIsolation`/`sandbox` on, `nodeIntegration` off.
- NB: with no Capacitor bridge, `Capacitor.getPlatform()` is `'web'` and
  `isNativePlatform()` is `false` in the shell — desktop is detected via the preload
  marker `trinityDesktop.isElectron` (used to keep the service worker off).
- Build/run: `pnpm electron:build` / `electron:start`. Package via electron-builder:
  `electron:package` (current host OS), or per target `electron:package:{mac,linux,win}`
  (and `:all`). Targets: macOS dmg+zip, Linux AppImage+deb, Windows nsis → `electron/release/`.
- **Cross-build constraints** (electron-builder): macOS builds run **only on macOS**;
  Windows builds run on Windows (or macOS/Linux **with Wine**); Linux builds run on
  Linux/macOS (deb needs `dpkg`/`fpm`). `:all` (`-mwl`) therefore only fully succeeds on a
  suitably-tooled macOS host. CI per-OS runners are the reliable way to ship all three.
- First package downloads the Electron binary (the headless install skipped it); run
  `pnpm electron:install` on a real machine, or it fetches on first package.
- Signing/notarization deferred (`electron-builder.yml` TODOs). Confirm WASM crypto +
  IndexedDB on a real desktop run.

## Testing — Vitest + Playwright

- **Unit:** Vitest, wired through Nx via `@analogjs/vite-plugin-angular` +
  `@analogjs/vitest-angular`. Each project has a `vite.config.ts` and
  `src/test-setup.ts`; run with `pnpm test` / `nx test <project>`. (We use the Analog
  plugin rather than Angular's experimental `@angular/build:unit-test` builder — this
  is an Nx workspace with `project.json`, not `angular.json`.)
- **Component/browser tests (later):** Vitest Browser Mode with the Playwright provider
  (`@vitest/browser` + `playwright`).
- **End-to-end — app journeys:** `@nx/playwright` + `@playwright/test` at
  `apps/trinity/e2e/`. `nx e2e trinity` builds the dev bundle, serves `www/`, and brings the
  disposable Synapse harness up/down via global setup (auth specs skip when Docker is absent).
  Covers login/guard, theme, profile, and device management.
- **End-to-end — crypto/protocol:** Playwright **standalone** (`playwright`, not
  `@playwright/test`) — `e2e/*.mjs` scripts that serve `www/` and drive Chromium/WebKit:
  `smoke-login`, the `crypto-spike` (per engine), the two-client emoji-SAS `verify-sas`, and
  the encrypted `send-media` round-trip (disposable Synapse harness, env-gated; full
  round-trips run to PASS 2026-06-27). See [e2e/README.md](e2e/README.md).
- Vitest shares the Vite config and runs in parallel by default.

## Open setup decisions / reminders

- Node 22+ required by matrix-js-sdk — current env is Node 25.2.1 (OK).
- SSO on native: the deep-link / custom URL scheme is configured (App plugin +
  iOS `CFBundleURLSchemes` + Android intent-filter); the round-trip still needs
  on-device validation.
- Push: the client plumbing is done (`@capacitor/push-notifications` + a Matrix
  pusher; see [docs/PUSH.md](docs/PUSH.md)). Delivery still needs a deployed push
  gateway (Sygnal), an Apple dev account (APNs) + Firebase project (FCM), and
  on-device verification.

## Sources

- Ionic: https://ionicframework.com/docs/angular/overview , https://ionic.io/blog/announcing-ionic-framework-8-8
- Capacitor: https://ionic.io/blog/announcing-capacitor-8 , https://capacitorjs.com/
- matrix-js-sdk: https://github.com/matrix-org/matrix-js-sdk , https://matrix-org-matrix-js-sdk.mintlify.app/guides/encryption-overview
- crypto-wasm: https://www.npmjs.com/package/@matrix-org/matrix-sdk-crypto-wasm , https://github.com/matrix-org/matrix-sdk-crypto-wasm
- Electron: https://devdactic.com/ionic-desktop-electron
- Testing: https://angular.dev/guide/testing/migrating-to-vitest , https://github.com/vitest-community/vitest-browser-angular
