# Mobile

iOS and Android are first-class Nx applications and Capacitor 8 wrappers around the same
`www/` directory the web build produces. The native projects live in the repository at
`android/` and `ios/`, are checked in, and are edited by the Capacitor CLI rather than by hand.

`android/project.json` registers `trinity-android`; `ios/project.json` registers
`trinity-ios`. Both are thin `role:app` composition projects with one dependency on the
shared `trinity` renderer. They contain no product behavior or per-platform Angular fork.

## Capacitor configuration

The whole of
[capacitor.config.ts](https://github.com/quwisky/trinity-matrix-client/blob/develop/capacitor.config.ts)
is four settings:

```ts
{
  appId: 'eu.qwky.trinity',
  appName: 'Trinity',
  webDir: 'www',
  plugins: { Keyboard: { resize: 'native' } },
}
```

`webDir: 'www'` is the same directory the Angular build writes to, which is why the web
build's flat output layout matters here as well as on desktop. See
[Web](web.md#where-the-build-output-goes).

The keyboard setting is pinned for intent rather than to change behaviour — `native` is the
default. Trinity is a chat application with a composer pinned to the bottom of the
viewport. Resizing the whole WebView when the soft keyboard appears is what makes `100dvh`
shrink, so the composer rides up above the keyboard instead of being covered by it. iOS
honours `resize`; Android already resizes the WebView.

## The sync flow

Every mobile script rebuilds the web app and re-syncs before doing anything else:

| Command                      | What it does                                                     |
| ---------------------------- | ---------------------------------------------------------------- |
| `pnpm android:sync`          | `trinity-android:sync`: build `trinity`, then `cap sync android` |
| `pnpm ios:sync`              | `trinity-ios:sync`: build `trinity`, then `cap sync ios`         |
| `pnpm android:run`           | Build, then `cap run android` on an emulator or device           |
| `pnpm ios:run`               | Build, then `cap run ios`                                        |
| `pnpm android:open`          | Open the project in Android Studio, no rebuild                   |
| `pnpm ios:open`              | Open the project in Xcode, no rebuild                            |
| `pnpm android:build`         | Sync, then `./gradlew assembleDebug`                             |
| `pnpm android:build:release` | Sync, then `./gradlew bundleRelease`, needs a keystore           |
| `pnpm ios:build`             | Sync, then `cap build ios --scheme App`                          |
| `pnpm android:verify`        | Docker-free Nx, shared-artifact, plugin and capability contract  |
| `pnpm ios:verify`            | Docker-free Nx, shared-artifact, plugin and capability contract  |

`pnpm build` has no configuration flag, and the Angular target defaults to `production`, so
these are always production builds of the web layer even during development.

A web change is not visible in a native project until a sync has run. The `*:open` scripts
deliberately skip the rebuild, so opening Xcode after editing a component shows you the
previous build until you run `pnpm ios:sync`.

Android builds need an Android SDK that Gradle can find. iOS builds need macOS with Xcode.
Toolchain-backed verification is discoverable as
`pnpm nx run trinity-android:verify-native` and
`pnpm nx run trinity-ios:verify-native`. The latter cannot run on Linux; it performs
an unsigned iPhone Simulator build on a macOS/Xcode host.

## Android end-to-end testing

`pnpm e2e:android` builds and installs the debug APK on a dedicated API 36 x86_64
emulator, then attaches Playwright to Trinity's real Capacitor WebView. Pass an explicit
`TRINITY_ANDROID_SERIAL`, or create an AVD named `Trinity_API_36`. The runner rejects
physical devices, other API levels, and other ABIs rather than modifying an arbitrary
connected target.

All canonical web journeys are collected against the installed package WebView, with
platform adapters for native capabilities and an independently packaged second test
device. External FCM delivery, the browser-only encrypted-key download, and the one
compositor-panning assertion are explicit platform skips rather than simulated passes.
Android-only journeys additionally cover hardware Back and persisted-session restoration
after a native force-stop/relaunch. See
[`e2e/README.md`](../../e2e/README.md#android-webview-journeys) for ownership, TLS,
diagnostics, and cleanup details.

Local runs require JDK 21, Docker, Android platform tools and emulator, Chrome, and the API
36 Google APIs x86_64 system image. Linux hosts must grant the current user read/write access
to `/dev/kvm`. Treat an explicitly supplied emulator as disposable: the runner clears
Trinity's package data and device logcat, replaces the debug APK, and force-stops the app;
only the previous `tcp:8448` reverse mapping is restored.

When the runner starts `Trinity_API_36` itself, the supported headless configuration is a cold
boot with `-no-snapshot -gpu software -feature -Vulkan` in addition to the no-window, no-audio,
and no-boot-animation flags. The software GLES path avoids the long-run SwiftShader/Vulkan
buffer failures seen under the canonical sequential inventory; disabling snapshot load/save
also prevents a stale renderer state from crossing runs. An explicitly supplied emulator is
accepted for focused diagnosis, but its renderer flags are outside the runner's control.

## Plugins

| Plugin                                         | What it is used for                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `@capacitor/core`                              | `isNativePlatform()` and `getPlatform()` branches                                         |
| `@capacitor/preferences`                       | Every persisted setting, composer drafts, the session, OIDC and SSO state                 |
| `@capacitor/app`                               | Deep links through `appUrlOpen` and `getLaunchUrl`, plus the Android hardware back button |
| `@capacitor/browser`                           | System browser for SSO and OIDC, and for external links                                   |
| `@capacitor/camera`                            | Media picker for attachments                                                              |
| `@capacitor/filesystem` and `@capacitor/share` | Save or share a downloaded attachment                                                     |
| `@capacitor/push-notifications`                | FCM and APNs token registration                                                           |
| `@capacitor/local-notifications`               | Present typed live-sync notification intents and return typed tap destinations            |
| `@capacitor/status-bar`                        | Theme-matched status bar                                                                  |
| `@capawesome/capacitor-badge`                  | App-icon unread badge                                                                     |
| `@aparajita/capacitor-secure-storage`          | Keychain on iOS, Keystore on Android                                                      |

`@capacitor/keyboard` and `@capacitor/haptics` are installed and synced into both native
projects but have no TypeScript import anywhere in the workspace. Keyboard is configured
natively through `capacitor.config.ts` and needs no runtime call; haptics is currently
unused.

## Host capability negotiation

Both hosts explicitly negotiate authentication handoff, deep links, file export, location,
secure storage and lifecycle support. Notification presentation and badges remain conditional
on their plugins' runtime support. Android additionally advertises hardware Back and
background/minimize; iOS does not emulate those Android operations because native WebKit history
gestures are coordinated by `NativeNavigation` instead. Update checks are explicitly unavailable
on both hosts until a native update channel exists. Commands remain cold RxJS Observables, and
unsupported operations return typed outcomes rather than rejected promises.

## Android project

| Setting                                 | Value             |
| --------------------------------------- | ----------------- |
| `namespace` and `applicationId`         | `eu.qwky.trinity` |
| `minSdkVersion`                         | 24                |
| `compileSdkVersion`, `targetSdkVersion` | 36                |
| Launch mode                             | `singleTask`      |

[AndroidManifest.xml](https://github.com/quwisky/trinity-matrix-client/blob/develop/android/app/src/main/AndroidManifest.xml)
carries five things worth knowing about.

**A scheme-only deep-link intent filter.** The `VIEW` filter declares
`android:scheme="eu.qwky.trinity"` with no `android:host`. Two callback shapes have to
match: legacy SSO redirects to `eu.qwky.trinity://sso-callback`, while OIDC uses the RFC
8252 section 7.1 private-use form `eu.qwky.trinity:/sso-callback`, which has no authority
for a host to match against. The Application Runtime adapter checks the path and parameters before
acting on anything that arrives, and owns the host subscription until shutdown.

**An FCM default notification channel.** The `default_notification_channel_id` meta-data
names `messages`, a channel created at runtime by `PushService`. Android O and later drop
notifications that name no channel.

**`POST_NOTIFICATIONS`.** Android 13 and later require it at runtime, and the push plugin's
own manifest does not declare it, so without this entry the OS denies notifications without
ever prompting.

**A FileProvider**, plus `CAMERA`, `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` for
attachment capture and saving. QR verification uses the WebView's live camera API against
the same declared camera permission, so the scanner stays shared with web and desktop. The
iOS camera usage description names both attachment capture and verification QR scanning.

**`android:allowBackup="false"`** — a deliberate departure from the Capacitor generator
default. The Rust crypto store lives in the WebView data directory and is initialised with
no store passphrase, so it is not encrypted at rest: the device's Olm identity and every
inbound megolm session sit in `app_webview/`. Android Auto Backup would sweep that into
Google Drive, where a restore onto an attacker-controlled device decrypts the user's whole
cached history without ever needing the access token the app keeps in the Keystore.
`cap sync` regenerates the manifest, so check this attribute survived after any Capacitor
bump. If backup is wanted later, keep it opt-in through `dataExtractionRules` and
`fullBackupContent` that exclude `app_webview/` and the Preferences file.

There is no `google-services.json` in the repository. The Gradle scaffold applies the
Google Services plugin only when that file is present and otherwise logs that push
notifications will not work. Supplying it is part of setting up push, covered in
[Push notifications](../reference/push-notifications.md).

## iOS project

The iOS project consumes its Capacitor dependencies through Swift Package Manager, defined
in
[ios/App/CapApp-SPM/Package.swift](https://github.com/quwisky/trinity-matrix-client/blob/develop/ios/App/CapApp-SPM/Package.swift).
The platform floor is `.iOS(.v16)` and `capacitor-swift-pm` is pinned with `exact:`.

`Info.plist` declares `CFBundleURLSchemes: [eu.qwky.trinity]` for the auth callback, and
six usage strings that iOS requires before the corresponding prompt can be shown:
`NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`,
`NSPhotoLibraryAddUsageDescription`, `NSMicrophoneUsageDescription` (voice messages) and
`NSLocationWhenInUseUsageDescription` plus
`NSLocationAlwaysAndWhenInUseUsageDescription` (the native geolocation plugin requires both,
although Trinity only asks while the app is in use). A missing string is not a denied permission
the app can catch — iOS terminates the process the moment the API is touched, so any new
capability needs its key added here before the affordance ships.

Neither native project has its `public/` web assets tracked in git — those are produced by
`cap sync`.

`MainViewController.swift` also owns Trinity's one local Capacitor plugin,
`NativeNavigation`. WebKit exposes its native Back and Forward edge gestures behind one
switch and bypasses Capacitor's Android-style `backButton` event, so the Angular shell mirrors
whether a dialog or registered feature panel can currently consume Back. The controller starts
with gestures disabled (the safe state if bridge registration or synchronization fails) and
enables them only after Angular reports an empty interception stack. The drawer's opening
affordance is the 24px band immediately inside a 32px native-history strip, leaving the extreme
right edge to native history.

## Generated native paths go stale

!!! danger "Re-sync after any Capacitor dependency change"

    `cap sync` writes **absolute plugin paths** into
    `android/capacitor.settings.gradle` and `ios/App/CapApp-SPM/Package.swift`. Under pnpm
    those paths point into the content-addressed store and embed both the resolved version
    and its peer hash, like
    `node_modules/.pnpm/@capacitor+android@8.4.1_@capacitor+core@8.4.1/…`.

    Bump any Capacitor package and every one of those paths stops existing. The build fails
    with "No such file or directory" against a directory that looks entirely plausible.

    The fix is `pnpm android:sync` and `pnpm ios:sync`, then commit the regenerated files.

The explicit Nx `sync` targets are the supported repair path; a contributor who runs a native
tool directly before re-syncing can still hit stale generated plugin paths.

Renovate's `ignorePaths` covers `android/**` and `ios/**`, so its Capacitor grouped update
will never regenerate these files. A dependency bump and the re-sync it requires are two
separate acts, and only the first one is automated.

## What behaves differently on mobile

| Capability           | Mobile behaviour                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notifications        | Live synced events use `@capacitor/local-notifications`; permission and plugin availability are explicit, and taps return the exact Account, Room and event destination. Remote push still covers delivery when the app is suspended or absent. |
| Push registration    | Gated on `getPlatform()` being exactly `'ios'` or `'android'`, and on the plugin being available                                                                                                                                                |
| Secret storage       | Keychain and Keystore through `@aparajita/capacitor-secure-storage`, with syncing switched off so a per-device Matrix session cannot leak across a user's devices                                                                               |
| App-icon badge       | `@capawesome/capacitor-badge`. iOS prompts once for badge authorization on first use; Android grants without a prompt                                                                                                                           |
| Status bar           | `ThemeService` sets the native status-bar style to match the resolved light or dark theme                                                                                                                                                       |
| Deep links           | `appUrlOpen` for a warm open, `getLaunchUrl` for a cold start                                                                                                                                                                                   |
| Android back button  | The app owns the whole chain: an open overlay always consumes the press (dismissed unless it set `disableClose`), else step back through history, else minimize                                                                                 |
| iOS history swipe    | Native Back/Forward stays enabled while no dialog or registered panel can intercept; both edges yield while one is active, and the drawer opens from an inset band                                                                              |
| Composer insert      | The `+` opens the shared bottom sheet on the iOS/Android interaction model, including mobile web/PWAs. Desktop web and Electron retain an anchored menu                                                                                         |
| Media capture        | `MediaPickerService` opens the Capacitor gallery picker on native; elsewhere the composer falls back to a hidden file input                                                                                                                     |
| Saving an attachment | Bytes are written to the cache and handed to the OS share sheet, rather than triggering a browser download                                                                                                                                      |
| Service worker       | Not registered. The shell and the crypto module are already local files                                                                                                                                                                         |

Everything else — the timeline, rooms and spaces, encryption, search — is the same code
running in a WebView.
