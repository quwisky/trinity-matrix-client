# Trinity

[![CI](https://github.com/quwisky/trinity-matrix-client/actions/workflows/ci.yml/badge.svg)](https://github.com/quwisky/trinity-matrix-client/actions/workflows/ci.yml)

Trinity is an end-to-end encrypted [Matrix](https://matrix.org) client for Web/PWA,
Android, iOS, and Electron desktop. One Angular application supplies the shared
renderer; host capabilities handle platform-specific behavior.

The desktop app is available from
[the latest release](https://github.com/quwisky/trinity-matrix-client/releases/latest);
the web (PWA), Android and iOS apps are still in development. The
[user guide](https://quwisky.github.io/trinity-matrix-client/users/) is a
work-in-progress notice for now. The
[developer guide](https://quwisky.github.io/trinity-matrix-client/developers/) follows
the `develop` branch and documents the current source tree.

## Install

### macOS

Apple Silicon, macOS 13 or later. With [Homebrew](https://brew.sh):

```bash
brew install --cask quwisky/trinity/trinity
```

Or download the `.dmg` from
[the latest release](https://github.com/quwisky/trinity-matrix-client/releases/latest).
The app is signed and notarized by Apple.

### Windows

Download the `.exe` installer from
[the latest release](https://github.com/quwisky/trinity-matrix-client/releases/latest).
The installer is not code-signed yet, so Windows SmartScreen shows "Windows protected
your PC" the first time: choose **More info**, then **Run anyway**.

### Linux

Download the AppImage or the `.deb` from
[the latest release](https://github.com/quwisky/trinity-matrix-client/releases/latest):

```bash
chmod +x Trinity-*.AppImage && ./Trinity-*.AppImage   # AppImage
sudo apt install ./<downloaded-file>.deb              # Debian and Ubuntu
```

### Prereleases

`-next` builds are published on the
[releases page](https://github.com/quwisky/trinity-matrix-client/releases) as
pre-releases, for testing. On macOS:
`brew install --cask quwisky/trinity/trinity@next` (it replaces the stable app; only
one can be installed).

### Web, Android and iOS

🚧 In development. Build them from source with the developer guide:
[web and PWA](https://quwisky.github.io/trinity-matrix-client/developers/platforms/web-and-pwa/),
[Android](https://quwisky.github.io/trinity-matrix-client/developers/platforms/android/),
[iOS](https://quwisky.github.io/trinity-matrix-client/developers/platforms/ios/).

## How Trinity compares

| Platforms               | Trinity  | Element Web/Desktop | Element X | FluffyChat | Cinny |
| ----------------------- | -------- | ------------------- | --------- | ---------- | ----- |
| Web                     | 🚧 (PWA) | ✅                  | —         | ✅         | ✅    |
| Windows / macOS / Linux | ✅       | ✅                  | —         | Linux      | ✅    |
| Android / iOS           | 🚧       | —                   | ✅        | ✅         | —     |

| Features                      | Trinity           | Element Web/Desktop | Element X | FluffyChat | Cinny |
| ----------------------------- | ----------------- | ------------------- | --------- | ---------- | ----- |
| End-to-end encryption         | ✅                | ✅                  | ✅        | ✅         | ✅    |
| Spaces                        | ✅                | ✅                  | ✅        | ✅         | ✅    |
| Threads                       | ✅                | ✅                  | 🟡        | ✅         | ❌    |
| Multiple accounts             | ✅                | ❌                  | ❌        | ✅         | ❌    |
| OAuth 2.0 (next-gen auth)     | ✅                | ✅                  | ✅        | ❔         | ❔    |
| Legacy SSO                    | ✅                | ✅                  | ❌        | ✅         | ✅    |
| Emoji and image packs         | ✅                | 🟡                  | ❔        | 🟡         | 🟡    |
| Voice/video calls (1:1)       | ❌                | ✅                  | ❌        | ❌         | ❌    |
| Voice/video calls (Jitsi)     | ❌                | ✅                  | ❌        | ❌         | ❌    |
| Voice/video calls (MatrixRTC) | ❌                | ✅                  | ✅        | ❔         | ✅    |
| Multi-language interface      | ❌ (English only) | ✅                  | ✅        | ✅         | ❌    |

✅ supported · 🟡 partial · ❌ not supported · ❔ unknown · 🚧 in development

Also in Trinity: polls, voice messages, location sharing, stickers and GIFs, jump to
date, pinned messages, room key export and import, and desktop and push
notifications.

Other clients: [matrix.org client pages](https://matrix.org/ecosystem/clients/),
retrieved 2026-10-02. Trinity: this repository.

## Run from source

Use Node `^24.15.0` and the pnpm version pinned in `package.json`:

```bash
corepack enable
pnpm install
pnpm start
```

Open `http://localhost:4200`. For prerequisites, repository orientation, platform
setup, commands, testing, architecture, and contribution policy, use the
[developer guide](https://quwisky.github.io/trinity-matrix-client/developers/).
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
