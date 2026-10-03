---
title: Install Trinity
description: Install Trinity on macOS, Windows or Linux, or self-host the web app.
audience: user
contentChannel: release
productVersion: '0.1.0' # x-release-please-version
canonicalTopic: user-home
pageType: how-to
platforms: [web, desktop]
---

<!-- x-release-please-start-version -->

Trinity is an end-to-end encrypted [Matrix](https://matrix.org) client. Release 0.1.0 is
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

```bash
sudo apt install ./trinity-desktop_0.1.0_amd64.deb             # Debian and Ubuntu
chmod +x Trinity-0.1.0.AppImage                               # AppImage
./Trinity-0.1.0.AppImage
```

## Web {#web}

Run the web app on your own server from the container image:

```bash
docker run -d -p 8080:8080 ghcr.io/quwisky/trinity-web:latest
```

Then open `http://localhost:8080`. You can also serve the static files from
`Trinity-Web-0.1.0.zip` with any web server. For HTTPS, headers and updates, see
[Self-host a release](/trinity-matrix-client/developers/platforms/web-and-pwa/#self-host-release)
in the developer guide.

## Get help {#get-help}

Report problems on [GitHub Issues](https://github.com/quwisky/trinity-matrix-client/issues).

<!-- x-release-please-end -->
