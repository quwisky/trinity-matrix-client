# Stack reference

Every version below is the version installed on disk, not the range in `package.json`.
That is enforced: [`scripts/stack-versions.spec.mjs`](https://github.com/quwisky/trinity-matrix-client/blob/develop/scripts/stack-versions.spec.mjs)
parses the tables on this page, and for every row whose version cell is a complete
`major.minor.patch` it asserts the value equals
`node_modules/<package>/package.json`'s `version`. It runs as part of `pnpm test`, so a
dependency bump that does not update this page turns CI red.

The spec skips rows whose version cell is not a complete semver, and asserts that at
least ten rows survive that filter — otherwise a table rewrite could quietly leave a
guard that verifies nothing. The guard exists because the table drifted after four
separate dependency waves and had to be corrected by hand each time, once with the
correction itself leaving another row stale.

!!! warning "The version guard replays a stale cached pass locally"

    The `scripts` project inherits Nx's default `test` inputs (`{projectRoot}/**/*`
    plus `sharedGlobals`). This page, `package.json` and `pnpm-lock.yaml` are all
    outside that set, and `node_modules/*/package.json` is read at runtime where Nx
    never sees it — so the cache key only moves when a file under `scripts/` changes.
    After editing this table run `pnpm exec nx test scripts --skip-nx-cache`. CI is
    unaffected: its runners are always cold.

## Runtimes

| Runtime | Pin                      | Where it is set                                                   |
| ------- | ------------------------ | ----------------------------------------------------------------- |
| Node.js | `^24.15.0 \|\| >=26.0.0` | `package.json` `engines`, `.nvmrc` (`24.18.1`), CI `node-version` |
| pnpm    | `11.19.0`                | `package.json` `packageManager`, enforced by corepack             |

Node 25 is excluded, and that is not arbitrary: the range is Angular 22's own engines
window. matrix-js-sdk only asks for `>=22`, so "newer is fine" does not hold here.
A `preinstall` script inspects `npm_config_user_agent` and aborts anything that is not
pnpm.

Browser floors live in `.browserslistrc`: Chrome and Edge `>=111`, Firefox `>=112`,
Safari and iOS `>=16.4`, plus separate `ChromeAndroid` and `FirefoxAndroid` entries.
Those two Android entries are not redundant — browserslist treats them as distinct
targets, and without them the Android WebView Trinity ships through Capacitor would be
absent from the target set entirely. The list is the resolved form of Angular 22's
`baseline widely available on 2025-10-20` policy; re-resolve it after each Angular
major rather than editing numbers by hand.

## Application dependencies

