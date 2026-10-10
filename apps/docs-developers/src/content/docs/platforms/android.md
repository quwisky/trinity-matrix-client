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
pnpm e2e:mobile
```

The static verifier checks host contracts. Native verification runs Android unit tests after synchronization. The debug build creates an APK, while the installed E2E target (WebdriverIO and Appium in `e2e/mobile`) drives the installed app on a managed emulator.

The release target creates an AAB but remains unsigned unless external signing is configured. Keep credentials and publishing procedure out of public documentation.

## Push rendering {#push-rendering}

`TrinityMessagingService` replaces the push plugin's messaging service and renders push notifications while Trinity is closed or in the background. It lives with the `PushHandoff` plugin in the `:trinity-capacitor-push` Gradle module, which synchronization adds from the workspace package in `libs/native/capacitor-push/android`. Its Kotlin text rules and resolver have JVM unit tests, driven by the fixture shared with iOS, that run under `testDebugUnitTest`: `pnpm nx run trinity-android:verify-native` locally and CI's Android step. The app keeps the manifest removal of the plugin's own messaging service and points the module's notification icon and accent at its resources in `res/values/push_notification_appearance.xml`.

Push on a device needs a git-ignored `android/app/google-services.json`. The build runs without it, but Android registers for push only when Firebase is initialized, so push stays unsupported and the app keeps presenting its own notifications. Once registered, the running app stops presenting message notifications while its page is hidden and leaves them to the service; reaction notifications and a visible app are unchanged.

Debug builds (including the E2E-only secondary package) contain the module's shell-only probe receiver that the installed-app suite uses to drive the renderer without FCM: it posts a notification with the app terminated, then taps it and checks that the room opens. On CI that suite shows the fallback "New message" body, because the native code does not trust the end-to-end proxy's certificate authority. A real FCM token and closed-app delivery through the gateway need a physical device.

## Test native behavior natively {#native-behavior}

Use an installed-host journey for permissions, system Back, app lifecycle, native secure storage, push, badges, keyboards, touch gestures, and WebView TLS. A mobile browser profile remains useful for layout but cannot prove these paths.

Read [platform integrations](../../development/platform-integrations/) and [desktop and native tests](../../testing/desktop-and-native-tests/).

App icons and splash screens are generated from shared sources; see [application icons](../electron/#application-icons).
