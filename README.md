# Trinity

[![CI](https://github.com/quwisky/trinity-matrix-client/actions/workflows/ci.yml/badge.svg)](https://github.com/quwisky/trinity-matrix-client/actions/workflows/ci.yml)

Trinity is an end-to-end encrypted [Matrix](https://matrix.org) client for Web/PWA,
Android, iOS, and Electron desktop. One Angular application supplies the shared
renderer; host capabilities handle platform-specific behavior.

The desktop app and the self-hostable web app (PWA) are available from
[the latest release](https://github.com/quwisky/trinity-matrix-client/releases/latest);
the Android and iOS apps are still in development. The
[user guide](https://docs.trinityproject.dev/trinity-matrix-client/users/) covers installing
the latest release. The
[developer guide](https://docs.trinityproject.dev/trinity-matrix-client/developers/) follows
the `main` branch and documents the current source tree.

## Install

### macOS

Apple Silicon, macOS 13 or later. With [Homebrew](https://brew.sh):

```bash
brew install --cask quwisky/trinity/trinity
```

Or download the `.dmg` from
[the latest release](https://github.com/quwisky/trinity-matrix-client/releases/latest).
Signed with a Developer ID and notarized by Apple.

### Windows

Download the `.exe` installer from
[the latest release](https://github.com/quwisky/trinity-matrix-client/releases/latest).
The installer is not code-signed yet, so Windows SmartScreen shows "Windows protected
your PC" when you run each new version's installer: choose **More info**, then
**Run anyway**.

### Linux

x86-64 only. Download the `.deb` or the AppImage from
[the latest release](https://github.com/quwisky/trinity-matrix-client/releases/latest).
On Debian and Ubuntu, prefer the `.deb`: AppImages need `libfuse2`, and recent Ubuntu
releases restrict the sandbox they rely on.

From the folder you downloaded to, replacing `<version>` with the release you
downloaded:

```bash
sudo apt install ./<downloaded-file>.deb                                # Debian and Ubuntu
chmod +x Trinity-<version>.AppImage && ./Trinity-<version>.AppImage    # AppImage
```

### Prereleases

`-next` builds are published on the
[releases page](https://github.com/quwisky/trinity-matrix-client/releases) as
pre-releases, for testing. From the first prerelease that includes Trinity Next (0.5.0-next.0
and earlier do not), they install on the desktop as a separate app, **Trinity Next**,
beside Trinity: it has its own icon, data and sign-in, so sign in to it as a new device.
On macOS: `brew install --cask quwisky/trinity/trinity@next`. On Linux the `.deb` keeps
its `trinity-desktop_<version>_amd64.deb` file name but installs the package
`trinity-next`.

Earlier prereleases installed as "Trinity". With Homebrew, `brew upgrade` replaces that
app with Trinity Next. If you installed it by hand and don't use stable Trinity, remove it.

### Web

Self-host the web app from the release image, `docker run -d -p 8080:8080 ghcr.io/quwisky/trinity-web:latest`
(`:next` for prereleases),
or from the `Trinity-Web-X.Y.Z.zip` attached to each
[release](https://github.com/quwisky/trinity-matrix-client/releases). See
[Self-host a release](https://docs.trinityproject.dev/trinity-matrix-client/developers/platforms/web-and-pwa/#self-host-release).

### Android and iOS

🚧 In development. Build them from source with the developer guide:
[Android](https://docs.trinityproject.dev/trinity-matrix-client/developers/platforms/android/),
[iOS](https://docs.trinityproject.dev/trinity-matrix-client/developers/platforms/ios/).

## How Trinity compares

| Platforms | Trinity            | Element Web/Desktop | Element X | FluffyChat | Cinny |
| --------- | ------------------ | ------------------- | --------- | ---------- | ----- |
| Web       | ✅ (PWA)           | ✅                  | —         | ✅         | ✅    |
| Windows   | ✅                 | ✅                  | —         | ✅         | ✅    |
| macOS     | ✅ (Apple Silicon) | ✅                  | —         | —          | ✅    |
| Linux     | ✅ (x86-64)        | ✅                  | —         | ✅         | ✅    |
| Android   | 🚧                 | —                   | ✅        | ✅         | —     |
| iOS       | 🚧                 | —                   | ✅        | ✅         | —     |

| Features                          | Trinity           | Element Web/Desktop | Element X | FluffyChat | Cinny |
| --------------------------------- | ----------------- | ------------------- | --------- | ---------- | ----- |
| End-to-end encryption             | ✅                | ✅                  | ✅        | ✅         | ✅    |
| Spaces                            | ✅                | ✅                  | ✅        | ✅         | ✅    |
| Threads                           | ✅                | ✅                  | 🟡        | ✅         | 🟡    |
| Multiple accounts                 | ✅                | ❌                  | ❌        | ✅         | ❌    |
| OAuth 2.0 (next-gen auth)         | ✅                | ✅                  | ✅        | ✅         | ❌    |
| Legacy SSO                        | ✅ (not Android)  | ✅                  | ❌        | ✅         | ✅    |
| Emoji and image packs             | ✅                | 🟡                  | ❌        | ✅         | ✅    |
| Voice/video calls (1:1)           | ❌                | ✅                  | ❌        | ❌         | ❌    |
| Voice/video calls (Jitsi)         | ❌                | ✅                  | ❌        | ❌         | ❌    |
| Voice/video calls (MatrixRTC)     | ❌                | ✅                  | ✅        | ✅         | ✅    |
| Invisible cryptography (MSC4153)  | ❌                | 🟡                  | 🟡        | 🟡         | ❌    |
| Simplified sliding sync (MSC4186) | ❌                | 🟡                  | ✅        | ❌         | ❌    |
| Multi-language interface          | ❌ (English only) | ✅                  | ✅        | ✅         | ❌    |

✅ supported · 🟡 partial · ❌ not supported · ❔ unknown · 🚧 in development ·
— not offered by that app. Element X is Element's mobile app, so Element Web/Desktop
shows — for Android and iOS.
From Trinity 0.3, OAuth 2.0 sign-in needs Synapse 1.138 or newer when the server uses
Matrix Authentication Service (MAS). On an older Synapse with MAS, accounts stop
connecting when their access token expires but keep their local encryption keys; see
[Server requirements](https://docs.trinityproject.dev/trinity-matrix-client/users/#server-requirements).

Trinity also supports polls, voice messages, location sharing, stickers, custom emoji
and GIFs, room widgets, jump to date, pinned messages, room key export and import,
desktop notifications, and
[signing in on a new device with a QR code](https://docs.trinityproject.dev/trinity-matrix-client/users/#qr-sign-in)
on servers that support it.

Other clients: each client's GitHub repository (code, changelogs and issues) and its
latest release, with [matrix.org client pages](https://matrix.org/ecosystem/clients/)
for cross-checking, retrieved 2026-10-11. 🟡 marks a feature that is behind a Labs or
developer setting, receive-only, or missing part of its scope. Trinity's column is
self-assessed from this repository against the same feature definitions.

## Run from source

Use the Node.js range in `package.json`'s `engines.node` and the pnpm version pinned in
its `packageManager` field; the
[prerequisites](https://docs.trinityproject.dev/trinity-matrix-client/developers/start/prerequisites/)
page shows both. Then install and start the development server:

```bash
corepack enable
pnpm install
pnpm start
```

Open `http://localhost:4200`. For prerequisites, repository orientation, platform
setup, commands, testing, architecture, and contribution policy, use the
[developer guide](https://docs.trinityproject.dev/trinity-matrix-client/developers/).
Its English source lives in
[`apps/docs-developers/src/content/docs`](apps/docs-developers/src/content/docs).

## Repository layout

- `apps/trinity/` contains the Angular application entrypoint and routes.
- `libs/` contains capabilities, data access, host contracts, and public UI.
- `e2e/` contains browser, component, protocol, and host validation suites.
- `electron/`, `android/`, and `ios/` wrap the shared production `www/` build.
- `apps/docs-users/` and `apps/docs-developers/` contain the two public Starlight sites.
- [`docs-internal`](docs-internal/README.md) contains private maintainer and decision records;
  it is not included in the public documentation build.

## Project status

The project is in early development. A feature's presence does not establish support
or validation on every host or deployment. Use the
[issue tracker](https://github.com/quwisky/trinity-matrix-client/issues) for proposed
work and the developer guide for the current implementation contract.

Offline caches retain local content and the application shell; they do not replace a
homeserver or network access for first-time sign-in.

## License

Trinity is licensed under the [MIT License](LICENSE). Third-party dependencies and
vendored code retain their respective licenses.
