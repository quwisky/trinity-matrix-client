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

After an update, Trinity shows what changed once, when you sign in (and unlock, if App lock
is on) on the new version. To see it again, open Settings and choose **What's new**.

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

Download it from a release marked **Pre-release** on
[the releases page](https://github.com/quwisky/trinity-matrix-client/releases), and install
it as described above for [macOS](#macos), [Windows](#windows) (including the SmartScreen
prompt) or [Linux](#linux) (`sudo apt install ./<downloaded-file>.deb` on Debian and
Ubuntu). On macOS you can also use Homebrew:

```bash
brew install --cask quwisky/trinity/trinity@next
```

On Debian and Ubuntu, the prerelease's `.deb` installs as a separate package,
`trinity-next`.

Older prereleases installed as "Trinity": you can tell one by its name, Trinity, with a
version ending in `-next.` and a number (for example `0.5.0-next.0`). With Homebrew,
`brew upgrade` replaces that app with Trinity Next. If you installed it by hand and don't
use stable Trinity, remove it. Removing the app doesn't delete its data: that stays in
Trinity's data folder, and a stable Trinity installed later would use it.

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

## Lock Trinity on this device {#app-lock}

App lock hides the desktop or mobile app behind a lock screen until you unlock it. It's a
privacy screen for when someone else uses your computer or phone: it doesn't encrypt Trinity's
data on disk, and it doesn't sign you out. Sync and notifications keep working while Trinity is
locked. App lock isn't available in the web app. Trinity Next has its own App lock, with its
own PIN.

**Turn it on.** Open Settings › Security and turn on **Lock Trinity**. On a Mac with Touch ID,
confirm with Touch ID first; on Windows 11 with Windows Hello set up, confirm with Windows Hello
first. Then choose a Trinity PIN of 4 to 16 digits (6 or more is better) and type it twice.
Every lock has this PIN as a backup. On Linux, on Macs without Touch ID, on Windows 10 and on
Windows without Windows Hello set up, the PIN is the only way to unlock. On Linux, App lock
needs your desktop's keyring (GNOME Keyring or KWallet) to keep the PIN; without one, Settings
says so and App lock can't be turned on. Changing App lock later, or turning it off, asks again
for the way you unlock: the system prompt (Face ID, Touch ID, Windows Hello, your fingerprint or
your phone's passcode) where you have one, or your PIN. One check covers further changes for a
minute while Settings stays open.

**Lock after.** Choose how long Trinity waits after you leave it before it locks:
**Immediately**, **After 1 minute** (the default), 5 minutes, 15 minutes or 1 hour. On a
computer, **Immediately** is 10 seconds after the window loses focus, is minimized or is hidden.
Trinity also locks at once when your computer goes to sleep, and on macOS and Windows when you
lock the screen.

**In the Android and iOS apps (still in development).** Turning App lock on asks for Face ID,
Touch ID or your fingerprint first, or for your passcode on a phone with no face or fingerprint
set up (the prompt also offers your passcode or screen lock); then for a Trinity PIN. If your
phone has no screen lock, the PIN is the only way to unlock; Settings suggests setting one.
**Immediately** locks as soon as you leave the app. Time in Trinity's own camera, photo picker,
share sheet or browser doesn't count as away, even if you leave Trinity from there: the timer
starts once that view closes.

While App lock is on, the app switcher on iPhone and iPad shows a blurred cover instead of
Trinity. On iPad, the cover may also show over Trinity in Split View or Slide Over while you use
the other app. On Android, Trinity's preview in recent apps is blank, and screenshots, screen
recording and screen sharing can't capture Trinity; Settings › Security says so. Turning App
lock off brings all of these back. If Trinity locks while one of its own sheets is still open,
on iPhone and iPad it closes it: the share sheet, the camera or a page in its browser. On
Android it closes a page open in its browser, though Android 10 and later don't allow that once
Trinity is in the background.

**Lock now.** Choose **Lock Trinity** from the account menu (select your name at the bottom of
the sidebar), or, on a computer, from the **File** menu. You can also give it a shortcut in
Settings › Keyboard shortcuts; it has none until you choose one.

**Unlock.** Where you have a system prompt (Face ID, Touch ID, Windows Hello, your fingerprint
or your phone's passcode), choose the lock screen's **Unlock with…** button. The prompt also
opens by itself when you come back to Trinity. It offers your phone's passcode or screen lock,
on a Mac **Use Password…** for your Mac's password, and on Windows your Windows Hello PIN.
Choose **Use PIN instead** to type your Trinity PIN. If the prompt stops being available, for
example after you turn off your phone's passcode or Windows Hello, the lock screen asks for your
PIN. While Trinity is locked, messages stay unread: Trinity sends no read receipts until you
unlock. Notifications still arrive, including for the room you left open, and a notification or
link you open while locked opens once you unlock. A verification request from another of your
devices, or from someone else, also waits until you unlock; if it's cancelled or times out
meanwhile, Trinity doesn't show it. On a computer, the window title shows only the app's name,
and Trinity's own shortcuts, such as the quick switcher, do nothing; the menu's window and
system commands, such as Quit, Close, Edit, zoom and full screen, still work.

**Wrong PINs.** After 5 wrong PINs in a row, Trinity makes you wait before the next try:
30 seconds, then 1 minute, 5 minutes, 15 minutes, and then 1 hour after each further wrong
PIN. The wait keeps counting if you quit and reopen Trinity. Nothing is erased. On a phone, too
many failed Face ID, Touch ID or fingerprint tries make the phone itself wait or ask for its
passcode, as it does for any app; Windows Hello limits its own tries too. If the phone or
Windows Hello reports too many tries, the lock screen asks for your Trinity PIN.

**Forgot PIN?** If you have a system prompt (Face ID, Touch ID, Windows Hello, your fingerprint
or your phone's passcode), unlock with it and set a new PIN with **Change PIN** in Settings ›
Security. Otherwise the only way back in is **Erase all data on this device**. That signs out
every account on this device, and encrypted messages are lost unless you have your recovery key
or another signed-in device. Keep your recovery key safe before you turn App lock on.

**"Trinity can't read your PIN right now".** Trinity keeps the PIN in your system's secure
storage. If that storage can't be read, for example while a Linux keyring is locked, the lock
screen offers **Retry**, the system prompt where you have one, and
**Erase all data on this device**. Unlock your keyring, then choose **Retry**.

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
