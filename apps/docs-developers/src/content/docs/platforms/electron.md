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

Packaging targets produce host-specific artifacts and may require native toolchains or signing configuration. Do not describe a locally built development package as a release artifact. Release artifacts come from the release workflow; its Windows installer may be published unsigned, and Windows SmartScreen then warns about an unknown publisher on first run. Read [host capabilities](../../architecture/host-capabilities/) and [desktop and native tests](../../testing/desktop-and-native-tests/).

## Window frame and title row {#title-row}

The window is frameless by default. The renderer draws a 32px title row with the room title, the quick switcher, Report a bug (while Settings → Advanced → Keep a diagnostic log is on) and the system-status warning. On Windows and Linux the native minimise, maximise and close buttons are drawn over the row's right end, and a ☰ button opens the application menu. Its menu bar is hidden rather than removed, so the menu keeps its keyboard accelerators. On macOS the row leaves room for the traffic lights. While the row shows, `<body>` has the `trn-title-row` class and `--trinity-title-row-inset` holds the row height. Global CDK overlays (dialogs, the lightbox, the widget frame) and other viewport-fixed layers start below the row, and viewport-sized panes subtract the inset. The CDK overlay container itself stays at the viewport origin, so anchored menus and tooltips keep their position. Otherwise the drag region and the native buttons would take clicks in the top 32px.

**Settings → Appearance → Use system title bar** brings back the operating system's frame and menu bar. The choice is stored in `window-prefs.json` in the data folder and applies after **Restart**. Main passes the running mode to preload as `--trinity-title-bar=row|system`, so the first render already knows whether to draw the row. A missing or unknown value never draws it.

## Application icons {#application-icons}

All app, tray, notification and splash icons are generated from two sources in `apps/trinity/src/assets/icon/`: `icon-plated.svg` (the app icon) and `icon.svg` (the transparent mark, recoloured for single-colour variants). After editing either, run `pnpm icons:generate` and commit the results; `scripts/generate-icons.spec.mjs` fails when a committed icon no longer matches a fresh render. The operating system themes the app icon, not a Trinity setting: the macOS bundle icon is an Icon Composer source, `electron/build/Trinity.icon` (generated with the others), from which macOS 26 renders its Default, Dark, Clear and Tinted styles. Building it needs Xcode 26's `actool`, so the macOS release job runs on `macos-26`. Windows and Linux show the Blurple icon; on Linux an icon theme may override the deb's named icon. Trinity Next's copies in `electron/build/next/` (the app icon, the window and notification icon, and an Icon Composer source whose NEXT badge sits in front of the mark) come from the same script. Packaged Trinity Next uses them; an unpackaged run shows the stable window and notification icon. The tray icons are shared, because a badge is not legible at tray size, so the tray tooltip and menu name the app.

## Release channels {#release-channels}

Each release line installs as its own app, so stable Trinity and the `-next` prerelease can be installed and run side by side.

| Version          | App          | App ID and URL scheme             | Linux package and executable |
| ---------------- | ------------ | --------------------------------- | ---------------------------- |
| `X.Y.Z` (stable) | Trinity      | `dev.trinityproject.trinity`      | `trinity-desktop`            |
| `X.Y.Z-next.N`   | Trinity Next | `dev.trinityproject.trinity.next` | `trinity-next`               |

`electron/src/release-channel.ts` maps a version to its channel and identity. Any other version shape stops packaging; a packaged or unpackaged app with such a version shows "Trinity cannot start" with the reason and exits. `electron/electron-builder.config.ts` reads the version from `electron/package.json`: a stable version packages `electron-builder.yml` as written, and a `-next` version merges `electron-builder.next.yml` onto it (objects merge key by key; lists and values replace). The `package*` scripts and the release workflow pass `--config electron-builder.config.ts`; a bare `electron-builder` run reads only `electron-builder.yml` and packages the stable identity. Release file names are the same on both lines; the version tells them apart. On Windows, the appId gives Trinity Next its own install folder (`…\Programs\Trinity Next`) and uninstall entry.

The main process derives the same channel for the Windows AppUserModelID and the URL scheme it registers and accepts, names the tray and body-only notifications after the app, and passes the channel to preload as `--trinity-release-channel=`. Preload exposes `trinityDesktop.appIdentity` (channel, URL scheme and device name, or `null` for an unknown channel). The renderer's Electron host adapter sends sign-in callbacks to that scheme, moves incoming links back to `dev.trinityproject.trinity:` before they are parsed, and names new Matrix devices and the OIDC client after the app. Each app accepts only its own scheme, so Trinity Next ignores links on stable's `dev.trinityproject.trinity:` scheme. When the shell reports no identity, sign-in fails rather than fall back to stable's scheme. Account-data types, the widget client ID and the push app ID stay shared: both apps are Trinity on the same account.

The launched-shell journey `e2e/electron/release-channel.electron.spec.mts` checks the running app's name, bridge identity, device name and sign-in callback scheme.

## Data and updates {#data-updates}

The desktop app stores its data in a folder named after the app under the operating system's application-data directory: `Trinity` for stable releases and `Trinity Next` for `-next` prereleases (for example `~/Library/Application Support/Trinity Next`, `%APPDATA%\Trinity Next`, `~/.config/Trinity Next`). Electron takes the name from `productName` in the packaged `package.json`: `electron/package.json` says `Trinity`, and `electron-builder.next.yml` sets `Trinity Next` through `extraMetadata`. An unpackaged run sets the same app name and data folder at startup from the version in `electron/package.json`, so development runs on `main` use `Trinity Next`; a `--user-data-dir=<path>` switch, as the E2E launcher passes, keeps its own folder. The single-instance lock and the macOS keychain item (`Trinity Safe Storage`, `Trinity Next Safe Storage`) follow the name too. Neither app copies the other's data, so Trinity Next starts signed out. Renaming a folder after a release would strand users' sessions and encrypted keys.

There is no auto-updater. Packaged builds ask GitHub Releases for a newer release on their own line (stable builds see only stable releases, `-next` builds only `-next` prereleases), shortly after launch and then daily, and show one notification per new version that opens its release page. **Help → Check for Updates…** runs the same check on demand. Set `TRINITY_DISABLE_UPDATE_CHECK=1` to turn the background check off; unpackaged development runs never check.
