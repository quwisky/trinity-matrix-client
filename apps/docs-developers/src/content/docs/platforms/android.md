---
title: Android
description: Synchronize, build, launch, and validate Trinity's Capacitor Android host.
audience: developer
contentChannel: develop
canonicalTopic: platform-android
pageType: how-to
platforms: [android]
---

Android packages the shared Angular renderer in a Capacitor WebView and supplies native host operations through plugins. Development requires the Android SDK, Java, and an emulator or device.

## Synchronize and run {#sync-run}

```bash
pnpm android:sync
pnpm android:run
```

Synchronization builds the production `trinity` target, copies `www/` into the Android project, and refreshes Capacitor plugin wiring. Because it updates generated native files, review the resulting changes instead of treating them as disposable output.

## Build and validate {#build-validate}

```bash
pnpm android:verify
pnpm nx run trinity-android:verify-native
pnpm android:build
pnpm e2e:android
```

The static verifier checks host contracts. Native verification runs Android unit tests after synchronization. The debug build creates an APK, while the installed E2E target runs shared journeys through a managed WebView.

The release target creates an AAB but remains unsigned unless external signing is configured. Keep credentials and publishing procedure out of public documentation.

## Test native behavior natively {#native-behavior}

Use an installed-host journey for permissions, system Back, app lifecycle, native secure storage, push, badges, keyboards, touch gestures, and WebView TLS. A mobile browser profile remains useful for layout but cannot prove these paths.

Read [platform integrations](../../development/platform-integrations/) and [desktop and native tests](../../testing/desktop-and-native-tests/).
