# Desktop

The desktop app is the Angular web build wrapped in a hand-rolled Electron shell. There is
no Capacitor desktop bridge and no Electron framework wrapper: the shell is sixteen small
TypeScript modules under
[electron/src](https://github.com/quwisky/trinity-matrix-client/tree/develop/electron/src),
each owning one concern, wired together by a thin `main.ts`.

Because the shell loads the plain web build, the renderer takes the _web_ branch of every
Capacitor check. `Capacitor.isNativePlatform()` is `false` here. What the desktop adds is
delivered through a preload bridge instead, described below.

## A separate package

`electron/` is its own pnpm project, not a member of the Nx graph.

- Its own `package.json`, `pnpm-lock.yaml` and `node_modules`.
- Its own `pnpm-workspace.yaml` with `packages: []`, which exists purely to stop
  `pnpm -C electron install` from walking up to the repository-root workspace. Without it
  the root workspace swallows the directory and the `electron` types that `tsc` needs are
  never installed.
- Its own TypeScript install, but not its own TypeScript version — both manifests pin the
  same exact 6.0.3, and Renovate moves them together in one branch.
- Zero production dependencies, which is why `node_modules` is absent from the packaged
  bundle.

In the Nx graph it appears as an inferred project named `trinity-desktop` with exactly one
target, `lint`. It has no `test` target there, so `pnpm test` does not run the
main-process specs; `pnpm -C electron test` does, and CI runs it explicitly.

!!! warning "Repository-wide TypeScript codemods hit this file"

    `nx migrate` runs `@nx/js` codemods that glob every `tsconfig*.json`, including
    `electron/tsconfig.json`. Both manifests now share one TypeScript, so a rewrite no
    longer lands on a compiler that cannot read it — but the file still has to keep the
    Node16 `module`/`moduleResolution` pair, because TypeScript 6 rejects the older node10
    resolution outright with TS5107. Check it in the diff of any migration and re-verify
    with `pnpm -C electron run compile`.

## Building and running

```bash
pnpm electron:install   # download the Electron binary
pnpm electron:start     # build the web app, compile the shell, launch it
```

`electron:start` chains through `electron:build`, which is four steps:

```text
pnpm build                     # Angular production build -> www/
pnpm electron:install          # pnpm -C electron install + ensure:binary
pnpm -C electron run build     # copy-www.mjs then tsc -p tsconfig.json
pnpm electron:sign:dev         # ad-hoc codesign, macOS only
```

`electron:install` is described as one-time in most places, but every `electron:*` script
re-runs it. That is cheap: `ensure-electron.mjs` self-skips when `dist/version` already
matches the installed package version and the executable named by `path.txt` exists. The
standalone command is only useful to pre-warm the download before a first build.

### Why the binary download is explicit

Electron dropped its `postinstall` script in version 42. The package now fetches its binary
lazily, the first time `require('electron')` resolves a path. That is too late here:
`sign:dev` codesigns `node_modules/electron/dist/Electron.app` before anything requires the
package, so on macOS the first launch after a clone would fail on a missing app.

[electron/scripts/ensure-electron.mjs](https://github.com/quwisky/trinity-matrix-client/blob/develop/electron/scripts/ensure-electron.mjs)
therefore drives the package's own installer directly. The download is roughly 119 MB
zipped and extracts to around 313 MB. CI caches `~/.cache/electron` keyed on
`electron/pnpm-lock.yaml`.

## The privileged app scheme

The renderer is served from `trinity://app`, not from `file://`. `registerPrivilegedScheme()`
runs at module scope in `main.ts`, before `app.whenReady()` — Electron requires privileged
scheme registration to happen before the app is ready, so this call sits outside the
single-instance branch.

| Privilege         | What it buys                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `standard: true`  | A stable origin, so `<base href="/">` and absolute asset paths resolve and the `'self'` CSP has something to bind to  |
| `secure: true`    | A secure context, required by WebCrypto SubtleCrypto and IndexedDB, both of which Matrix crypto and storage depend on |
| `supportFetchAPI` | `fetch()` works against the scheme                                                                                    |
| `stream: true`    | Responses are streamable, so the crypto module can be instantiated with `WebAssembly.compileStreaming`                |
| `codeCache: true` | Chromium caches compiled script for the origin                                                                        |

`registerAppProtocol()` then maps `trinity://app/<path>` onto `www/<path>` and handles four
cases explicitly, in
[electron/src/scheme.ts](https://github.com/quwisky/trinity-matrix-client/blob/develop/electron/src/scheme.ts):

- A real file is served with a `Content-Type` from a twenty-entry extension map. The
  `.wasm` entry mapping to `application/wasm` is the one the whole crypto path depends on;
  stream instantiation rejects any other type.
- An extensionless path with no file behind it serves `index.html`, so a reload on
  `/rooms` boots the application instead of 404ing.
- A resolved path that escapes `WWW_ROOT` returns 403.
- Malformed percent-encoding, which makes `decodeURIComponent` throw, returns 400 rather
  than crashing the handler.

## Renderer security posture

`createWindow()` in
[electron/src/window.ts](https://github.com/quwisky/trinity-matrix-client/blob/develop/electron/src/window.ts)
sets:

```ts
contextIsolation: true,
nodeIntegration: false,
sandbox: true,
webSecurity: true,
nodeIntegrationInWorker: false,
nodeIntegrationInSubFrames: false,
backgroundThrottling: false,
```

The first six are the standard hardened set: the renderer never reaches Node, and the
preload is the only bridge. The desktop e2e suite asserts this from inside the real
renderer by checking that `require` and `process` are both `undefined`.

`backgroundThrottling: false` is the odd one out and it is not a security setting. Chromium
throttles timers, `requestAnimationFrame` and network activity in hidden or occluded pages,
which would stall the `matrix-js-sdk` `/sync` long-poll. Combined with close-to-tray below,
disabling it is what makes background notifications work at all.

Two more policies are applied on top:

- `hardenContents()` denies every `window.open`, routing `http(s)` URLs to
  `shell.openExternal` instead; prevents `will-navigate` away from the app origin; and
  prevents `will-attach-webview`. It is applied to the main window and, via
  `app.on('web-contents-created')`, to any contents created later.
- `installPermissionPolicy()` allows only microphone and geolocation. Electron approves
  permission requests that reach a ready app by default, so without a handler camera and
  other powerful permissions would be granted silently. A `media` request is allowed only
  when it is audio-only.

The window hides to the tray on close rather than being destroyed, keeping the renderer and
`/sync` alive. An explicit quit — the tray item, the application menu, or OS shutdown —
sets a flag first so the close proceeds. `window-all-closed` deliberately does not quit.

## The preload bridge

[electron/src/preload.ts](https://github.com/quwisky/trinity-matrix-client/blob/develop/electron/src/preload.ts)
runs sandboxed and context-isolated, and exposes exactly one object,
`window.trinityDesktop`. It never exposes `ipcRenderer` or Node. This is the complete
surface:

| Member                       | Direction        | Channel                            | Purpose                                                             |
| ---------------------------- | ---------------- | ---------------------------------- | ------------------------------------------------------------------- |
| `isElectron`                 | value            | —                                  | The desktop-detection marker                                        |
| `platform`                   | value            | —                                  | Host `process.platform`                                             |
| `onDeepLink(cb)`             | main to renderer | `deep-link`                        | OS deep links, with replay of anything buffered before subscription |
| `showNotification(payload)`  | send             | `show-notification`                | Ask main to display a native notification                           |
| `onNotificationClick(cb)`    | main to renderer | `notification-click`               | Delivers only `roomId` and `userId`, never the raw event            |
| `setBadgeCount(n)`           | send             | `set-badge-count`                  | Unread total for the dock or launcher badge                         |
| `cors.setAllowedOrigins(o)`  | send             | `trinity:cors:set-allowed-origins` | Replace the CORS allowlist                                          |
| `cors.allowOrigin(o)`        | send             | `trinity:cors:allow-origin`        | Additively allow one origin                                         |
| `secureStore.isAvailable()`  | invoke           | `trinity:secure-store:available`   | Whether the OS keychain is usable                                   |
| `secureStore.get/set/delete` | invoke           | `trinity:secure-store:*`           | Read, write and remove a secret                                     |
| `resolveApproxLocation()`    | invoke           | `trinity:geolocation:approximate`  | City-level location from the public IP, opt-in only                 |

Both sides validate. The preload drops payloads of the wrong shape, and every main-process
handler independently re-validates and checks `event.sender === getMainWindow().webContents`
before acting, so a compromised or unexpected `WebContents` cannot drive the privileged
side.

The typed mirror of this interface, and the authoritative documentation of each member, is
[libs/platform-native/src/lib/trinity-desktop-bridge.ts](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/platform-native/src/lib/trinity-desktop-bridge.ts).
Prefer it over the preload's own comments, one of which was spliced in half when the CORS
bridge was inserted between the two paragraphs of the `secureStore` docblock.

`resolveApproxLocation` exists because Chromium's `navigator.geolocation` is backed by
Google's network location provider, which prebuilt Electron cannot authenticate without an
embedded API key. On a desktop with no GPS it simply never resolves. The main process makes
a keyless HTTPS lookup instead, time-boxed to eight seconds, resolving `null` on any
failure so the renderer falls back to manual entry.

## Cross-origin requests to homeservers

The renderer's origin is `trinity://app`, so every request `matrix-js-sdk` makes to a
homeserver is cross-origin. The Matrix specification requires client-server and
`.well-known` responses to carry `Access-Control-Allow-Origin: *`, but a good number of
reverse-proxy deployments strip it, and Chromium then blocks the response. Sync, relations,
account data and cross-signing all break intermittently.

[electron/src/cors.ts](https://github.com/quwisky/trinity-matrix-client/blob/develop/electron/src/cors.ts)
installs an `onHeadersReceived` interceptor on the default session, scoped to
`https://*/*` and `http://*/*` — never the app scheme itself. For a matching response it
strips the five CORS headers it manages and then sets exactly one
`Access-Control-Allow-Origin`, holding the exact app origin and never `*`. Stripping first
matters: Chromium rejects a response carrying two
`Access-Control-Allow-Origin` values. On an `OPTIONS` preflight it also sets the allowed
methods, `Access-Control-Allow-Headers: Authorization, Content-Type` — the `*` wildcard
never covers `Authorization` — and a one-day max-age.

`access-control-allow-credentials` is in the managed set, stripped and never re-set, so a
third-party origin cannot opt itself into credentialed cross-origin reads. `matrix-js-sdk`
authenticates with a bearer header, not cookies, so nothing needs it.

The shim is scoped by an allowlist that the renderer publishes:

- `MatrixClientService.publishCorsOrigins()` sends the `baseUrl` of every signed-in account
  whenever the account set changes.
- `AuthService.allowCorsOrigin()` additively allows the single origin that `.well-known`
  discovery or login is probing, before any account exists to declare it.

**Origins that were never declared pass through untouched.** That is a safe default rather
than a lax one, because a specification-compliant server needs no help. It also means a
future sanitizer bypass in the renderer cannot borrow the shim as a read-anywhere
primitive against arbitrary HTTPS origins.

!!! warning "The file's own header comment is out of date"

    The long docblock at the top of `cors.ts` still describes a known limitation — that
    the shim rewrites headers for every remote origin and that narrowing it would need the
    renderer to publish its origin set over IPC, "tracked as follow-up". That work shipped.
    The code below it opens with `if (!isAllowed(details.url)) { callback({}); return; }`.
    Trust the code.

## Deep links and the OS scheme

Two custom schemes are in play and they do different jobs.

| Scheme             | Registered with      | Used for                                                    |
| ------------------ | -------------------- | ----------------------------------------------------------- |
| `trinity://app`    | the Electron session | Serving `www/`. Never registered with the OS                |
| `eu.qwky.trinity:` | the operating system | Routing the SSO and OIDC browser redirect back into the app |

Matching on the inbound URL is **scheme-only**:

```ts
export const DEEP_LINK_PREFIX = `${DEEP_LINK_SCHEME}:`;
```

Legacy SSO redirects to `eu.qwky.trinity://sso-callback`, while OIDC uses the RFC 8252
section 7.1 authority-less form `eu.qwky.trinity:/sso-callback`. Matching on `://` would
silently drop every OIDC callback.

Three operating-system sources funnel into one `deliverDeepLink()`: the macOS `open-url`
event, which is registered early because a cold protocol launch can fire it at or before
`ready`; the Windows and Linux cold-start `argv`; and the `second-instance` `argv` when a
protocol activation re-launches an already-running app. URLs buffer in a pending queue and
flush on `whenReady` and on `did-finish-load`, and the preload buffers again on the
renderer side, so a link that arrives before Angular subscribes is replayed rather than
lost.

An unpackaged development run registers `process.execPath` plus the resolved entry path,
which is what Electron requires for the OS to re-launch it correctly.

## Secret storage

The main process backs `SecureStorageService`'s strongest backend using Electron's
`safeStorage`. Values are stored as a JSON map of key to base64 ciphertext in a single
mode-0600 file under `app.getPath('userData')`.

The availability check does more than call `isEncryptionAvailable()`:

```ts
const backend = safeStorage.getSelectedStorageBackend?.();
return backend !== 'basic_text' && backend !== 'unknown';
```

On Linux, when Electron can find no OS password manager, it falls back to a `basic_text`
backend that "encrypts" with a hardcoded key. That is obfuscation, not encryption — anything
running as the user recovers the Matrix access token and the cross-signing keys — and
`isEncryptionAvailable()` still reports `true`. Refusing it makes the renderer take its
documented plaintext fallback and log the anomaly, rather than storing a secret under a
false promise.

[electron/src/secure-store.ts](https://github.com/quwisky/trinity-matrix-client/blob/develop/electron/src/secure-store.ts)
takes `safeStorage` and the store path as parameters and imports `electron` only as a type,
so it has no runtime dependency on Electron and is unit-testable in plain Node.

## Packaging with electron-builder

Configuration is
[electron/electron-builder.yml](https://github.com/quwisky/trinity-matrix-client/blob/develop/electron/electron-builder.yml).
App id `eu.qwky.trinity`, product name Trinity, `asar: true`, output to `electron/release/`.

| Platform | Targets       | Notes                                                                                                                                     |
| -------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | dmg, zip      | `public.app-category.social-networking`, `hardenedRuntime: true`                                                                          |
| Linux    | AppImage, deb | Category Network. The `homepage` field in `package.json` is required, not decoration: fpm fails the whole deb build without a package URL |
| Windows  | nsis          | `oneClick: false`, `perMachine: false`, installation directory changeable                                                                 |

What goes into the bundle is `dist/**/*`, `www/**/*` and `package.json`, minus `**/*.map` —
source maps for the privileged main and preload processes must not ship.

Three PNGs stay **outside** the asar via `extraResources`: `trinityTray.png`,
`trinityTrayTemplate.png` and `unreadOverlay.png`. `nativeImage` needs real files on disk
resolvable through `process.resourcesPath`, and `icons.ts` probes four candidate locations
so the same code finds them in development and when packaged.

The `protocols:` block registers `eu.qwky.trinity` at OS level: `CFBundleURLTypes` on
macOS, a `MimeType` entry in the `.desktop` file on Linux. Windows registration happens at
runtime through `app.setAsDefaultProtocolClient` instead.

### Fuses

[electron/afterPack.cjs](https://github.com/quwisky/trinity-matrix-client/blob/develop/electron/afterPack.cjs)
runs before signing and flips three V1 fuses off on the packaged binary: `RunAsNode`,
`EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments`.

Without them, a local unprivileged process can re-launch the _signed_ Trinity binary as
Node — `ELECTRON_RUN_AS_NODE=1`, `NODE_OPTIONS=--require evil.js`, or `--inspect` — and run
arbitrary code inside the trusted main process, the one holding keychain access to the
secret store. The hook passes `resetAdHocDarwinSignature` on macOS because mutating fuses
invalidates the signature, and it throws rather than shipping an unhardened binary if it
cannot find the executable.

`OnlyLoadAppFromAsar`, `EnableEmbeddedAsarIntegrityValidation` and `EnableCookieEncryption`
are not flipped.

### Signing and notarization

macOS signing is fully wired and inert without credentials. `mac.identity` is deliberately
not pinned, so electron-builder auto-discovers a "Developer ID Application" certificate
from the login keychain, or from `CSC_LINK` plus `CSC_KEY_PASSWORD`. The hardened-runtime
entitlements grant `allow-jit`, `allow-unsigned-executable-memory` and
`disable-library-validation` — V8 and the crypto WASM need executable memory, and a signed
hardened-runtime build crashes on launch without them — plus `network.client`.

`build/notarize.cjs` runs as the `afterSign` hook and logs a line and returns when no
credentials are present. It supports an App Store Connect API key
(`APPLE_API_KEY` as a path to a `.p8`, plus `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`) or an
Apple ID (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). It requires
`@electron/notarize` lazily so non-macOS builds never load it.

macOS only delivers the app's OS notifications when the app is signed and notarized, so a
build meant for real use must go through `pnpm electron:package:mac:signed`.

Windows code signing is a TODO in the configuration, and auto-update is not wired at all —
the `publish:` block is commented out.

!!! danger "Two packaging traps"

    **Never run `pnpm electron:build` or any `electron:package:*` script in CI.** They end
    with `electron:sign:dev`, which ad-hoc-signs the local Electron binary against a
    self-signed `trinity-dev` identity that exists on no runner. The release workflow runs
    the three useful steps directly instead: `pnpm build`, then
    `pnpm -C electron install --frozen-lockfile`, then `pnpm -C electron run build`,
    then `electron-builder` with the platform flag.

    **`pnpm electron:package:mac` hardcodes an arm64 output path.** Its trailing ad-hoc
    re-sign points at `release/mac-arm64/Trinity.app`, but electron-builder writes x64
    output to `release/mac/`. On an Intel Mac the build succeeds and then dies on
    `codesign: No such file or directory`. Fix the path or re-sign by hand.

The release workflow builds macOS on `macos-latest`, which is Apple Silicon, and
electron-builder defaults to the host architecture — so released macOS artifacts are arm64
only, by choice. See [CI and releases](../contributing/ci-and-releases.md).

## How the desktop contract is tested

[e2e/playwright.electron.config.mts](https://github.com/quwisky/trinity-matrix-client/blob/develop/e2e/playwright.electron.config.mts)
launches the real built application through Playwright's `_electron` helper, one worker, no
parallelism. It is the only gate in the repository that exercises the custom scheme, WASM
stream instantiation, the sandbox posture and `safeStorage`.

```bash
pnpm electron:e2e
```

Each launch gets a fresh temporary `--user-data-dir`, so the app always starts
unauthenticated. The launcher also passes `--no-sandbox`, which disables Chromium's
zygote process sandbox so the binary can run as root or inside a container. That is a
different thing from the application's `webPreferences.sandbox`, which stays `true` — and
the suite proves it, by asserting `require` and `process` are undefined in the renderer.

More on the wider test suite in [Testing](../contributing/testing.md).
