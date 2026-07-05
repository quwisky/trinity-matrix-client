# Milestone 1 — E2EE crypto WASM spike results

**Status: PASS (gating risk cleared).** Date: 2026-06-26.

Because E2EE is in the MVP, the gating question was: does
`@matrix-org/matrix-sdk-crypto-wasm` load and initialize the Rust crypto store
inside the WebView engines we ship to? Answer: yes, on both engines.

## How it was tested

- An in-app spike lives at the home page ("Run crypto spike" button):
  [crypto-spike.service.ts](libs/core/src/lib/matrix/crypto-spike.service.ts) +
  [home.page.html](apps/trinity/src/app/home/home.page.html). It creates a throwaway,
  unauthenticated client, preloads the WASM, calls `initRustCrypto()`, and reports
  the crypto version, generated device key, IndexedDB availability, and timing.
- Driven headlessly by [e2e/features/crypto-spike.mjs](e2e/features/crypto-spike.mjs)
  via Playwright against two engines (run `pnpm spike:chromium` / `pnpm spike:webkit`).

## Results

| Engine           | Proxy for                                 | Result            | Notes               |
| ---------------- | ----------------------------------------- | ----------------- | ------------------- |
| Chromium (Blink) | Android System WebView, Electron renderer | ✅ PASS (~102 ms) | IndexedDB available |
| WebKit           | iOS WKWebView                             | ✅ PASS (~133 ms) | IndexedDB available |

Crypto stack: **Rust SDK 0.18.0 (Vodozemac 0.10.0)**, via matrix-js-sdk 41.8.0 /
matrix-sdk-crypto-wasm 18.3.1.

## The fix this spike forced

Angular's esbuild does **not** emit the SDK's WASM asset, so the default loader
(`./pkg/matrix_sdk_crypto_wasm_bg.wasm` relative to bundled JS) **404'd**. Resolution:

1. Copy the WASM to served assets via the build target (`apps/trinity/project.json`) →
   `assets/crypto/matrix_sdk_crypto_wasm_bg.wasm`.
2. Preload it before `initRustCrypto()` with `initAsync(url)` — the loader memoizes,
   so the SDK's own internal call reuses our instance. See
   [crypto-wasm-loader.ts](libs/core/src/lib/matrix/crypto-wasm-loader.ts), used by both
   the spike and [matrix-client.service.ts](libs/core/src/lib/matrix/matrix-client.service.ts).

The WASM is confirmed synced into both native bundles
(`android/.../public/assets/crypto/`, `ios/App/App/public/assets/crypto/`).

## Residual checks (optional, not blocking)

- **On-device confirmation:** `pnpm exec cap run ios` / `pnpm exec cap run android`, then tap
  "Run crypto spike". The Playwright WebKit/Blink runs are faithful engine proxies,
  but a simulator/emulator run confirms Capacitor's local server serves `.wasm` with
  `application/wasm` (required by `WebAssembly.instantiateStreaming`). Capacitor does
  this by default; the on-device run is belt-and-suspenders.
- **CSP:** if a Content-Security-Policy is added later, it must allow
  `wasm-unsafe-eval`.

## Build note

The production build prints CommonJS-interop warnings for matrix-js-sdk's transitive
deps (`another-json`, `loglevel`, `events`, etc.). Harmless; silence later by adding
them to `allowedCommonJsDependencies` in the build options (`apps/trinity/project.json`)
if desired.
