---
title: Install Trinity
description: Install Trinity on macOS, Windows or Linux, or self-host the web app.
audience: user
contentChannel: release
productVersion: '0.2.0' # x-release-please-version
canonicalTopic: user-home
pageType: how-to
platforms: [web, desktop]
---

<!-- x-release-please-start-version -->

Trinity is an end-to-end encrypted [Matrix](https://matrix.org) client. Release 0.2.0 is
available for macOS, Windows and Linux, and as a self-hostable web app (PWA). Android and
iOS apps are still in development.

Downloads are attached to [the latest release](https://github.com/quwisky/trinity-matrix-client/releases/latest).

## macOS {#macos}

Apple Silicon, macOS 13 or later. With [Homebrew](https://brew.sh):

```bash
brew install --cask quwisky/trinity/trinity
```

Or download the `.dmg` from the latest release. It is signed with a Developer ID and
notarized by Apple.

## Windows {#windows}

Download the `.exe` installer from the latest release. The installer is not code-signed
yet, so Windows SmartScreen shows "Windows protected your PC": choose **More info**, then
**Run anyway**.

## Linux {#linux}

x86-64 only. Download the `.deb` or the AppImage from the latest release. On Debian and
Ubuntu, prefer the `.deb`: AppImages need `libfuse2`, and recent Ubuntu releases restrict
the sandbox they rely on.

On Debian and Ubuntu:

```bash
sudo apt install ./trinity-desktop_0.2.0_amd64.deb
```

With the AppImage:

```bash
chmod +x Trinity-0.2.0.AppImage
./Trinity-0.2.0.AppImage
```

## Web {#web}

Run the web app on your own server from the container image:

```bash
docker run -d -p 8080:8080 ghcr.io/quwisky/trinity-web:latest
```

Then open `http://localhost:8080`. You can also serve the static files from
`Trinity-Web-0.2.0.zip` with any web server. For HTTPS, headers and updates, see
[Self-host a release](/trinity-matrix-client/developers/platforms/web-and-pwa/#self-host-release)
in the developer guide.

## Get help {#get-help}

Report problems on [GitHub Issues](https://github.com/quwisky/trinity-matrix-client/issues).

<!-- x-release-please-end -->

## Server requirements {#server-requirements}

From Trinity 0.3, signing in through your server's own sign-in page (OAuth 2.0,
also called next-generation authentication) needs Synapse 1.138 or newer when the
server uses Matrix Authentication Service (MAS). Tuwunel 1.6 or newer and
Continuwuity 26.6 or newer provide OAuth 2.0 sign-in themselves; older releases do
not. On an older Synapse with MAS, Trinity cannot offer that sign-in page, and an
account that is already signed in is signed out the next time its access token
expires. Signing out like this also deletes that account's encryption keys on the
device, so turn on key backup and save your recovery key before you update, or ask
your server's admin to upgrade Synapse first.
