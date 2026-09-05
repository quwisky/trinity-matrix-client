# Stack reference

Use this page when checking prerequisites or updating dependencies. The application and
build-tool tables record installed root package versions; the desktop table records
its separate manifest pins. For the checkout recipe, use
[getting started](../contributing/getting-started.md).

[`stack-versions.spec.mjs`](../../scripts/stack-versions.spec.mjs) compares complete
`major.minor.patch` table cells here and in the Matrix architecture guide with installed
root manifests. It requires at least **12** matching rows. Keep package names backticked
and version cells numeric so the guard can parse them. Packages absent from the root
installation are skipped; this is not a complete dependency compatibility test.

Run the guard after changing dependencies or these tables:

```bash
pnpm nx test scripts -- stack-versions
```

The resolved `scripts:test` target disables caching and declares cross-repository inputs,
including documentation, manifests and the lockfile. Diagnose failures against the current
installation; a successful run does not validate an uninstalled desktop package.

## Runtimes

| Runtime | Requirement                          | Source                                            |
| ------- | ------------------------------------ | ------------------------------------------------- |
| Node.js | `^24.15.0` — Node 24, at least 24.15 | Root `package.json`; `.nvmrc` selects the 24 line |
| pnpm    | `11.19.0`                            | Root `packageManager` pin; use Corepack           |

The repository's Node range governs this checkout even if a dependency accepts a broader
range. The preinstall guard rejects npm and Yarn. Internal libraries are Nx projects
resolved through TypeScript aliases, not separately installed pnpm workspace packages.
`electron/` deliberately has its own package installation.

Browser build targets in [`.browserslistrc`](../../.browserslistrc) are Chrome, Edge and
Firefox 119+, Android Chrome and Firefox 119+, and Safari/iOS 17+. Android entries are
separate build targets; keep them when updating the policy. The native deployment target
and renderer browser floor are different constraints; see [mobile](../platforms/mobile.md).
On an Angular major update, inspect the installed builder's support policy and re-resolve
the browser list before accepting new floors.

## Application dependencies

| Package                               | Version | Notes                                                                                                                                        |
| ------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `@angular/core`                       | 22.1.0  | Standalone components, signals, zoneless. `polyfills.ts` is empty on purpose: no zone.js                                                     |
| `@angular/forms`                      | 22.1.0  | Signal Forms (`@angular/forms/signals`) only. No `FormControl`, `FormGroup` or `ngModel` anywhere                                            |
| `@angular/cdk`                        | 22.1.0  | Overlay and Dialog behind the public component tier                                                                                          |
| `@angular/service-worker`             | 22.1.0  | PWA service worker, production web build only. Off in the Electron shell                                                                     |
| `@spartan-ng/brain`                   | 1.3.0   | Headless UI primitives. The styled Helm layer is copied into `libs/spartan/*` and aliased `@trinity/helm/*`                                  |
| `tailwindcss`                         | 4.3.3   | v4, configured from CSS. Theme Foundation exposes one aggregate stylesheet and keeps semantic values plus framework wiring internal          |
| `tw-animate-css`                      | 1.4.0   | Animation utilities the Helm components expect                                                                                               |
| `@ng-icons/lucide`                    | 34.0.0  | Icon set behind `<trn-icon>`; imported by `@trinity/components/foundations` and five generated kit libraries; `@ng-icons/core` moves with it |
| `matrix-js-sdk`                       | 42.1.0  | The single source of truth for rooms, timelines and crypto. Crypto types are a deep import, see below                                        |
| `@matrix-org/matrix-sdk-crypto-wasm`  | 18.4.0  | Rust crypto backend. Its `.wasm` needs an explicit URL, see below                                                                            |
| `rxjs`                                | 7.8.2   | One-shot actions return cold Observables; state is signals                                                                                   |
| `marked`                              | 18.0.7  | Markdown to HTML for the composer and the timeline                                                                                           |
| `dompurify`                           | 3.4.13  | Sanitizes `formatted_body` against the Matrix allowlist, inbound and outbound, from one config                                               |
| `@shikijs/core`                       | 4.4.1   | Syntax highlighting for fenced code blocks                                                                                                   |
| `@shikijs/engine-javascript`          | 4.4.1   | Pure-JS RegExp engine, chosen over the default Oniguruma WASM to avoid a second wasm asset and its loader                                    |
| `@shikijs/langs`                      | 4.4.1   | TextMate grammars; 31 languages imported explicitly. Must move in lockstep with the two rows above                                           |
| `@sanity/diff-match-patch`            | 3.2.0   | Character-level diff behind the edit-history highlights. Apache-2.0, no dependencies                                                         |
| `luxon`                               | 3.7.2   | Date and time arithmetic, including the day-separator rollover                                                                               |
| `@ctrl/ngx-emoji-mart`                | 9.3.0   | Emoji picker for the composer and reactions, reached only through `@trinity/components/controls`                                             |
| `@capacitor/core`                     | 8.5.0   | Capacitor 8. `@capacitor/android` and `@capacitor/ios` track it exactly                                                                      |
| `@capacitor/app`                      | 8.1.1   | App URL-open events; the native deep-link callback for SSO and OIDC                                                                          |
| `@capacitor/browser`                  | 8.0.4   | System browser for native sign-in, which keeps the app WebView alive                                                                         |
| `@capacitor/camera`                   | 8.2.2   | Native photo and gallery picker, with a web `<input>` fallback                                                                               |
| `@capacitor/filesystem`               | 8.1.2   | Writes a downloaded attachment to cache before handing it to the share sheet                                                                 |
| `@capacitor/share`                    | 8.0.1   | Native save and share sheet, with a web `<a download>` fallback                                                                              |
| `@capacitor/status-bar`               | 8.0.3   | Matches the native status bar to the light or dark theme                                                                                     |
| `@capacitor/preferences`              | 8.0.1   | Device-local settings, including the push gateway override                                                                                   |
| `@capacitor/push-notifications`       | 8.1.2   | FCM and APNs device token for the Matrix pusher, see [push notifications](push-notifications.md)                                             |
| `@capacitor/local-notifications`      | 8.3.1   | Native presentation and typed activation for live-sync notification intents on iOS and Android                                               |
| `@capawesome/capacitor-badge`         | 8.0.2   | Native launcher badge on iOS and Android                                                                                                     |
| `@aparajita/capacitor-secure-storage` | 8.0.0   | Keychain and Keystore for the access token on native                                                                                         |

