---
title: Install Trinity
description: Install Trinity on macOS, Windows or Linux, or self-host the web app.
audience: user
contentChannel: release
productVersion: '0.4.0' # x-release-please-version
canonicalTopic: user-home
pageType: how-to
platforms: [web, desktop]
---

<!-- x-release-please-start-version -->

Trinity is an end-to-end encrypted [Matrix](https://matrix.org) client. Release 0.4.0 is
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
sudo apt install ./trinity-desktop_0.4.0_amd64.deb
```

With the AppImage:

```bash
chmod +x Trinity-0.4.0.AppImage
./Trinity-0.4.0.AppImage
```

## Try Trinity Next {#trinity-next}

Trinity Next is the prerelease of the desktop app, for trying what comes next. It installs
beside Trinity as a separate app with its own icon and data, so both can run at once. It
does not share Trinity's sign-in: sign in to it as a new device.

Install it from a `-next` prerelease on
[the releases page](https://github.com/quwisky/trinity-matrix-client/releases), or on macOS
with Homebrew:

```bash
brew install --cask quwisky/trinity/trinity@next
```

On Debian and Ubuntu, the prerelease's `.deb` installs the package `trinity-next`, so it
does not replace `trinity-desktop`.

Prereleases published before Trinity Next installed as "Trinity". With Homebrew,
`brew upgrade` replaces that app with Trinity Next. If you installed it by hand and don't
use stable Trinity, remove it.

## Web {#web}

Run the web app on your own server from the container image:

```bash
docker run -d -p 8080:8080 ghcr.io/quwisky/trinity-web:latest
```

Then open `http://localhost:8080`. You can also serve the static files from
`Trinity-Web-0.4.0.zip` with any web server. For HTTPS, headers and updates, see
[Self-host a release](/trinity-matrix-client/developers/platforms/web-and-pwa/#self-host-release)
in the developer guide.

### Use one tab at a time {#one-tab}

In a browser, Trinity runs in one tab at a time so your encrypted messages stay readable. If you
open it in another tab, that tab shows "Trinity is open in another tab". Choose **Use here** to
move Trinity to it, or close the first tab and the waiting tab starts by itself. A message that
is still sending gets up to five seconds to finish before Trinity moves; if it hasn't reached
your server by then, its text goes back into the message box of its room or thread in the new
tab, ready to send again. A file that was still uploading isn't sent, so attach it again.

The web app needs a secure connection: HTTPS, or `localhost`. Opened over plain HTTP on another
address, it shows "Trinity needs a secure connection" and doesn't start.

The desktop app always runs in one window, so this doesn't apply to it.

## Get help {#get-help}

Report problems on [GitHub Issues](https://github.com/quwisky/trinity-matrix-client/issues).

<!-- x-release-please-end -->

## Server requirements {#server-requirements}

From Trinity 0.3, signing in through your server's own sign-in page (OAuth 2.0,
also called next-generation authentication) needs Synapse 1.138 or newer when the
server uses Matrix Authentication Service (MAS). Tuwunel 1.6 or newer and
Continuwuity 26.6 or newer provide OAuth 2.0 sign-in themselves; older releases do
not. On an older Synapse with MAS, Trinity cannot offer that sign-in page, and an
account that is already signed in stops connecting the next time its access token
expires. Trinity keeps the account and its encryption keys on the device. Before you
update, turn on key backup, or ask your server's admin to upgrade Synapse first. If an
account has already stopped connecting, export your room keys, then remove the account
and sign in again.
