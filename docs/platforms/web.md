# Run and deploy the Web/PWA host

Use this guide to run the shared renderer in a browser, check its production PWA behavior,
and prepare the static artifact for an authorized deployment. For installing an existing
release, start with [Installing Trinity](../users/install.md). For Node, pnpm and checkout
setup, use [Getting started](../contributing/getting-started.md).

## Run and debug locally

```bash
pnpm start
```

Open the printed address, normally `http://localhost:4200`, and stop the server with Ctrl+C.
A fresh browser reaches sign-in. This confirms startup, not authentication or encryption.
Use browser developer tools to inspect console errors, network requests and source maps;
redact tokens and message content before sharing diagnostics.

The development server enables source maps and named chunks without the production service
worker. A development-only pass cannot establish offline startup, update handling or the
packaged desktop stylesheet behavior. Use the relevant production check below.

## Build and check production

```bash
pnpm build
pnpm nx run trinity-e2e-web:production-pwa
```

The first command creates root `www/`. The second owns a production build, a temporary
static server and Chromium acceptance checks; install the matching Playwright browser first.
It needs no Docker or account credentials. Do not start another server for that invocation.

The PWA target exercises startup and deep-link fallback, manifest and standalone-window
behavior, service-worker control, offline shell loading and cached crypto WASM, including
Appearance states. It does not prove an actual browser installation offer, authenticated
Matrix operation or mobile push. `pnpm e2e:web` additionally runs the authenticated
production-renderer matrix and requires Docker. See
[E2E ownership](../contributing/e2e-architecture.md) for prerequisites and ignored artifacts.

## Serving the build

Publish the complete `www/` directory to an HTTPS static host, retaining the relative paths
of the generated assets. The current HTML base and manifest scope/start URL assume the
origin root `/`; hosting beneath a subpath needs explicit configuration and validation.
Configure application navigation to fall back to `index.html`, so directly opening or
refreshing a route such as `/rooms` reaches Angular rather than a server 404. Serve real
asset files with their correct content types, including WebAssembly; do not return the
application HTML for a missing script or WASM file.

Set the response headers described below at the real host. Check a direct deep link, loaded
assets, manifest, service-worker control and an update after deployment. A local PWA test
uses its own server and cannot prove your production host sends the correct headers.
Publication and release authorization belong to
[maintainer guidance](../maintaining/index.md); building locally does not publish anything.

## Where the build output goes

The resolved `trinity:build` target sets `outputPath` to `{ "base": "www", "browser": "" }`.
The empty browser segment keeps `index.html` directly in `www/`, which Capacitor consumes
and [the Electron copy step](../../electron/scripts/copy-www.mjs) copies to `electron/www/`.
Keep this shared artifact layout when changing the builder. Nx declares `www/` as an output
so a cache hit restores it; the directory is ignored by Git.

## The builder

The renderer uses `@angular/build:application`; serving uses `@angular/build:dev-server`.
Inspect their resolved options with `pnpm nx show project trinity --json` before adapting
examples for older Angular builders. Package compatibility is documented in
[the stack reference](../reference/stack.md), rather than duplicated here.

The default build configuration is production. For development output without a server:

```bash
pnpm nx run trinity:build:development
```

Host dependencies select their own build targets. A configuration argument on a wrapper
command does not automatically change the configuration of its renderer dependency.

## The build-info pre-step

Both build and serve depend on the uncached `build-info` target.
[`gen-build-info.mjs`](../../scripts/gen-build-info.mjs) writes the version and short Git
revision, including a dirty marker when applicable, into the ignored
`apps/trinity/src/app/build-info.ts`. Application Runtime supplies this value to Settings.
Do not commit the generated file. Include the displayed revision when diagnosing an
unexpected artifact, and distinguish an Nx cache restoration from a new compilation.

## The crypto WebAssembly asset