| Package                                                                        | Version | Notes                                                                                                     |
| ------------------------------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| `@angular/core`                                                                | 22.1.0  | Standalone components, signals, zoneless. `polyfills.ts` is empty on purpose: no zone.js                  |
| `@angular/forms`                                                               | 22.1.0  | Signal Forms (`@angular/forms/signals`) only. No `FormControl`, `FormGroup` or `ngModel` anywhere         |
| `@angular/cdk`                                                                 | 22.1.0  | Overlay and Dialog under the Helm overlays, and the encryption route dialogs                              |
| `@angular/service-worker`                                                      | 22.1.0  | PWA service worker, production web build only. Off in the Electron shell                                  |
| `@spartan-ng/brain`                                                            | 1.3.0   | Headless UI primitives. The styled Helm layer is copied into `libs/kit/*` and aliased `@trinity/kit/*`    |
| `tailwindcss`                                                                  | 4.3.3   | v4, configured from CSS. Tokens live in `theme/variables.scss`, framework wiring in `theme/spartan.css`   |
| `tw-animate-css`                                                               | 1.4.0   | Animation utilities the Helm components expect                                                            |
| `@ng-icons/lucide`                                                             | 34.0.0  | Icon set behind `<trn-icon>`; imported only by `@trinity/kit/icon`; `@ng-icons/core` moves with it        |
| `matrix-js-sdk`                                                                | 42.1.0  | The single source of truth for rooms, timelines and crypto. Crypto types are a deep import, see below     |
| `@matrix-org/matrix-sdk-crypto-wasm`                                           | 18.4.0  | Rust crypto backend. Its `.wasm` needs an explicit URL, see below                                         |
| `rxjs`                                                                         | 7.8.2   | One-shot actions return cold Observables; state is signals                                                |
| `marked`                                                                       | 18.0.7  | Markdown to HTML for the composer and the timeline                                                        |
| `dompurify`                                                                    | 3.4.13  | Sanitizes `formatted_body` against the Matrix allowlist, inbound and outbound, from one config            |
| `@shikijs/core`                                                                | 4.4.1   | Syntax highlighting for fenced code blocks                                                                |
| `@shikijs/engine-javascript`                                                   | 4.4.1   | Pure-JS RegExp engine, chosen over the default Oniguruma WASM to avoid a second wasm asset and its loader |
| `@shikijs/langs`                                                               | 4.4.1   | TextMate grammars; 31 languages imported explicitly. Must move in lockstep with the two rows above        |
| `@sanity/diff-match-patch`                                                     | 3.2.0   | Character-level diff behind the edit-history highlights. Apache-2.0, no dependencies                      |
| `luxon`                                                                        | 3.7.2   | Date and time arithmetic, including the day-separator rollover                                            |
| `@ctrl/ngx-emoji-mart` <!-- reached only through @trinity/kit/emoji-picker --> | 9.3.0   | Emoji picker for the composer and reactions                                                               |
| `@capacitor/core`                                                              | 8.5.0   | Capacitor 8. `@capacitor/android` and `@capacitor/ios` track it exactly                                   |
| `@capacitor/app`                                                               | 8.1.1   | App URL-open events; the native deep-link callback for SSO and OIDC                                       |
| `@capacitor/browser`                                                           | 8.0.4   | System browser for native sign-in, which keeps the app WebView alive                                      |
| `@capacitor/camera`                                                            | 8.2.2   | Native photo and gallery picker, with a web `<input>` fallback                                            |
| `@capacitor/filesystem`                                                        | 8.1.2   | Writes a downloaded attachment to cache before handing it to the share sheet                              |
| `@capacitor/share`                                                             | 8.0.1   | Native save and share sheet, with a web `<a download>` fallback                                           |
| `@capacitor/status-bar`                                                        | 8.0.3   | Matches the native status bar to the light or dark theme                                                  |
| `@capacitor/preferences`                                                       | 8.0.1   | Device-local settings, including the push gateway override                                                |
| `@capacitor/push-notifications`                                                | 8.1.2   | FCM and APNs device token for the Matrix pusher, see [push notifications](push-notifications.md)          |
| `@capawesome/capacitor-badge`                                                  | 8.0.2   | Native launcher badge on iOS and Android                                                                  |
| `@aparajita/capacitor-secure-storage`                                          | 8.0.0   | Keychain and Keystore for the access token on native                                                      |

`matrix-encrypt-attachment` was removed rather than upgraded: it has been unmaintained
since 2022, and its logic is ported into `attachment-crypto.ts` in `@trinity/util/matrix`.

## Toolchain

| Package                         | Version | Notes                                                                                               |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `@angular/build`                | 22.1.2  | The `application` builder and `dev-server`. `@angular-devkit/build-angular` is not installed at all |
| `nx`                            | 23.1.1  | Task graph, caching, module boundaries. The `@nx/*` plugins track this version                      |
| `typescript`                    | 6.0.3   | `moduleResolution: bundler`; `@trinity/*` aliases in `tsconfig.base.json`                           |
| `@types/node`                   | 24.13.3 | Tracks the runtime major, not the newest release                                                    |
| `vitest`                        | 4.1.10  | Unit tests, run through an `nx:run-commands` target so Vitest args come after `--`                  |
| `vite`                          | 8.2.0   | Shared config in `vite.base.config.ts`                                                              |
| `@analogjs/vite-plugin-angular` | 2.6.4   | Compiles Angular for Vite. `@analogjs/vitest-angular` moves with it                                 |
| `jsdom`                         | 30.0.1  | DOM environment for unit tests                                                                      |
| `@testing-library/angular`      | 19.4.1  | Component tests. Import `render` from `@trinity/testing`, not from here, see below                  |
| `ng-mocks`                      | 14.16.0 | `MockProvider` and `MockComponent` for isolating a component under test                             |
| `@playwright/test`              | 1.62.1  | The `trinity-e2e` app-journey suite and the Electron suite. `playwright` standalone tracks it       |
| `eslint`                        | 10.8.0  | Flat config in `eslint.config.mjs`                                                                  |
| `typescript-eslint`             | 8.65.0  | Supplies the type-aware `no-deprecated` rule                                                        |
| `angular-eslint`                | 22.1.0  | Template and component rules, including the `trn` selector prefix                                   |
| `prettier`                      | 3.9.6   | `singleQuote`; Angular parser for `*.page.html`; Tailwind class sort                                |
| `stylelint`                     | 17.14.1 | SCSS lint, run separately from `pnpm lint`                                                          |
| `@commitlint/cli`               | 21.2.1  | `commit-msg` hook enforcing Conventional Commits                                                    |
| `husky`                         | 9.1.7   | Installs the `pre-commit` and `commit-msg` hooks                                                    |
| `lint-staged`                   | 17.3.0  | ESLint plus Prettier over staged files                                                              |

