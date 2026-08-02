# Getting started

This page takes a fresh clone to a running web dev server, then covers the extra
one-time setup for the desktop shell, the native platforms, and the end-to-end
harnesses. Once you are running, [Commands](commands.md) is the full reference.

## Prerequisites

| Tool   | Required version         | Where it is pinned                                                       |
| ------ | ------------------------ | ------------------------------------------------------------------------ |
| Node   | `^24.15.0 \|\| >=26.0.0` | `engines` in `package.json`; `.nvmrc` pins `24.15.0`; CI runs Node 24    |
| pnpm   | `>=11`                   | `packageManager: "pnpm@11.15.1"` in `package.json`, enforced by corepack |
| Docker | Any recent version       | Only needed for the Synapse-backed end-to-end suites                     |

### Why Node 25 is excluded

The range has a hole in it on purpose. Angular 22 declares its own supported Node
window as `^22.22.3 || ^24.15.0 || >=26.0.0` — odd-numbered Node majors never
become LTS, so Angular does not support them, and a build on Node 25 warns or
fails from inside the Angular CLI rather than from anything in this repo. Trinity
narrows Angular's window further by dropping the 22.x leg, so the floor is 24.15.0.

If you use a version manager, `.nvmrc` gives you the exact version CI develops
against.

### This project is pnpm-only

A `preinstall` script in `package.json` aborts any install that is not pnpm:

```bash
node -e "if (!String(process.env.npm_config_user_agent).startsWith('pnpm')) { console.error('Use pnpm for this project — run: corepack enable && pnpm install'); process.exit(1); }"
```

It inspects `npm_config_user_agent`, which every package manager sets to identify
itself, so `npm install` and `yarn install` stop with that message instead of
producing a second, divergent dependency tree. Two other guards back it up: the
`packageManager` field, which corepack enforces, and `.gitignore`, which refuses
`package-lock.json` and `yarn.lock` by name.

## Install

```bash
corepack enable    # once per machine; picks up the pinned pnpm version
pnpm install
```

Two pnpm 11 behaviours are worth knowing before the first install:

- **Dependency build scripts are an explicit allowlist.** `pnpm-workspace.yaml`
  carries an `allowBuilds` map, and `strictDepBuilds` now defaults to true, so a
  dependency with an install script that is neither allowed nor blocked _fails_
  the install rather than being silently skipped. Six packages are allowed
  (`@parcel/watcher`, `@swc/core`, `esbuild`, `lmdb`, `msgpackr-extract`, `nx`)
  and `less` is explicitly blocked, because it arrives as a transitive
  build-script dependency and strict mode demands an answer either way. Adding a
  dependency that wants to run a build script means adding it to that map.
- **Fresh releases are quarantined.** `minimumReleaseAge: 1440` (pnpm counts
  minutes) makes a version published in the last 24 hours un-installable. If
  `pnpm add` refuses a version that plainly exists on the registry, this is why.

`pnpm install` also runs `husky`, which activates the `pre-commit` and
`commit-msg` hooks.

The root `pnpm-workspace.yaml` declares `packages: []`. That is deliberate, not an
oversight: this is an Nx integrated monorepo, so `libs/*` are consumed through
TypeScript path aliases rather than pnpm links, and declaring the root explicitly
stops pnpm walking up into a parent directory. `electron/` is intentionally not a
workspace member; it has its own dependency tree and its own lockfile.

## Run the web app

```bash
pnpm start
```

That is `nx serve trinity`, on `http://localhost:4200`. An unauthenticated load
redirects to `/login`; enter a homeserver such as `matrix.org` to discover its
login flows and sign in with a real account.

`pnpm build` produces the production bundle into a root `www/` directory rather
than `dist/`, flat, with `index.html` at the top level. Capacitor's `webDir` and
the Electron shell's copy step both read that exact path. See
[Architecture](../architecture/index.md) for why the output shape matters.

!!! warning "Stop the dev server before running the web end-to-end suite"

    The Playwright web config uses `reuseExistingServer` outside CI and points at
    `http://localhost:4200` — the same port `pnpm start` uses. If anything is
    already answering on 4200, Playwright skips its own `webServer` command
    entirely, so `nx run trinity:build:development` never runs and `www/` is never
    refreshed. The suite then passes or fails against whatever your dev server
    happens to be serving, including uncommitted hot-reloaded changes.

