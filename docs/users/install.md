# Installing Trinity

Trinity is at version 0.1.0. There are no published releases and no hosted deployment, so
getting Trinity on any platform today means building it from source. The release pipeline
exists and works, but it is tag-gated and it leaves every release a draft; nothing has been
tagged yet.

Everything below assumes you have the workspace toolchain installed: Node 24.15 or newer
and pnpm 11, both pinned by the repository. The setup is walked through properly in
[Getting started](../contributing/getting-started.md).

```bash
git clone https://github.com/quwisky/trinity-matrix-client.git
cd trinity-matrix-client
corepack enable
pnpm install
```

!!! note "Node 25 is excluded on purpose"

    The `engines` field is `^24.15.0 || >=26.0.0`. That window is Angular 22's own
    supported-runtime policy, not a Trinity preference.

## Web

`pnpm build` produces a production web build in the repository's root `www/` directory. It
is a static bundle: serve the directory with any web server that can fall back to
`index.html` for unknown paths, since Trinity uses client-side routing.

The production web build registers an Angular service worker that prefetches the
application shell, the assets and the crypto WebAssembly module, so the app keeps working
after the first load without a network. The service worker is registered only for the
production web build. Native and desktop builds already carry those files locally and must
not layer a second cache over them.

The build ships a web app manifest (`manifest.webmanifest`, precached with the shell), so
a supporting browser offers an "Install app" prompt and the installed app opens in a
standalone window with the brand colour. The maskable icon is the plated SVG; browsers
that ignore SVG icons fall back to the 192/512 PNGs. On iOS, "Add to Home Screen" uses
the `apple-touch-icon` and `mobile-web-app-capable` in the page head instead — Safari
reads neither the manifest's icons nor its display mode.

Trinity is compiled for these browser floors, taken directly from Angular 22's support
policy:

| Browser               | Minimum |
| --------------------- | ------- |
| Chrome and Edge       | 119     |
| Chrome for Android    | 119     |
| Firefox               | 119     |
| Firefox for Android   | 119     |
| Safari and iOS Safari | 17      |

Anything older is outside the compiled output's target set and is not expected to work.

For what the web target does and does not get, see [Web](../platforms/web.md).

## Desktop

The desktop app is a hand-rolled Electron shell in `electron/`, with its own
`package.json` and its own dependency tree. It serves the same `www/` bundle over a
privileged internal `trinity://` scheme.

Electron stopped shipping a postinstall script in version 42, so `pnpm install` does not
download the Electron binary. Fetch it once, explicitly:

```bash
pnpm electron:install
```

That extracts roughly 313 MB into `electron/node_modules/electron/dist`. It is a one-time
cost; the script skips itself when the binary is already present and matches.

To run the shell against a fresh build:

```bash
pnpm electron:start
```

To produce an installable artifact:

```bash
pnpm electron:package          # host OS
pnpm electron:package:mac
pnpm electron:package:linux
pnpm electron:package:win
pnpm electron:package:all
```

Output lands in `electron/release/`. Each target produces:

| Platform | Artifacts             | Notes                                                                      |
| -------- | --------------------- | -------------------------------------------------------------------------- |
| macOS    | `.dmg` and `.zip`     | Hardened runtime enabled, with entitlements for the V8 and crypto WASM JIT |
| Linux    | AppImage and `.deb`   | Category `Network`                                                         |
| Windows  | NSIS installer `.exe` | Not one-click, per-user, and the install directory can be changed          |

The packaged app registers `eu.qwky.trinity` as an OS-level protocol handler. That is what
carries an SSO or OIDC sign-in redirect back into the running app; it is a different thing
from the internal `trinity://` scheme used to serve the bundle.

### What signing means for you today

macOS signing and notarization are fully wired and completely inert without credentials.
`pnpm electron:package:mac` deliberately disables certificate auto-discovery and produces a
locally signed development build; the notarization hook logs a line and does nothing when
no credentials are present. A build made that way is not something Gatekeeper will trust on
another machine, and macOS will not deliver the app's own notifications from it — that
requires a signed and notarized app. `pnpm electron:package:mac:signed` is the path that
uses a Developer ID certificate when one is available.

Windows code signing is not configured. A packaged `.exe` built today is unsigned, so
SmartScreen will warn about it.

Auto-update is not wired either: the `publish` block in the builder config is commented
out, and there is no updater in the main process. A new desktop version means installing a
new artifact.

Packaging does harden the binary in one way that has nothing to do with certificates.
Before signing, three Electron fuses are switched off — `RunAsNode`,
`EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` — so a local
process cannot relaunch the Trinity binary as a plain Node process and run its own code
inside the main process, which is the process holding OS-keychain access to your Matrix
tokens and cross-signing keys.

The full picture, including how the shell stores secrets and what it refuses to store, is
in [Desktop](../platforms/desktop.md).

## Android

Android needs `ANDROID_HOME` set and the Android SDK installed. Every Android script
rebuilds the web bundle and runs `cap sync` first, so you never ship a stale `www/`.

```bash
pnpm android:run             # build, sync, launch on a device or emulator
pnpm android:open            # open the project in Android Studio
pnpm android:build           # debug APK
pnpm android:build:release   # release AAB, needs a signing keystore
```

The debug APK is written to `android/app/build/outputs/apk/debug/`.

The application id is `eu.qwky.trinity`. The project declares `minSdkVersion` 24 and
compiles against SDK 36. Note that the browser floor above still applies inside the app:
Trinity runs in the Android System WebView, so the device needs a WebView at Chrome 111 or
newer regardless of what the Android version alone allows.

## iOS

iOS needs macOS with Xcode, and a signing identity for anything you intend to install on a
device.

```bash
pnpm ios:run     # build, sync, launch on a simulator or device
pnpm ios:open    # open the project in Xcode
pnpm ios:build   # cap build ios --scheme App
```

Dependencies are managed with Swift Package Manager rather than CocoaPods. The Xcode
project declares a deployment target of iOS 15, but the practical floor is iOS 16.4,
because that is where the compiled web bundle's Safari target starts. The bundle
identifier is `eu.qwky.trinity`, and `Info.plist` registers the same URL scheme used for
sign-in redirects.

Both mobile targets are covered in more depth in [Mobile](../platforms/mobile.md).

## How releases are meant to work

Pushing a `vX.Y.Z` tag triggers the release workflow. It first verifies that the tagged
commit is an ancestor of `develop` or `master` and that the tag matches the version in both
`package.json` and `electron/package.json`, then runs the full lint, test and build gate —
a tag does not trigger the ordinary CI workflow, so this is the only gate on a release. It
then packages on three runners: Linux for AppImage and deb, macOS for dmg and zip on arm64
only, Windows for the NSIS installer. The resulting GitHub release is always left as a
draft.

Pre-release tags are deliberately not matched. See
[CI and releases](../contributing/ci-and-releases.md).
