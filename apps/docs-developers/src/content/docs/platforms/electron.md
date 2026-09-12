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

Packaging targets produce host-specific artifacts and may require native toolchains or signing configuration. Do not describe an unsigned development package as a release artifact. Read [host capabilities](../../architecture/host-capabilities/) and [desktop and native tests](../../testing/desktop-and-native-tests/).
