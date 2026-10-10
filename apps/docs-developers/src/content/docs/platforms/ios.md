---
title: iOS
description: Synchronize, build, launch, and statically validate Trinity's Capacitor iOS host.
audience: developer
contentChannel: develop
canonicalTopic: platform-ios
pageType: how-to
platforms: [ios]
---

iOS packages the shared Angular renderer in a Capacitor WebView. Building or launching the native project requires macOS and Xcode; device work can also require signing.

## Synchronize and open {#sync-open}

```bash
pnpm ios:sync
pnpm ios:open
pnpm ios:run
```

Synchronization builds the shared production renderer, copies `www/`, and refreshes native plugin wiring. Review generated project changes when plugin or Capacitor configuration changes.

## Validate the host {#validate-ios}

```bash
pnpm ios:verify
pnpm nx run trinity-ios:verify-native
pnpm ios:build
```

The static verifier checks shared host contracts on any supported development machine. `verify-native` performs an unsigned simulator build and requires macOS and Xcode. A successful unsigned simulator build does not prove device signing, App Store packaging, notification delivery, Keychain behavior on a device, or production lifecycle.

## Run the installed-app suite {#ios-e2e}

```bash
TRINITY_E2E_HOMESERVER=synapse TRINITY_E2E_HOMESERVER_RUNTIME=native pnpm e2e:mobile:ios
```

The WebdriverIO and Appium suite drives the simulator build through the XCUITest driver. It needs macOS, Xcode, the pinned iOS Simulator runtime, `python3` and `caddy` on `PATH`; Synapse runs from a venv instead of Docker, without a second homeserver; with `dex` on `PATH` and `TRINITY_E2E_SSO_PROVIDER=mock`, the SSO spec signs in through Dex's form-free mock connector, and skips otherwise. Read [desktop and native tests](../../testing/desktop-and-native-tests/) for what simulator evidence does and does not prove.

## Respect native ownership {#native-ownership}

Keep plugin access in `libs/platform-native` adapters and consume shared host operations from application code. Test safe areas, keyboard resizing, system browser authentication, deep links, lifecycle, secure storage, notification activation, and Back behavior in the environment whose behavior changed.

Record iOS checks as unavailable when the required Apple environment is missing. Read [host capabilities](../../architecture/host-capabilities/) and [desktop and native tests](../../testing/desktop-and-native-tests/).

App icons and splash screens are generated from shared sources; see [application icons](../electron/#application-icons).
