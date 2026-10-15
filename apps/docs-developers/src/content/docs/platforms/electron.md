---
title: Electron
description: Install, launch, verify, and package Trinity's separate desktop shell.
audience: developer
contentChannel: develop
canonicalTopic: platform-electron
pageType: how-to
platforms: [desktop]
---

Electron has its own manifest, lockfile, installed dependency tree, TypeScript configuration, main process, and preload bridge. It packages the same production `www/` renderer as the other hosts.

## Install and launch {#install-launch}

```bash
pnpm electron:install
pnpm electron:start
```

The install target prepares the standalone shell and Electron binary. The start target builds the shared renderer, compiles the shell, applies the optional development signature, and launches it.

## Validate the shell {#validate-shell}

```bash
pnpm electron:test
pnpm electron:typecheck
pnpm electron:verify
pnpm electron:e2e:smoke
```

Unit and type checks exercise Node-side shell code. The static verifier checks host and bridge contracts. The launched smoke journey proves a usable Electron process and renderer connection; it needs a supported machine and display.

## Preserve the security boundary {#electron-security}

Renderer code uses the validated preload API, not direct Node or Electron access. IPC is protocol-versioned, sender-validated, and capability-scoped. Secure storage accepts only a usable operating-system encryption backend and keeps diagnostic payloads free of secrets.

Packaged release builds, Trinity and Trinity Next alike, have no developer tools: the window is created with `devTools: false`, the View menu has no Toggle Developer Tools, Reload or Force Reload (nor their shortcuts), and a launch with `--remote-debugging-port` or `--remote-debugging-pipe` shows an error and exits. Development runs and the Electron journeys, which launch `electron/dist/main.js` unpackaged, keep all of them. Without Reload, the shell recovers the renderer itself (`renderer-recovery.ts`), in every build. A crash reloads the window, even one hidden to the tray, so it keeps syncing. A crash within a minute of a reload the shell made asks Reload or Quit instead. A window that stops responding asks Reload or Keep Waiting; the question closes if it responds again, and Reload ends the hung renderer and reloads once it has exited. A hidden or minimised window is asked when it is shown, restored or focused. Chromium does not report a renderer unresponsive while a debugger is attached to it, so the hang path has no Playwright journey.

Packaging targets produce host-specific artifacts and may require native toolchains or signing configuration. Do not describe a locally built development package as a release artifact. Release artifacts come from the release workflow; its Windows installer may be published unsigned, and Windows SmartScreen then warns about an unknown publisher on first run. Read [host capabilities](../../architecture/host-capabilities/) and [desktop and native tests](../../testing/desktop-and-native-tests/).

## Window frame and title row {#title-row}

The window is frameless by default. The renderer draws a 32px title row with the room title, the quick switcher, Report a bug (while Settings → Advanced → Keep a diagnostic log is on) and the system-status warning. On Windows and Linux the native minimise, maximise and close buttons are drawn over the row's right end, and a ☰ button opens the application menu. Its menu bar is hidden rather than removed, so the menu keeps its keyboard accelerators. On Windows and Linux that menu has File (Close, Ctrl+W, which hides to the tray, and Quit), Edit, View and Help, but no Window menu, so Ctrl+M does nothing. On macOS the row leaves room for the traffic lights. While the row shows, `<body>` has the `trn-title-row` class and `--trinity-title-row-inset` holds the row height. Global CDK overlays (dialogs, the lightbox, the widget frame) and other viewport-fixed layers start below the row, and viewport-sized panes subtract the inset. The CDK overlay container itself stays at the viewport origin, so anchored menus and tooltips keep their position. Otherwise the drag region and the native buttons would take clicks in the top 32px.

**Settings → Appearance → Use system title bar** brings back the operating system's frame and menu bar. The choice is stored in `window-prefs.json` in the data folder and applies after **Restart**. Main passes the running mode to preload as `--trinity-title-bar=row|system`, so the first render already knows whether to draw the row. A missing or unknown value never draws it.

## App lock {#app-lock}

App lock (Settings › Security) is a privacy screen: it never touches the Matrix session, the crypto store or secure-storage entries, and sync and notifications keep running while it is locked. Electron serves two of its host operations from the main process.