### Desktop shell

The Electron shell in `electron/` is a separate package with its own `package.json`,
its own `node_modules` and its own TypeScript. Its versions are therefore not visible
to the guard above, which only reads the workspace root's `node_modules`.

| Package            | Version | Notes                                                                  |
| ------------------ | ------- | ---------------------------------------------------------------------- |
| `electron`         | 43.2.0  | Declared in `electron/package.json`                                    |
| `electron-builder` | 26.15.7 | Packaging: macOS dmg and zip, Linux AppImage and deb, Windows nsis     |
| `typescript`       | 6.0.3   | Same exact version as the root workspace, kept in lockstep by Renovate |

See [the desktop platform page](../platforms/desktop.md) for what that shell does.

## Integration notes

### The crypto WASM needs an explicit URL

matrix-js-sdk's default loader resolves `matrix_sdk_crypto_wasm_bg.wasm` relative to its
own bundled JavaScript (`./pkg/…`). Angular's esbuild never emits an asset at that path,
so the fetch 404s and crypto never initializes.

The fix has two halves that must stay in step. The build target copies the file out of
`node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg` into `assets/crypto`, and
[`crypto-wasm-loader.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/util/matrix/src/lib/crypto-wasm-loader.ts)
calls `initAsync` against that served path before `initRustCrypto()`:

```ts
const url = new URL('assets/crypto/matrix_sdk_crypto_wasm_bg.wasm', document.baseURI);
return from(initAsync(url));
```

The call is memoized with `shareReplay(1)`, so the loader matrix-js-sdk invokes later
inside `initRustCrypto()` reuses the same module instance. The Electron copy step
re-checks the file exists after copying and prints its byte size, because a silently
missing WASM is otherwise only discovered at sign-in.

### Crypto types are deep imports

matrix-js-sdk does not re-export the crypto API from the package root (still true in 42.x). `CryptoApi`,
`CryptoEvent`, `decodeRecoveryKey`, `EventShieldColour`, `ServerSideSecretStorage` and
`SecretStorageKeyDescriptionAesV1` come from `matrix-js-sdk/lib/crypto-api` and
`matrix-js-sdk/lib/secret-storage`.

Those deep paths resolve only because the SDK's `package.json` has no `exports` field.
If upstream adds one, every deep import in this repository breaks at once. The root does
export a `SecretStorage` namespace, which is a different thing and is not what the code
uses.

### Shiki is pinned exactly, and stays out of the eager bundle

The three `@shikijs/*` packages must move together. `@shikijs/langs-precompiled` is not
usable here at all: it emits `v`-flag regular-expression literals, which are below the
Safari 16.4 floor the browserslist policy sets.

The grammars are roughly 813 KB raw and 134 kB gzipped. `message-view.ts` consumes the
highlighter and sits in the eager chunk, so exporting `code-highlight` from the
`@trinity/util/matrix` barrel would drag every grammar into the initial bundle. It is
reachable only through the `@trinity/util/matrix/code-highlight` path alias and imported
for side effect at the top of the rooms page, which puts it in the lazy rooms chunk.
Nothing enforces that — only the comment at the barrel.

### The web build output goes to www, flat

`outputPath` is `{ "base": "www", "browser": "" }`. The empty `browser` is the
load-bearing half: Angular 17 and later otherwise emit into `<base>/browser/`.
Flattening puts `index.html` directly in `www/`, which is what Capacitor's
`webDir: 'www'` expects and what the Electron shell copies verbatim.

`defaultConfiguration` is `production`, so a bare `pnpm build` is a production build —
and every `electron:*`, `android:*` and `ios:*` script chains off it. Only the spike and
e2e scripts pass `--configuration=development` explicitly.

### Angular framework and CLI versions differ on purpose

The framework packages sit at 22.1.0 while `@angular/build` and `@angular/cli` sit at
22.1.2. They are released on separate lines; matching them is not a goal, and a
dependency tool that "fixes" the mismatch is wrong.

### Vitest runs in the forks pool

`vite.base.config.ts` sets `pool: 'forks'`. That is Vitest's own default, but
`@analogjs/vite-plugin-angular` overrides it to `vmThreads` — the one pool that sets no
worker isolation, so jsdom windows, TestBed state and module graphs accumulate in a
single V8 isolate. Measured: `feature-rooms` peaked at 4.27 GB and was OOM-killed on
about half of full `nx run-many -t test` runs. `forks` drops it to 0.91 GB at roughly
19 percent more wall time.

### Testing Library is wrapped

The app is zoneless. Angular Testing Library 19.4.1's zoneless `render()` binds only
through Angular's native `bindings` API and silently ignores the `inputs` and `on`
options, which surfaces as NG0950 during the first change detection. `@trinity/testing`
wraps it: render with `skipDetectChanges`, apply `inputs` via `setInput`, wire `on`
handlers, then detect. Always `import { render } from '@trinity/testing'`.

### pnpm 11 build scripts are strict

pnpm 11 replaced `pnpm.onlyBuiltDependencies` with an `allowBuilds` name-to-boolean map
in `pnpm-workspace.yaml`, and `strictDepBuilds` now defaults to true. A dependency with
an install script that is neither allowed nor blocked fails the install rather than
being skipped. Six are allowed (`@parcel/watcher`, `@swc/core`, `esbuild`, `lmdb`,
`msgpackr-extract`, `nx`); `less` is explicitly blocked because it arrives transitively
with a build script and was never on the old allowlist.

`electron/pnpm-workspace.yaml` exists for the same reason on the shell's own root, and
blocks `electron-winstaller`.

## Version-specific traps

| Trap                                                                    | What to do                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A TypeScript bump rewrites `electron/tsconfig.json`                     | `@nx/js` codemods glob every `tsconfig*.json`, the shell's included. It must keep the Node16 `module`/`moduleResolution` pair — TypeScript 6 rejects node10 with TS5107. Verify with `cd electron && ./node_modules/.bin/tsc -p tsconfig.json --noEmit` |
| A Playwright bump invalidates the downloaded browsers                   | Each release pins its own browser build. Run `pnpm exec playwright install chromium webkit` after the bump. The 1.61 to 1.62 bump failed 165 of 167 specs this way                                                                                      |
| A Capacitor bump strands the checked-in native projects                 | `cap sync` writes pnpm content-addressed absolute paths into `android/capacitor.settings.gradle` and `ios/App/CapApp-SPM/Package.swift`. Re-run `pnpm android:sync` and `pnpm ios:sync` and commit the regenerated files                                |
| A matrix-js-sdk bump can change `resetEncryption` without changing ours | Trinity owns a hand-written copy of that flow. Diff `rust-crypto.js`'s `resetEncryption` on every bump; see [Matrix and encryption](../architecture/matrix-and-encryption.md)                                                                           |
| An Angular major moves the browserslist baseline                        | Re-resolve rather than editing numbers: `node -e "console.log(require('browserslist')('baseline widely available on <DATE>').join('\n'))"`                                                                                                              |
| An Angular major moves the TypeScript peer window                       | `@angular/compiler-cli` peer-depends on one minor window and pnpm only warns about an unmet peer, so the root TypeScript ceiling is capped by hand in the dependency-bot config                                                                         |

## Related pages

- [Getting started](../contributing/getting-started.md) for the install and first build
- [Troubleshooting](troubleshooting.md) for symptoms these versions produce
- [Architecture overview](../architecture/index.md) for how the libraries fit together
