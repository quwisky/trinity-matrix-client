# Desktop

Trinity Desktop wraps the same production Angular renderer used by the web app in a
hand-written Electron shell. The renderer is copied from root `www/` into
`electron/www/`; Electron does not use Capacitor, so
`Capacitor.isNativePlatform()` is false in the shell.

Use this guide to prepare, run, diagnose, verify, and package the desktop host. The
[command reference](../contributing/commands.md#desktop) remains the canonical list, and
[maintainer guidance](../maintaining/index.md) owns release authorization and publication.

## Prepare the shell

The root checkout needs the supported Node and pnpm versions. Electron also has its own
`electron/package.json` and lockfile, so install its dependencies and binary before the
first desktop build:

```bash
pnpm electron:install
```

This target runs the shell's frozen-lockfile installation and downloads the Electron
binary. Re-running it is safe; the binary check skips a matching existing download. On
headless Linux, install a virtual display for launched-shell work:

```bash
xvfb-run -a pnpm electron:start
```

A desktop package or signed macOS artifact additionally needs the matching host OS and
credentials. Those requirements are covered under [Package an artifact](#package-an-artifact).

## Build, run, and debug

Run the normal development shell with:

```bash
pnpm electron:start
```

The resolved `trinity-desktop:start` target builds the production Angular renderer,
ensures the shell binary is present, copies `www/` into `electron/www/`, compiles the
main and preload TypeScript, applies the local `trinity-dev` signature on macOS,
then launches Electron. It does not use a live `pnpm start` dev-server renderer.

On macOS, the normal build/start path requires a code-signing identity named `trinity-dev`
in the local keychain; it fails before launch if that identity is missing. A local launch
without that development-signing step uses the existing release-build path and starts the
compiled shell directly:

```bash
pnpm electron:install
pnpm nx run trinity-desktop:build-release
pnpm -C electron run start
```

This alternative avoids the automatic `sign:dev` dependency. It does not create a signed,
notarized installer or prove macOS notification delivery. Use the separately credentialed
package path for distribution; do not disable OS protections to bypass a signing failure.

For a compile-only check, use `pnpm electron:compile`. For the shell's Node-side checks,
use `pnpm electron:test` and `pnpm electron:typecheck`. The static host contract is:

```bash
pnpm electron:verify
```

This checks configuration, artifacts, bridge, and security contracts. It does not prove
that the actual packaged shell launched. The Docker-free launched-shell smoke is
`pnpm electron:e2e:smoke`; the full `pnpm electron:e2e` uses the disposable Synapse
lifecycle for authenticated flows. Both need the Electron binary, and headless Linux needs
Xvfb. See [Testing](../contributing/testing.md) for what browser and host checks prove.

For renderer debugging, start the shell and choose **View → Toggle Developer Tools**.
Use its Console for renderer errors and Sources for the copied web bundle; use the terminal
that launched Electron for main-process and protocol-registration output. When debugging an
authentication callback, test an unpackaged run with the custom `eu.qwky.trinity:` URL.
Do not start a second shell against the same profile: the main process holds a single-instance
lock and forwards the next activation to the existing window.

## How the desktop host works

### Renderer, scheme, and process boundary

Electron serves the copied renderer from `trinity://app`, not `file://`. The scheme is
registered before Electron becomes ready, is a secure standard origin, supports fetch and
streaming, and serves WebAssembly as `application/wasm`. That enables WebCrypto,
IndexedDB, route reload fallback to `index.html`, and crypto WASM streaming. Paths outside
`electron/www/` are rejected.

The main window uses context isolation, sandboxing, web security, and disabled Node
integration for frames and workers. The renderer cannot use Node or `ipcRenderer`.
`window.open`, navigation away from the app origin, and webviews are denied; external
HTTP(S) links go to the operating-system browser. The permission policy permits Trinity's
main frame to request camera/microphone, geolocation, and sanitized clipboard writes, and
denies other powerful permission requests.

The window hides to the tray on close so Matrix sync and notifications can continue.
Explicit Quit, the application menu, and OS shutdown set the quit state and allow the
window to close. `backgroundThrottling: false` keeps the hidden renderer's Matrix sync
from being throttled; it is not a relaxation of the renderer security boundary.

### The preload bridge and capability fallbacks

The sandboxed preload exposes one typed object, `window.trinityDesktop`. It identifies
Electron and negotiates specific host operations; it never exposes Node or raw IPC. Both
the preload and main process validate payloads, and the main process accepts calls only
from the current Trinity window.

| Capability              | Desktop implementation and limit                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Deep links              | Buffered OS callbacks are replayed to the renderer after it subscribes.                                              |
| Notifications and badge | OS presentation, click destinations, and aggregate unread badges return typed outcomes rather than assuming success. |
| Secret storage          | Electron `safeStorage` is used only when it is real OS encryption.                                                   |
| Homeserver CORS         | The main process repairs missing CORS headers only for renderer-declared homeserver origins.                         |
| Approximate location    | An opt-in, time-bounded IP lookup returns no location on failure; manual entry remains available.                    |
| Updates                 | No update channel is implemented; update capability is unavailable.                                                  |

The typed bridge at
[`libs/platform-native/src/lib/trinity-desktop-bridge.ts`](../../libs/platform-native/src/lib/trinity-desktop-bridge.ts)
is the current operation contract. Add a host capability through that contract, not a
new renderer-to-main escape hatch.

### Deep links, storage, and Matrix connectivity

`trinity://app` is internal to Electron. The operating-system callback scheme is
`eu.qwky.trinity:`, used for SSO and OIDC. The app accepts both
`eu.qwky.trinity://sso-callback` and the authority-less OIDC form
`eu.qwky.trinity:/sso-callback`; matching must be scheme-based. macOS `open-url`,
Windows/Linux command-line activation, and second-instance activation all feed one
buffered delivery path, so a callback that arrives before Angular starts is replayed.

Secrets use Electron `safeStorage` in a mode-0600 file below the user-data directory.
On Linux, Electron's `basic_text` backend is rejected because it is only obfuscation;
the application takes its documented non-secure fallback and reports the limitation rather
than claiming the Matrix token or cross-signing keys are protected.

The renderer is cross-origin to every Matrix homeserver. The CORS adapter alters responses
only for declared signed-in or discovery/login origins, sets the exact `trinity://app`
origin, and leaves undeclared origins untouched. It never enables credentialed CORS.
This permits Matrix bearer-token requests when a homeserver proxy stripped required CORS
headers without turning the shell into a read-anywhere bridge.

## Package an artifact

All package commands start from the copied production renderer and compiled shell. Outputs
are written below `electron/release/`.

| Command                            | Host artifact and prerequisite                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm electron:package`            | Package for the current host                                                           |
| `pnpm electron:package:linux`      | AppImage and deb on a Linux-capable packaging host                                     |
| `pnpm electron:package:win`        | NSIS installer on a Windows-capable packaging host                                     |
| `pnpm electron:package:mac`        | Local unsigned/ad-hoc macOS package                                                    |
| `pnpm electron:package:mac:signed` | Developer ID signed and notarized macOS dmg/zip; credentials required                  |
| `pnpm electron:package:all`        | Request all configured platform targets; only use where host/toolchain support permits |

Electron Builder packages compiled `dist/`, copied `www/`, and the shell manifest into
an ASAR. Source maps do not ship. Tray and unread-overlay images remain real external
resources because native image APIs require files on disk. The packaged binary has fuses
that disable RunAsNode, Node options injection, and Node inspect arguments before signing.

Release packaging deliberately uses `trinity-desktop:build-release`, which avoids the
local `trinity-dev` signature. macOS signing requires a Developer ID identity from the
login keychain or `CSC_LINK`/ `CSC_KEY_PASSWORD`; notarization additionally needs either
App Store Connect API-key credentials or Apple-ID credentials. The signed macOS path is
needed for real OS notification delivery. The local `electron:package:mac` helper has an
arm64 output-path assumption and can fail after packaging on Intel macOS; use the signed
release path or correct the local re-sign path for that host. Windows signing is not
configured, and automatic updates are not implemented. Follow
[CI and releases](../maintaining/ci-and-releases.md) for the authorized signing, tagging,
and publication process; do not treat a locally packaged file as a release.

## How the desktop contract is tested

`pnpm electron:verify` is static evidence. `pnpm electron:e2e:smoke` launches the
shell without Docker; `pnpm electron:e2e` launches it with Synapse-backed authenticated
journeys. Neither proves a signed/notarized macOS delivery unless that exact artifact runs on
the intended host. Record the OS, command, exit status, and unavailable credentials or
display environment with review evidence.