**User presence** (`user-presence-ipc.ts`, channels `trinity:host:v1:user-presence:*`). The system prompt is Touch ID on macOS, through `systemPreferences.canPromptTouchID()` and `promptTouchID()` (its sheet offers Use Password…). On Windows it is Windows Hello (face, fingerprint or Hello PIN) through `windows-hello.ts` and a small C++/WinRT Node-API addon in `electron/native/windows-hello`. The addon calls `UserConsentVerifier.CheckAvailabilityAsync` and `IUserConsentVerifierInterop::RequestVerificationForWindowAsync` with the main window's handle, so Trinity's window owns the Hello dialog. It is built with `pnpm -C electron run build:windows-hello` on Windows (the `Desktop (Windows Hello addon)` CI job builds it, loads it in Electron-as-Node and asks for availability twice), and ships as `resources/windows-hello.node` outside the asar, unsigned until Windows code signing exists; an unpackaged run loads `electron/build/windows-hello.node`. Hello is offered on Windows 11 (build 22000 or later) when availability is `available`. The build is checked first, so Windows 10 reads as `windows-version` even when the addon is missing. No Hello on the PC, or Hello busy or unknown (`not-supported`), leaves the PIN with no explanation on the lock screen. Hello not set up for this person (`not-configured`), turned off by policy (`disabled-by-policy`) and a missing or broken addon (`addon-unavailable`) also leave the Trinity PIN as the only method. The lock screen says "Windows Hello isn’t available" for those only when it has offered Hello on this lock (and always for `addon-unavailable`). A Hello dialog that answers "no device" after Hello was offered reads as `not-configured`, so it is named too. Hello's own lockout (`RetriesExhausted`) is `locked-out`, which also shows the PIN form. At most one Hello dialog is open at a time, because it blocks a libuv pool thread that the PIN's scrypt also uses. The renderer already joins or waits for its own prompts, so the host guard covers a renderer reloaded or recovered from a crash while a dialog is open: a request for the same reason joins the open dialog, and one for another reason is refused with `presence-busy`. Linux reports the system prompt `not-supported`, so the Trinity PIN is the only way to unlock there. The PIN verifier (`app-lock-pin.ts`) keeps one record, `app-lock.bin` in `userData`: an scrypt hash (N 2¹⁷, r 8, p 1) with its salt and the failure state, encrypted with `safeStorage`. It accepts 4 to 16 ASCII digits and enforces the wait after wrong PINs itself (none for the first four failures, then 30 s, 1, 5 and 15 minutes, then 1 hour), against both the wall clock and seconds since boot, so a restart or a clock change does not end a wait. Without usable encryption (none, or Linux `basic_text`) and with no record, there is no PIN store (`not-supported`) and Settings explains the keyring; a record that exists but can't be read is `secure-storage-unavailable`, never "no PIN". The PIN, its hash and its salt never cross IPC, and never reach logs or diagnostics. Each channel answers only the main window's renderer.

**Lock integration** (`lock-integration.ts`). The renderer reports `{ enabled, locked, accelerator }` on `set-state`. While App lock is on, File gets **Lock Trinity** (named after the running app), disabled while locked. It shows the `lock.now` shortcut the person bound in Settings. On Windows and Linux, `registerAccelerator: false` leaves the key to the renderer's shortcut service; macOS registers menu accelerators regardless, so there the key also chooses the menu item, which locks the same way. Choosing it, `powerMonitor` `lock-screen` (macOS and Windows) and `suspend` send `request` to the renderer, which locks at once.

**The show hold.** While App lock is on, hiding or minimising the window sets its opacity to 0 (`concealed`), so the frame the next show reveals can't be one painted before the lock. On show, restore, or a maximize or focus of a visible window, the hold waits (`revealing`) for the renderer's `cover-painted` signal, then restores opacity. The renderer sends it two animation frames after the cover opens, including in a reloaded renderer that starts locked, and again when a held window is shown: two frames later if it is locked, at once if not. A signal that arrives while the window is still concealed is ignored. If no signal comes within 700 ms, the window is shown anyway, unless the renderer cannot report: while it is unresponsive, or has exited and its replacement has not reported, the hold becomes `stalled` and the window stays transparent until a fresh `cover-painted`, a `responsive` event or a `set-state` with the lock off. Turning App lock off releases any hold.

**Renderer recovery.** While the hold keeps the window transparent (`getOpacity() < 1`), `renderer-recovery.ts` asks its hang and crash questions in an unparented message box rather than a sheet, so they show. A crash reload of a locked window comes back locked, and the reloaded cover's `cover-painted` is what reveals a stalled window. A window reloaded while hidden or minimised hears so from its one-time `visibility:current` query (`lifecycle-ipc.ts`), and the cover opens the system prompt only once the window is shown, restored or focused again.

**Limitations.** `setOpacity` does nothing on Linux (and `getOpacity` always returns 1), so there the hold has no effect and a window shown again may briefly show its last frame before the cover paints; the recovery question stays attached to the window. On the frameless window, the cover hides the title row with the rest of the workspace and draws a control-free drag strip of the row's height (`-webkit-app-region: drag`) so the locked window can still be moved. Whether that strip drags inside the top-layer `<dialog>` needs checking on each platform's real window manager.

`e2e/electron/app-lock.electron.spec.mts` proves the loop in the launched shell. It replaces the user-presence and notification handlers with in-memory fakes through `app.evaluate`, because CI has neither Touch ID nor a keyring and the shipped main has no test switch. The notification fake also reports notifications supported, and the journey reloads so the renderer negotiates again: the Linux runner has no libnotify, so Electron would otherwise withhold the operation. It covers turning App lock on, Lock now from the menu, the account menu and a bound shortcut, the title and shortcuts while locked, a notification and a held read receipt for the room left open, PIN and system-prompt unlock, and a reload and a repeated crash while locked revealing the window only after `cover-painted`.

