# Web

The web build is the baseline target. Desktop and mobile do not build the application
themselves — they copy the output of this build. Understanding what `pnpm build` produces
therefore explains most of what the other two platforms are shipping.

Everything on this page is configured in
[apps/trinity/project.json](https://github.com/quwisky/trinity-matrix-client/blob/develop/apps/trinity/project.json).

## The builder

Trinity uses the modern Angular builders only:

```json
"build":  { "executor": "@angular/build:application" }
"serve":  { "executor": "@angular/build:dev-server" }
```

`@angular-devkit/build-angular` is not a dependency of this workspace at all. The
deprecated Webpack-era builders are gone, so guidance written for `browser` or
`browser-esbuild` targets does not apply here — `application` is a different builder with
a different options schema.

The framework packages sit at 22.1.0 while `@angular/build` and `@angular/cli` sit at
22.1.2. That mismatch is deliberate; the CLI and the framework are released on separate
patch lines. See [the stack reference](../reference/stack.md) for the pinned set.

## Where the build output goes

```json
"outputPath": { "base": "www", "browser": "" }
```

Two things are unusual here and both are load-bearing.

The base is `www` at the workspace root, not `dist/`. That is the directory
`capacitor.config.ts` names as `webDir`, and the directory
[electron/scripts/copy-www.mjs](https://github.com/quwisky/trinity-matrix-client/blob/develop/electron/scripts/copy-www.mjs)
copies verbatim. One output location serves all three consumers.

`"browser": ""` flattens the layout. Angular 17 and later default to emitting browser
assets under a `browser/` subdirectory, which would put `index.html` at `www/browser/index.html`
and break both wrappers. Setting the segment to the empty string puts `index.html`
directly in `www/`.

The Nx target declares `outputs: ["{workspaceRoot}/www"]` so a cache hit restores the
directory rather than leaving it stale. `www/` is gitignored.

## The build-info pre-step

Both `build` and `serve` declare `dependsOn: ["build-info"]`, an uncached target that runs
[scripts/gen-build-info.mjs](https://github.com/quwisky/trinity-matrix-client/blob/develop/scripts/gen-build-info.mjs).
It writes `apps/trinity/src/app/build-info.ts` with the package version and the short git
commit, suffixed `-dirty` when the working tree is modified. `apps/trinity/src/main.ts`
passes it to `provideTrinityApplication()`, whose capability bindings provide the `BUILD_INFO`
token displayed in Settings.

The generated file is gitignored and the generator is idempotent: it only writes when the
version or commit actually changed, so rebuilding on the same commit does not dirty the
tree. Do not commit it.

## The crypto WebAssembly asset

This is the single most consequential piece of build configuration in the repository.

```json
{
  "glob": "matrix_sdk_crypto_wasm_bg.wasm",
  "input": "node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg",
  "output": "assets/crypto"
}
```

`matrix-js-sdk` loads the Rust crypto module by resolving `./pkg/…wasm` relative to its own
bundled JavaScript. Angular's esbuild pipeline never emits a file at that location, so the
default loader 404s and encryption fails to initialise. The asset entry above copies the
module into `assets/crypto/`, and
[libs/util/matrix/src/lib/crypto-wasm-loader.ts](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/util/matrix/src/lib/crypto-wasm-loader.ts)
calls `initAsync` against that path explicitly, before `initRustCrypto()` ever runs:

```ts
const url = new URL('assets/crypto/matrix_sdk_crypto_wasm_bg.wasm', document.baseURI);
return from(initAsync(url));
```

The loader memoizes with `shareReplay(1)`, and the underlying module promise is memoized by
the WASM package itself, so the call `initRustCrypto()` makes later reuses this instance.
Resolving against `document.baseURI` rather than a hardcoded path is what lets the same
code work under `trinity://app` in the desktop shell and under a Capacitor WebView origin
on mobile.

The Electron copy step re-checks that the file survived the copy and prints its size,
because a silent loss here produces a failure that only shows up at login.

## Content Security Policy

The CSP is a `<meta http-equiv>` element in
[apps/trinity/src/index.html](https://github.com/quwisky/trinity-matrix-client/blob/develop/apps/trinity/src/index.html).
It is a backstop behind the explicit sanitization of message HTML, not the primary
defence. Three of its decisions are worth knowing:

- `connect-src 'self' https: wss:` cannot be pinned to a host, because the homeserver is
  chosen by the user at login. Scoping to `https:` and `wss:` still blocks plain-`http:`
  and `data:` exfiltration, including intranet and localhost reads.
- `img-src` deliberately omits `https:`. The application never binds a remote `<img>` —
  avatars and media are fetched through `connect-src` and bound as `blob:` — and the
  sanitizer strips remote `src` attributes from message HTML. Allowing `https:` images
  would reopen the tracking-pixel and IP-leak vector for nothing.
- `script-src` includes `'wasm-unsafe-eval'`, required by the Rust crypto module, and
  `style-src` includes `'unsafe-inline'`, required by Angular's runtime `<style>`
  injection and the CDK overlay.

`frame-ancestors` is absent from the meta policy on purpose: browsers ignore that
directive in a `<meta>` CSP. Every web deployment must send
`Content-Security-Policy: frame-ancestors 'none'` as a real response header for the app
shell (and should also send `X-Frame-Options: DENY` for older clients). This is part of
the widget-embedding boundary: a third-party frame can navigate itself, so the app's own
response must refuse to render if that navigation points back to Trinity's HTTPS origin.
The Electron protocol handler sets both headers itself; static web hosting must be
configured separately because the compiled bundle cannot set response headers.

## The service worker

Production builds register the Angular service worker configured by
[apps/trinity/ngsw-config.json](https://github.com/quwisky/trinity-matrix-client/blob/develop/apps/trinity/ngsw-config.json).
Two prefetch asset groups cover the application shell — `index.html`, the top-level CSS and
JS — and everything under `assets/**` plus the media and font extensions, `wasm` among
them. Prefetching the crypto module matters: without it the first offline start would have
no way to initialise encryption.

Registration is gated to the production web build. Native and desktop already load these
files from local storage and must not layer a second cache over them, which is why the
condition in `main.ts` checks Capacitor _and_ the Electron marker. See
[Platforms](index.md#detecting-the-platform).

The production Application Runtime session adapter owns `SwUpdate.unrecoverable` and reloads the page
when it fires, recovering from a cache that storage eviction has left unusable.

The same session-owned stream watches `versionUpdates` for `VERSION_READY` and offers a Reload toast that calls
`activateUpdate()` before reloading, and re-checks for a deploy whenever the tab returns to
the foreground. The Angular service worker is version-locked per client: a tab keeps being
served the version it booted with, and a new one only becomes active for a client that
starts afterwards. A chat tab can stay open for weeks, so without this a shipped fix — to
the crypto or session code included — would sit undelivered on exactly the clients that use
the app most.

The installable web app manifest (`manifest.webmanifest`) is linked from `index.html` and
prefetched in the `app` asset group, which is what makes the browser offer **Install app**.

`pnpm nx run trinity-e2e-web:production-pwa` is the focused production Web/PWA host
acceptance target. It builds the exact `www/` artifact, serves it without Synapse or Docker,
proves that the script-free splash follows light and dark system Mode, verifies untouched
Appearance defaults and live system changes, then opens Chromium's standalone app window through
an unknown deep link and checks the login startup surface and manifest. In that installed-PWA
context it waits for service-worker control, reloads a dark Onyx deep link offline, and proves both
the semantic styling and cached crypto WASM survived. Keep production-only host coverage here
rather than in the development Playwright suite.

`pnpm e2e:web` adds the production-renderer matrix to that host contract. Alongside the seven
authenticated geometry and contrast profiles, catalog-driven desktop and Pixel 5 projects prove
all six Theme × Mode combinations against the same artifact. The aggregate therefore requires
Docker for its authenticated scenarios.

## Why inlineCritical is off

```json
"styles": { "minify": true, "inlineCritical": false }
```

Critical-CSS inlining rewrites the real stylesheet link so it loads asynchronously and is
applied by an `onload` handler. That handler never fires over the `trinity://` scheme the
desktop shell serves from, so the packaged desktop app rendered with only the inlined
critical subset — most visibly, dark mode came out light.

The fix is to disable the optimisation for every target rather than fork the production
configuration per platform. There is a live regression test in
[e2e/electron/app.electron.spec.mts](https://github.com/quwisky/trinity-matrix-client/blob/develop/e2e/electron/app.electron.spec.mts):
it drives the real Appearance preferences inside the Electron renderer, proves untouched system
Mode plus explicit Amethyst light and Onyx dark states, and rejects asynchronous stylesheet swaps
while checking that their semantic tokens resolve through the linked production stylesheet.

!!! warning "Do not re-enable inlineCritical without running the desktop e2e suite"

    The failure is invisible in a browser and invisible in unit tests. It only appears
    once the build is served over the custom scheme.

## Other production settings

| Setting                | Value                                                        | Note                                                                        |
| ---------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `defaultConfiguration` | `production`                                                 | A bare `nx build trinity` is a production build                             |
| `outputHashing`        | `all`                                                        | Content hashes on scripts, styles and media                                 |
| `fileReplacements`     | `environment.ts` becomes `environment.prod.ts`               | Carries the push-gateway configuration                                      |
| Budgets                | initial 2 mb warn, 5 mb error; component style 6 kb and 8 kb | The initial budget is the one that bites when a lazy route stops being lazy |

The development configuration disables optimization and enables source maps and named
chunks. Run it with `pnpm nx build trinity --configuration=development`; the e2e
harnesses use exactly that.

`apps/trinity/src/polyfills.ts` is intentionally empty. The application is zoneless, so
zone.js is not imported, and every targeted browser is evergreen enough to need nothing
else.

## Browser support floors

```text
Chrome >=119        ChromeAndroid >=119
Firefox >=119       FirefoxAndroid >=119
Edge >=119
Safari >=17         iOS >=17
```

These are not a Trinity preference. They are the resolved form of Angular 22.1's own support
policy, which the framework expresses as `baseline widely available on 2026-05-07`. The
build warns about any browser configured in `.browserslistrc` that falls outside that set,
so the file has to track the framework. Re-resolve after each Angular major:

```bash
node -e "console.log(require('browserslist')('baseline widely available on <DATE>').join('\n'))"
```

The `ChromeAndroid` and `FirefoxAndroid` entries are not redundant with their desktop
counterparts. Browserslist treats them as separate targets, and without them the Android
WebView that Trinity ships through Capacitor would be absent from the target set entirely.
[MDN's browser compatibility data](https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/oklch#browser_compatibility)
records Firefox 113 as the first `oklch()` release, with Firefox Android mirroring it. The current
Angular floor is already stricter at 119, so the Trinity Theme needs no legacy colour fallback.

## Serving the build

`pnpm start` runs the dev server with hot reload on Angular's default port 4200.

For a production check, serve `www/` with any static server that falls back to
`index.html` for unknown paths — Trinity uses client-side routing, so a hard refresh on
`/rooms` must not 404. Installation notes for end users are in
[Installing Trinity](../users/install.md).
