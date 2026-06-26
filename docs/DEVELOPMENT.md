# Development guide

Setup, running, testing, and troubleshooting. Architecture is in
[ARCHITECTURE.md](ARCHITECTURE.md); roadmap in [../PLAN.md](../PLAN.md).

## Prerequisites
- **Node 22+** (matrix-js-sdk requirement; repo developed on Node 25) and **pnpm**
  (`corepack enable` installs the version pinned in `package.json`).
- **iOS builds:** macOS with **Xcode** installed and selected
  (`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`). Capacitor 8
  uses Swift Package Manager — CocoaPods not required.
- **Android builds:** Android SDK (easiest via Android Studio). Export
  `ANDROID_HOME="$HOME/Library/Android/sdk"`. `android/local.properties` must point
  `sdk.dir` at it.

```bash
pnpm install
```

> pnpm blocks dependency build scripts by default. The ones this project needs
> (`esbuild`, `@parcel/watcher`, `lmdb`, `msgpackr-extract`) are allowlisted under
> `pnpm.onlyBuiltDependencies` in `package.json`, so they build on install.

## Running on the web
```bash
pnpm start         # ng serve → http://localhost:4200, hot reload
```
- Unauthenticated, you land on `/login`. Enter a homeserver (`matrix.org`), then sign
  in with a real account.
- E2EE spike UI: `http://localhost:4200/spike` → "Run crypto spike".
- **Reset local state:** DevTools → Application → clear localStorage + IndexedDB,
  then reload. (Session lives in Preferences/localStorage; crypto store in IndexedDB.)

## Running on device / simulator
```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"   # Android only
pnpm build && pnpm exec cap sync

pnpm exec cap run ios          # choose a simulator
pnpm exec cap run android      # choose an emulator/device
# or open the native IDE:
pnpm exec cap open ios         # Xcode
pnpm exec cap open android     # Android Studio
```
After **every** web-code change, re-run `pnpm build && pnpm exec cap sync` (or the
faster `pnpm exec cap copy` when only web assets changed) to push it into the shells.

## Testing
Today's checks are headless Playwright drivers that build, serve `www/`, and assert
real behavior. (The Vitest + Playwright suite proper is a later milestone.)

```bash
pnpm build            # production build + full typecheck
pnpm smoke:login      # redirect→login + real .well-known discovery
pnpm spike:chromium   # E2EE WASM in Blink  (Android WebView / Electron proxy)
pnpm spike:webkit     # E2EE WASM in WebKit (iOS WKWebView proxy)
```
All should print `RESULT: PASS`. The spike scripts require the Playwright browsers:
```bash
pnpm exec playwright install chromium webkit
```

### What is NOT covered yet
- A **credentialed** login → sync → logout cycle (no test account wired in). With a
  throwaway account this becomes a straightforward addition to `smoke-login.mjs`.
- On-device WebView runtime (the Playwright engine runs are faithful proxies, but a
  simulator/emulator run is the real thing — see [../SPIKE.md](../SPIKE.md)).

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| `WebAssembly … HTTP status is not ok` / crypto 404 | The WASM asset isn't served. Ensure `angular.json` copies it to `assets/crypto/` and you ran `pnpm build`. See [ARCHITECTURE.md](ARCHITECTURE.md#e2ee-wasm-loading). |
| Crypto fails only on device | Check Capacitor serves `.wasm` as `application/wasm`; if a CSP is set, allow `wasm-unsafe-eval`. |
| `xcodebuild requires Xcode` | Command Line Tools are selected, not Xcode. Run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`. |
| Android: "Unable to infer default Android SDK" | Export `ANDROID_HOME` and confirm `android/local.properties` `sdk.dir`. |
| Build warns about non-ESM modules (`loglevel`, `events`, …) | Harmless CommonJS-interop notices from matrix-js-sdk deps. Silence via `allowedCommonJsDependencies` in `angular.json` if desired. |
| Stuck "logged in" / weird crypto state | Clear localStorage + IndexedDB (web) or reinstall the app (device). |

## Conventions
- Standalone Angular components; import Ionic from `@ionic/angular/standalone`.
- State via **signals**; async UI actions go through a shared busy/error helper.
- New SDK interaction belongs in a `core/matrix` service, not in a component.
- Keep `data-testid` hooks on interactive elements that the headless scripts drive.