Attachment encryption is implemented in `attachment-crypto.ts` in `@trinity/util/matrix`.

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
| `@playwright/test`              | 1.62.1  | Browser journeys, host and protocol suites; standalone `playwright` tracks it                       |
| `eslint`                        | 10.8.0  | Flat config in `eslint.config.mjs`                                                                  |
| `typescript-eslint`             | 8.65.0  | Supplies the type-aware `no-deprecated` rule                                                        |
| `angular-eslint`                | 22.1.0  | Template and component rules, including the `trn` selector prefix                                   |
| `prettier`                      | 3.9.6   | `singleQuote`; Angular parser for `*.page.html`; Tailwind class sort                                |
| `stylelint`                     | 17.14.1 | SCSS and CSS lint, run separately from `pnpm lint`                                                  |
| `@commitlint/cli`               | 21.2.1  | `commit-msg` hook enforcing Conventional Commits                                                    |
| `husky`                         | 9.1.7   | Installs the `pre-commit` and `commit-msg` hooks                                                    |
| `lint-staged`                   | 17.3.0  | ESLint plus Prettier over staged files                                                              |

### Desktop shell

The Electron shell has a separate manifest, lockfile and dependency installation. These
are its **declared pins** in `electron/package.json`; the root version guard does not
verify the installed Electron dependency tree. Run the shell's typecheck and relevant
host checks after updating it.

| Package            | Version | Notes                                                                  |
| ------------------ | ------- | ---------------------------------------------------------------------- |
| `electron`         | 43.2.0  | Declared in `electron/package.json`                                    |
| `electron-builder` | 26.15.7 | Packaging: macOS dmg and zip, Linux AppImage and deb, Windows nsis     |
| `typescript`       | 6.0.3   | Same exact version as the root workspace, kept in lockstep by Renovate |

See [the desktop platform page](../platforms/desktop.md) for what that shell does.

## Integration notes

### The crypto WASM needs an explicit URL

