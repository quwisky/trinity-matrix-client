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
pnpm nx run trinity-ios:test-push
pnpm ios:build
```

The static verifier checks shared host contracts on any supported development machine. `verify-native` performs an unsigned simulator build and requires macOS and Xcode. A successful unsigned simulator build does not prove device signing, App Store packaging, notification delivery, Keychain behavior on a device, or production lifecycle.

## Run the installed-app suite {#ios-e2e}

```bash
TRINITY_E2E_HOMESERVER=synapse TRINITY_E2E_HOMESERVER_RUNTIME=native TRINITY_E2E_SSO_PROVIDER=mock pnpm e2e:mobile:ios
```

The WebdriverIO and Appium suite drives the simulator build through the XCUITest driver. It needs macOS, Xcode, the pinned iOS Simulator runtime, `caddy` on `PATH`, and a Python 3 new enough for the pinned Synapse (the system Python 3.9 is too old); Synapse runs from a venv instead of Docker, without a second homeserver; with `dex` on `PATH` and `TRINITY_E2E_SSO_PROVIDER=mock`, the SSO spec signs in through Dex's form-free mock connector, and skips otherwise. Read [desktop and native tests](../../testing/desktop-and-native-tests/) for what simulator evidence does and does not prove.

## Push extension and configuration {#push-extension}

The Xcode project has two targets: `App` and the `NotificationService` app extension (`dev.trinityproject.trinity.NotificationService`), which renders push notifications while Trinity is closed. Both link the local `TrinityPush` Swift package in `ios/App/TrinityPush`; run its tests with `pnpm nx run trinity-ios:test-push`. The targets share the app group `group.dev.trinityproject.trinity` and a keychain access group, declared in `App/App.entitlements` and `NotificationService/NotificationService.entitlements` together with the push capability.

Debug and Release builds both sign with those entitlements, so a free personal team cannot sign the app: running on a device needs a paid team with both App IDs (`dev.trinityproject.trinity` and `dev.trinityproject.trinity.NotificationService`) registered for Push Notifications, App Groups and Keychain Sharing. The installed-app suite signs its simulator build with `App/App.e2e.entitlements` (push environment included) instead.

Firebase Messaging is a Swift package of the `App` target, pinned to 12.17.0, the last release whose FCM-token API is not deprecated; `FirebaseAppDelegateProxyEnabled` is `NO` because `AppDelegate` forwards the APNs token itself. Push on a device needs a git-ignored `ios/App/App/GoogleService-Info.plist`; the file is optional for building. Without it the app reports the APNs token, which the Trinity gateway does not accept, so no push arrives. The Firebase, APNs key and App ID setup is tracked in [#1152](https://github.com/quwisky/trinity-matrix-client/issues/1152).

The installed-app suite cannot show the extension launching: the Simulator does not start notification service extensions for simulated pushes. `push-render-ios.e2e.mts` drives the same rendering path through a debug-only probe in the app. A real FCM token, the extension on a device, locked-phone rendering, closed-app delivery and tap-to-open need a physical device.

## Respect native ownership {#native-ownership}

Keep plugin access in `libs/platform-native` adapters and consume shared host operations from application code. Test safe areas, keyboard resizing, system browser authentication, deep links, lifecycle, secure storage, notification activation, and Back behavior in the environment whose behavior changed.

Record iOS checks as unavailable when the required Apple environment is missing. Read [host capabilities](../../architecture/host-capabilities/) and [desktop and native tests](../../testing/desktop-and-native-tests/).

App icons and splash screens are generated from shared sources; see [application icons](../electron/#application-icons).