## Extra setup for the desktop shell

The Electron shell lives in `electron/` with its own `package.json`, its own
lockfile, and its own TypeScript version (5.9, against the root's 6.x). It is not
installed by the root `pnpm install`.

```bash
pnpm electron:install    # installs electron/ deps and downloads the Electron binary
pnpm electron:start      # build the web bundle, compile the shell, launch it
```

The binary download is a separate step because Electron dropped its `postinstall`
script in v42 — the package now fetches its binary lazily, the first time
`require('electron')` resolves a path. That is too late here: the macOS dev-signing
step codesigns `node_modules/electron/dist/Electron.app` before anything requires
the package, so a first `pnpm electron:start` after a clone would fail on a missing
app. `electron:install` therefore drives the package's own installer directly.
Budget roughly 300 MB unpacked under `electron/node_modules/electron/dist`.

Calling it a one-time step is a simplification: `electron:start`,
`electron:e2e` and every `electron:package:*` script re-run `electron:install`
themselves. That is cheap, because the script self-skips when the unpacked version
stamp already matches the installed package. Running it on its own is only useful
to pre-warm the download before your first build.

On headless Linux, wrap the Electron end-to-end run in a virtual display:
`xvfb-run -a pnpm electron:e2e`. Electron needs an X server even when nothing is
visible, and without one Playwright's launch times out with no useful message.

## Extra setup for iOS and Android

Both native projects are checked into the repository, so there is no `cap add`
step. What you need is the platform toolchain:

- **Android** — the Android SDK, most easily via Android Studio. Export
  `ANDROID_HOME` (for example `$HOME/Library/Android/sdk`) and make sure
  `android/local.properties` points `sdk.dir` at the same place. That file is
  generated per machine and is not tracked.
- **iOS** — macOS with Xcode installed _and selected_:
  `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`. Capacitor 8
  uses Swift Package Manager, so CocoaPods is not involved.

Every `pnpm android:*` and `pnpm ios:*` script runs a production web build and
`cap sync` before doing anything else, so a web change is always picked up.

!!! warning "Re-sync the native projects after any Capacitor version bump"

    `cap sync` writes plugin paths into `android/capacitor.settings.gradle` and
    `ios/App/CapApp-SPM/Package.swift`, and under pnpm those paths embed the exact
    resolved version and its peer hash, for example
    `node_modules/.pnpm/@capacitor+android@8.4.1_@capacitor+core@8.4.1/…`. Bump a
    Capacitor package without re-syncing and the build fails with a "no such file
    or directory" pointing at a path that no longer exists. Run `pnpm android:sync`
    or `pnpm ios:sync` and commit the regenerated files. Renovate's `ignorePaths`
    covers `android/**` and `ios/**`, so its dependency PRs will never do this
    for you.

## Extra setup for the test harnesses

Unit tests need nothing beyond `pnpm install`. The browser-driven suites need
Playwright's browser binaries:

```bash
pnpm exec playwright install chromium webkit
```

WebKit is only used by `pnpm spike:webkit`; everything else is Chromium.

This is not a once-per-clone step. Each Playwright release pins its own browser
build, so after every Playwright version bump the old binaries no longer match and
every browser test fails at launch with `Executable doesn't exist at
.../chromium_headless_shell-<n>` — which reads like a catastrophic regression
rather than a missing download. Re-run the install after the bump.

The Synapse-backed suites additionally need Docker running. They stand up a
disposable Synapse, Caddy and Dex stack themselves; there is nothing to configure.
Without Docker, the web Playwright suite records the homeserver as unavailable and
the authenticated specs skip themselves rather than fail.

## Verify the setup

```bash
pnpm lint
pnpm test
pnpm build
```

`pnpm build` is not redundant with `pnpm test`. The production build runs the
Angular AOT compiler, which rejects template type errors that Vitest never sees,
because Vitest transpiles through esbuild without type-checking.

Check the **exit code** rather than skimming the output. Nx and esbuild print
failures as `✘ [ERROR]` and `Failed tasks`, so a grep for the word "error" matches
neither.

If something fails here rather than later, [Troubleshooting](../reference/troubleshooting.md)
covers the known first-run failures.