The renderer build copies `matrix_sdk_crypto_wasm_bg.wasm` into `assets/crypto/`.
[`crypto-wasm-loader.ts`](../../libs/util/matrix/src/lib/crypto-wasm-loader.ts) resolves
that URL against `document.baseURI` and memoizes `initAsync` through a shared Observable.
It must complete before `initRustCrypto()`: the SDK's default bundle-relative asset path
is not emitted by Angular. Verify the asset in the built host output after changing the
SDK, build assets or host copy step. See
[Matrix and encryption](../architecture/matrix-and-encryption.md).

### Crypto types are deep imports

Existing SDK adapters import crypto and secret-storage APIs from
`matrix-js-sdk/lib/crypto-api` and `matrix-js-sdk/lib/secret-storage`. Check these paths
against the installed SDK on upgrades; a new package export map can restrict them.
Keep SDK imports inside their owning adapters, behind Trinity's public capability APIs.

### Shiki is pinned exactly, and stays out of the eager bundle

Update the three `@shikijs/*` packages together. The current integration uses the
JavaScript regexp engine and explicitly imported grammars in
[`code-highlight.ts`](../../libs/feature/rooms/src/lib/message-presentation/code-highlight.ts).
The lazy Rooms page registers the synchronous highlighter before Message Presentation
uses it. Preserve that lazy loading boundary and check renderer compatibility and bundle
output when changing engines or grammars; old bundle measurements are not current budgets.

### The web build output goes to www, flat

The renderer's `outputPath` has `base: "www"` and `browser: ""`, putting `index.html`
directly in `www/`. Capacitor's `webDir` and Electron's copy step consume that layout.
The default renderer build is production. For development output use the explicit
`trinity:build:development` target; inspect a host target's resolved dependencies before
assuming a configuration flag changes its renderer build. See the
[command reference](../contributing/commands.md).

### Angular framework and CLI versions differ on purpose

Framework packages are on 22.1.0; the builder and CLI are on 22.1.2. Treat the installed
peer requirements and tested package groups as the compatibility constraints, rather than
requiring every Angular-related package to share an identical patch number.

### Vitest runs in the forks pool

[`vite.base.config.ts`](../../vite.base.config.ts) explicitly selects `forks` for Angular
unit suites. Preserve worker isolation and investigate resource failures using measured
process evidence. Shared config changes affect many projects; a single passing spec does
not establish whole-suite reliability. See [testing](../contributing/testing.md).

### Testing Library is wrapped

Import `render` from `@trinity/testing`. Its zoneless wrapper applies `inputs` and `on`
before first change detection; bypassing it can leave required inputs unset. Unit tests
still do not typecheck specs or prove browser layout. The separate checks are documented
in [testing](../contributing/testing.md).

### pnpm 11 build scripts are strict

[`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) owns the explicit `allowBuilds` map.
It permits six dependency build scripts and blocks `less`. The standalone Electron
workspace separately blocks `electron-winstaller`. If installation reports an unreviewed
build script, inspect that dependency and the appropriate workspace policy before changing
it; do not broadly enable scripts to get a green install.

Both workspace policies also set `minimumReleaseAge`. Keep the root's
`matrix-widget-api@1.17.0` patch wired to its matching dependency version and inspect its
continued necessity during upgrades. Update the appropriate lockfile with the pinned pnpm
and review generated/native changes. Release ownership is described in
[maintainer guidance](../maintaining/index.md).

## Version-specific traps

| Change                     | Required follow-through                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript or Nx migration | Inspect `electron/tsconfig.json`: the shell uses the Node16 `module` and `moduleResolution` pair. Run `pnpm electron:typecheck`.                     |
| Playwright update          | Refresh the matching browser downloads with `pnpm exec playwright install chromium webkit`; execute the relevant suite.                              |
| Capacitor update           | Re-sync each supported native project and review generated paths; use the platform prerequisites in [mobile](../platforms/mobile.md).                |
| Matrix SDK update          | Compare upstream `resetEncryption` with Trinity's owned recovery-reset sequence; recheck crypto assets, API imports and recovery contracts.          |
| Angular update             | Check compiler TypeScript peers, builder browser support and renderer compilation together. A successful install alone does not prove compatibility. |

## Related pages

- [Getting started](../contributing/getting-started.md) — prepare a checkout
- [Commands](../contributing/commands.md) — canonical invocations and target ownership
- [Troubleshooting](troubleshooting.md) — diagnose installation and validation failures
- [Architecture overview](../architecture/index.md) — capability and library boundaries
