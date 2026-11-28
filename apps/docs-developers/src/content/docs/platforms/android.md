---
title: Android
description: Synchronize, build, launch, and validate Trinity's Capacitor Android host.
audience: developer
contentChannel: develop
canonicalTopic: platform-android
pageType: how-to
platforms: [android]
---

Android packages the shared Angular renderer in a Capacitor WebView and supplies native host operations through plugins. Development requires the Android SDK, Java, the [native crypto toolchain](#native-crypto-toolchain), and an emulator or device.

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

The release target creates an AAB but remains unsigned unless external signing is configured. Build it after the release is published, with the release notes the app bundles: `TRINITY_RELEASE_NOTES=required GITHUB_TOKEN=$(gh auth token) pnpm android:build:release`. Keep credentials and publishing procedure out of public documentation.

## Native crypto toolchain {#native-crypto-toolchain}

The Android app runs end-to-end encryption on the native crypto crate (`native/crypto`), not on WASM; see [Native crypto](../native-crypto/#android). Every Android build, debug and release, cross-builds the crate's `libtrinity_crypto.so` for the four ABIs the app ships (`arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`) in the Gradle task `buildNativeCrypto`, which Gradle skips while the crate's sources are unchanged. It needs:

- Rust 1.99.1 (the version CI pins) with the Android targets: `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`;
- `cargo install cargo-ndk --locked --version 4.1.2`;
- the NDK `28.2.13676358` (`sdkmanager "ndk;28.2.13676358"`), found through `ANDROID_NDK_HOME` or under `$ANDROID_HOME/ndk`.

Without them the build fails and says what is missing; it never produces an app without native crypto by accident. The first build of each ABI takes a few minutes. Gradle properties, or the environment variables beside them, change what is built:

| Property                              | Environment                            | Effect                                                                                                                                               |
| ------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-PtrinityNativeCrypto=false`         | `TRINITY_NATIVE_CRYPTO=0`              | No library: the app runs crypto on WASM, as web and desktop do. Accounts signed in on the other kind of build refuse to start until signed in again. |
| `-PtrinityNativeCryptoAbis=x86_64`    | `TRINITY_NATIVE_CRYPTO_ABIS=x86_64`    | Builds only those ABIs, for an emulator. A release needs all four.                                                                                   |
| `-PtrinityNativeCryptoPrebuilt=<dir>` | `TRINITY_NATIVE_CRYPTO_PREBUILT=<dir>` | Packages `<dir>/<abi>/libtrinity_crypto.so` instead of building (what CI does).                                                                      |

`pnpm android:build:release` checks the bundle with `scripts/android-release-isolation.mjs`: the library for every ABI and the `TrinityCrypto` plugin, or with `TRINITY_NATIVE_CRYPTO=0` no library at all, and never debug-only crypto code.

## Push rendering {#push-rendering}

`TrinityMessagingService` replaces the push plugin's messaging service and renders push notifications while Trinity is closed or in the background. It lives with the `PushHandoff` plugin in the `:trinity-capacitor-push` Gradle module, which synchronization adds from the workspace package in `libs/native/capacitor-push/android`. Its Kotlin text rules and resolver have JVM unit tests, driven by the fixture shared with iOS, that run under `testDebugUnitTest`: `pnpm nx run trinity-android:verify-native` locally and CI's Android step. The app keeps the manifest removal of the plugin's own messaging service and points the module's notification icon and accent at its resources in `res/values/push_notification_appearance.xml`.

Push on a device needs a git-ignored `android/app/google-services.json`. The build runs without it, but Android registers for push only when Firebase is initialized, so push stays unsupported and the app keeps presenting its own notifications. Once registered, the running app stops presenting message notifications while its page is hidden and leaves them to the service; reaction notifications and a visible app are unchanged.

Debug builds (including the E2E-only secondary package) contain the module's shell-only probe receiver that the installed-app suite uses to drive the renderer without FCM: it posts a notification with the app terminated, then taps it and checks that the room opens. On CI that suite shows the fallback "New message" body, because the native code does not trust the end-to-end proxy's certificate authority. A second test stores an already expired token and checks for "Open Trinity to read this message", which needs no network. A real FCM token and closed-app delivery through the gateway need a physical device.

## Sign-in {#sign-in}

The Android app does not offer legacy SSO: on a homeserver that has it, the sign-in page hides **Continue with SSO** and says the server's single sign-on isn't supported in the Android app yet, keeping password sign-in when the server offers it. OAuth 2.0 sign-in opens the provider in Custom Tabs. See [sign-in callbacks](../../architecture/host-capabilities/#sign-in-callbacks).

## Calls {#calls}

Calls run in the WebView, in the Element Call frame. The manifest needs `MODIFY_AUDIO_SETTINGS` as well as `RECORD_AUDIO` and `CAMERA`: Capacitor's `WebChromeClient` asks for it with every microphone request and refuses the request when it is not declared, which also breaks voice messages. `CallSessionPlugin` starts `CallSessionService`, a foreground service that keeps the process, microphone and camera alive in the background. It declares only the service types whose runtime permission is granted (`microphone`, `camera`, else `mediaPlayback`), is never stopped from outside before it has reached the foreground (Android kills the app otherwise), and stops on `end`, on the notification's **Hang up** and when the task is removed. Neither a wake lock nor a Wi-Fi lock is held; Doze on a real device with the screen off for several minutes is untested.

## Test native behavior natively {#native-behavior}

Use an installed-host journey for permissions, system Back, app lifecycle, native secure storage, push, badges, keyboards, touch gestures, and WebView TLS. A mobile browser profile remains useful for layout but cannot prove these paths.

Read [platform integrations](../../development/platform-integrations/) and [desktop and native tests](../../testing/desktop-and-native-tests/).

App icons and splash screens are generated from shared sources; see [application icons](../electron/#application-icons).
