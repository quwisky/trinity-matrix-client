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

## Application icons {#application-icons}

All app, tray, notification and splash icons are generated from two sources in `apps/trinity/src/assets/icon/`: `icon-plated.svg` (the app icon) and `icon.svg` (the transparent mark, recoloured for single-colour variants). After editing either, run `pnpm icons:generate` and commit the results; `scripts/generate-icons.spec.mjs` fails when a committed icon no longer matches a fresh render. The generator also renders dark twins (`*-dark.png`, plus the Android and iOS equivalents); the **App icon** preference applies them at runtime (Dock, window and tray on desktop). Packaged builds also keep the choice after Trinity quits (`electron/src/app-icon-persistence.ts`): a custom icon on the macOS bundle, Trinity's Windows Start menu, desktop and pinned-taskbar shortcuts, and a per-user `~/.local/share/applications` copy of the deb's `.desktop` entry. AppImage builds keep the shipped icon after quit. The macOS custom icon is unsealed content in the signed bundle, so `codesign --verify` reports it; an update replaces the bundle and the next launch re-applies a stored Dark icon.

## Data and updates {#data-updates}

The desktop app stores its data in the `Trinity` folder under the operating system's application-data directory (`~/Library/Application Support/Trinity`, `%APPDATA%\Trinity`, `~/.config/Trinity`). The folder follows `productName` in `electron/package.json`; renaming it after a release would strand users' sessions and encrypted keys.

There is no auto-updater. Packaged builds ask GitHub Releases for a newer release on their own line (stable builds see stable releases; `-next` builds also see newer prereleases), shortly after launch and then daily, and show one notification per new version that opens its release page. **Help → Check for Updates…** runs the same check on demand. Set `TRINITY_DISABLE_UPDATE_CHECK=1` to turn the background check off; unpackaged development runs never check.