The build copies `matrix_sdk_crypto_wasm_bg.wasm` from the installed Rust crypto package to
`www/assets/crypto/`. [The owned loader](../../libs/util/matrix/src/lib/crypto-wasm-loader.ts)
resolves it against `document.baseURI`, shares initialization and completes before
`initRustCrypto()`. The SDK's default bundle-relative path is not emitted by Angular.

When changing crypto dependencies or packaging, verify this file in the actual host artifact
and its network response. A missing WASM asset can leave the shell loading successfully but
make encrypted sign-in fail. See [Matrix and encryption](../architecture/matrix-and-encryption.md)
for the lifecycle and recovery contracts.

## Content Security Policy

[The application HTML](../../apps/trinity/src/index.html) provides a meta CSP alongside
message sanitization. Preserve its intended boundaries:

- `connect-src` permits the app origin and HTTPS/WSS connections because users choose their
  homeserver. It does **not** restrict HTTPS/WSS to public networks or one approved server.
- `img-src` omits arbitrary HTTPS images. Avatars and message images use owned fetches and
  blob URLs; widening this policy can enable tracking pixels.
- Scripts permit the WASM evaluation needed by crypto. Inline styles support Angular's
  runtime styling; this does not authorize inline script execution.

A meta CSP cannot enforce `frame-ancestors`. Every deployed web host must supply
`Content-Security-Policy: frame-ancestors 'none'` as a response header for the application
shell; also send `X-Frame-Options: DENY` for compatible older clients. Preserve any other
required response-policy directives. The compiled bundle cannot set these headers for the
server. This protects the app from being embedded, including navigation from a widget frame.
Electron provides its own protocol response headers; static hosting must configure them.

## The service worker

[The entrypoint](../../apps/trinity/src/main.ts) enables the Angular service worker only
for the production web host, excluding installed Capacitor and Electron renderers. Its
registration strategy waits for stability or 30 seconds. Development serving therefore
cannot exercise the same caching behavior.

[`ngsw-config.json`](../../apps/trinity/ngsw-config.json) prefetches the application shell,
manifest, scripts, styles and assets, including crypto WASM. It has no homeserver data cache
group. Offline app startup does not imply that unsynced messages, media or server actions
are available; Matrix state has its own local storage and recovery behavior. Browser storage
can also be evicted. See [user installation and offline limits](../users/install.md).

The session-owned [Application Runtime adapter](../../libs/application/runtime/src/lib/composition/trinity-application-session.adapter.ts)
checks for updates initially and when the host returns to the foreground. `VERSION_READY`
produces a Reload action; activation is followed by a page reload. An unrecoverable worker
state also reloads the page. Preserve this lifetime ownership rather than attaching another
update subscription from a route.

The manifest enables installation metadata; the browser decides whether to offer installation.
PWA installation does not enable Trinity's native APNs/FCM registration path. Browser
notification presentation and mobile push are separate capabilities; see
[notification guidance](../users/notifications.md).

## Why inlineCritical is off

The shared production artifact has `optimization.styles.inlineCritical: false`.
Asynchronous stylesheet swaps used by critical-CSS inlining do not work correctly over the
Electron `trinity://` scheme. Preserve this setting and test the launched desktop renderer
when changing stylesheet loading. A web dev server or jsdom test cannot prove that contract.
See [desktop validation](desktop.md#how-the-desktop-contract-is-tested).

## Other production settings

Production output uses hashed filenames, the production environment replacement, service-worker
configuration and enforced script/style budgets. The authoritative values live in the resolved
`trinity:build` configuration and [source project definition](../../apps/trinity/project.json).
Do not raise a budget merely to hide an unexpected eager import. Development disables
optimization and includes debugging output; it is a different validation configuration.

## Browser support floors

[The stack reference](../reference/stack.md#runtimes) records the current Node and browser
requirements. [`.browserslistrc`](../../.browserslistrc) includes Android browser targets
separately from desktop and defines the renderer's Safari/iOS floor. Native deployment
minimums are a separate constraint; see [mobile](mobile.md). After an Angular update,
review the installed builder's browser policy before accepting changed floors.