## Application icons {#application-icons}

All app, tray, notification and splash icons are generated from two sources in `apps/trinity/src/assets/icon/`: `icon-plated.svg` (the app icon) and `icon.svg` (the transparent mark, recoloured for single-colour variants). After editing either, run `pnpm icons:generate` and commit the results; `scripts/generate-icons.spec.mjs` fails when a committed icon no longer matches a fresh render. The operating system themes the app icon, not a Trinity setting: the macOS bundle icon is an Icon Composer source, `electron/build/Trinity.icon` (generated with the others), from which macOS 26 renders its Default, Dark, Clear and Tinted styles. Building it needs Xcode 26's `actool`, so the macOS release job runs on `macos-26`. Windows and Linux show the Blurple icon; on Linux an icon theme may override the deb's named icon. Trinity Next's copies in `electron/build/next/` (the app icon, the window and notification icon, and an Icon Composer source whose NEXT badge sits in front of the mark) come from the same script. Packaged Trinity Next uses them; an unpackaged run shows the stable window and notification icon. The tray icons are shared, because a badge is not legible at tray size, so the tray tooltip and menu name the app.

## Release channels {#release-channels}

Each release line installs as its own app, so stable Trinity and the `-next` prerelease can be installed and run side by side.

| Version          | App          | App ID and URL scheme             | Linux package and executable |
| ---------------- | ------------ | --------------------------------- | ---------------------------- |
| `X.Y.Z` (stable) | Trinity      | `dev.trinityproject.trinity`      | `trinity-desktop`            |
| `X.Y.Z-next.N`   | Trinity Next | `dev.trinityproject.trinity.next` | `trinity-next`               |

`electron/src/release-channel.ts` maps a version to its channel and identity. Any other version shape stops packaging; a packaged or unpackaged app with such a version shows "Trinity cannot start" with the reason and exits. `electron/electron-builder.config.ts` reads the version from `electron/package.json`: a stable version packages `electron-builder.yml` as written, and a `-next` version merges `electron-builder.next.yml` onto it (objects merge key by key; lists and values replace). The `package*` scripts and the release workflow pass `--config electron-builder.config.ts`; a bare `electron-builder` run reads only `electron-builder.yml` and packages the stable identity. Release file names are the same on both lines; the version tells them apart. On Windows, the appId gives Trinity Next its own install folder (`…\Programs\Trinity Next`) and uninstall entry.

The main process derives the same channel for the Windows AppUserModelID and the URL scheme it registers and accepts, names the tray, body-only notifications and update notices after the app, and passes the channel to preload as `--trinity-release-channel=`. Preload exposes `trinityDesktop.appIdentity` (channel, URL scheme and device name, or `null` for an unknown channel). The renderer's Electron host adapter sends sign-in callbacks to that scheme, moves incoming links back to `dev.trinityproject.trinity:` before they are parsed, and names new Matrix devices, the OIDC client and the window title after the app. Each app accepts only its own scheme, so Trinity Next ignores links on stable's `dev.trinityproject.trinity:` scheme. When the shell reports no identity, sign-in fails rather than fall back to stable's scheme. Account-data types, the widget client ID and the push app ID stay shared: both apps are Trinity on the same account.

The launched-shell journey `e2e/electron/release-channel.electron.spec.mts` checks the running app's name, bridge identity, device name and sign-in callback scheme.

## Data and updates {#data-updates}

The desktop app stores its data in a folder named after the app under the operating system's application-data directory: `Trinity` for stable releases and `Trinity Next` for `-next` prereleases (for example `~/Library/Application Support/Trinity Next`, `%APPDATA%\Trinity Next`, `~/.config/Trinity Next`). Electron takes the name from `productName` in the packaged `package.json`: `electron/package.json` says `Trinity`, and `electron-builder.next.yml` sets `Trinity Next` through `extraMetadata`. An unpackaged run sets the same app name and data folder at startup from the version in `electron/package.json`, so development runs on `main` use `Trinity Next`; a `--user-data-dir=<path>` switch, as the E2E launcher passes, keeps its own folder. The single-instance lock and the macOS keychain item (`Trinity Safe Storage`, `Trinity Next Safe Storage`) follow the name too. Neither app copies the other's data, so Trinity Next starts signed out. Renaming a folder after a release would strand users' sessions and encrypted keys.

There is no auto-updater. Packaged builds ask GitHub Releases for a newer release on their own line (stable builds see only stable releases, `-next` builds only `-next` prereleases), shortly after launch and then daily, and show one notification per new version that opens its release page. **Help → Check for Updates…** runs the same check on demand. Set `TRINITY_DISABLE_UPDATE_CHECK=1` to turn the background check off; unpackaged development runs never check.
