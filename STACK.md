# Stack Reference — collected knowledge

Pinned versions and integration notes gathered 2026-06-26. This is the "skills"
reference for building the client; see [PLAN.md](PLAN.md) for the roadmap.

## Pinned versions (latest on npm, 2026-06-26)
| Package | Version | Notes |
|---|---|---|
| `@angular/core` | 22.0.3 | Standalone + signals; Ionic 8 supports Angular 16+ |
| `@ionic/angular` | 8.8.12 | 8.8 is the final Ionic 8 minor; Ionic 9 in development |
| `@capacitor/core` | 8.4.1 | Capacitor 8: SPM default on iOS, edge-to-edge Android |
| `@capacitor-community/electron` | 5.0.1 | Community-maintained desktop target (less stable than core) |
| `matrix-js-sdk` | 41.8.0 | Requires **Node.js 22+**; browser entry auto-configures IndexedDB |
| `@matrix-org/matrix-sdk-crypto-wasm` | 18.3.1 | Rust crypto WASM bindings; E2EE backend |

> Versions moved since the original plan draft: Capacitor is on **8** (not 6),
> Ionic on **8.8**, Angular on **22**. Use these.

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
- Device verification: emoji SAS and QR flows via the verification request APIs.
- WASM packaging "just works" for web-like environments (separate Node vs web entry
  points); the web entry reads the `.wasm` over fetch.

### ⚠️ Gating risk to validate FIRST (Milestone 1 spike)
Prove `@matrix-org/matrix-sdk-crypto-wasm` loads + initializes the crypto store in:
- iOS WKWebView
- Android WebView (System WebView / Chrome)
- Electron renderer

Watch for: WASM MIME/streaming-compile issues in WebViews, IndexedDB availability,
and CSP/`Content-Security-Policy` blocking `wasm-unsafe-eval`. If a platform fails,
the architecture changes — find out before building UI on top.

## Electron desktop
- Add via `@capacitor-community/electron` (`npm i @capacitor-community/electron`).
- Community-maintained: budget time for IPC wiring (main vs renderer) and packaging
  (`electron` + a packager/builder). Less polished than core Capacitor platforms.
- Confirm WASM crypto runs in the Electron renderer during the Milestone 1 spike.

## Testing — Vitest + Playwright
- Angular has an official (experimental) Vitest builder: set the test target builder
  to **`@angular/build:unit-test`** in `angular.json`.
- For component/browser tests, enable **Vitest Browser Mode** with the Playwright
  provider (install `@vitest/browser` + `playwright`; set `browsers` option /
  `--browsers chromium`).
- Use **Playwright** standalone for end-to-end flows (login, send message).
- Modern default: Vitest (unit/integration) shares Vite config, parallel by default.

## Open setup decisions / reminders
- Node 22+ required by matrix-js-sdk — current env is Node 25.2.1 (OK).
- SSO on native needs deep-link / custom URL scheme config (App plugin) per platform.
- Push (phase 2) needs Apple dev account (APNs) + FCM, plus a push gateway (sygnal)
  or UnifiedPush.

## Sources
- Ionic: https://ionicframework.com/docs/angular/overview , https://ionic.io/blog/announcing-ionic-framework-8-8
- Capacitor: https://ionic.io/blog/announcing-capacitor-8 , https://capacitorjs.com/
- matrix-js-sdk: https://github.com/matrix-org/matrix-js-sdk , https://matrix-org-matrix-js-sdk.mintlify.app/guides/encryption-overview
- crypto-wasm: https://www.npmjs.com/package/@matrix-org/matrix-sdk-crypto-wasm , https://github.com/matrix-org/matrix-sdk-crypto-wasm
- Electron: https://devdactic.com/ionic-desktop-electron
- Testing: https://angular.dev/guide/testing/migrating-to-vitest , https://github.com/vitest-community/vitest-browser-angular
