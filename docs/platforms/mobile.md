# Mobile

iOS and Android are Capacitor 8 wrappers around the same `www/` directory the web build
produces. The native projects live in the repository at `android/` and `ios/`, are checked
in, and are edited by the Capacitor CLI rather than by hand.

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

| Command                      | What it does                                           |
| ---------------------------- | ------------------------------------------------------ |
| `pnpm android:sync`          | `pnpm build` then `cap sync android`                   |
| `pnpm ios:sync`              | `pnpm build` then `cap sync ios`                       |
| `pnpm android:run`           | Build, then `cap run android` on an emulator or device |
| `pnpm ios:run`               | Build, then `cap run ios`                              |
| `pnpm android:open`          | Open the project in Android Studio, no rebuild         |
| `pnpm ios:open`              | Open the project in Xcode, no rebuild                  |
| `pnpm android:build`         | Sync, then `./gradlew assembleDebug`                   |
| `pnpm android:build:release` | Sync, then `./gradlew bundleRelease`, needs a keystore |
| `pnpm ios:build`             | Sync, then `cap build ios --scheme App`                |

`pnpm build` has no configuration flag, and the Angular target defaults to `production`, so
these are always production builds of the web layer even during development.

A web change is not visible in a native project until a sync has run. The `*:open` scripts
deliberately skip the rebuild, so opening Xcode after editing a component shows you the
previous build until you run `pnpm ios:sync`.

Android builds need an Android SDK that Gradle can find. iOS builds need macOS with Xcode.

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
| `@capacitor/status-bar`                        | Theme-matched status bar                                                                  |
| `@capawesome/capacitor-badge`                  | App-icon unread badge                                                                     |
| `@aparajita/capacitor-secure-storage`          | Keychain on iOS, Keystore on Android                                                      |

`@capacitor/keyboard` and `@capacitor/haptics` are installed and synced into both native
projects but have no TypeScript import anywhere in the workspace. Keyboard is configured
natively through `capacitor.config.ts` and needs no runtime call; haptics is currently
unused.

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
for a host to match against. `AppComponent.handleDeepLink()` checks the path and the
parameters before acting on anything that arrives.

**An FCM default notification channel.** The `default_notification_channel_id` meta-data
names `messages`, a channel created at runtime by `PushService`. Android O and later drop
notifications that name no channel.

**`POST_NOTIFICATIONS`.** Android 13 and later require it at runtime, and the push plugin's
own manifest does not declare it, so without this entry the OS denies notifications without
ever prompting.

**A FileProvider**, plus `CAMERA`, `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` for
attachment capture and saving.

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
The platform floor is `.iOS(.v15)` and `capacitor-swift-pm` is pinned with `exact:`.

`Info.plist` declares `CFBundleURLSchemes: [eu.qwky.trinity]` for the auth callback, and
five usage strings that iOS requires before the corresponding prompt can be shown:
`NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`,
`NSPhotoLibraryAddUsageDescription`, `NSMicrophoneUsageDescription` (voice messages) and
`NSLocationWhenInUseUsageDescription` (location sharing). A missing string is not a denied
permission the app can catch — iOS terminates the process the moment the API is touched, so
any new capability needs its key added here before the affordance ships.

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

This is not hypothetical. On `develop` today the generated files reference
`@capacitor/core` 8.4.1 and `@capacitor/android` 8.4.1, while the installed tree resolves
8.4.2 for both. Several plugins are similarly one patch behind. A contributor who runs
`pnpm android:build` before re-syncing will hit it.

Renovate's `ignorePaths` covers `android/**` and `ios/**`, so its Capacitor grouped update
will never regenerate these files. A dependency bump and the re-sync it requires are two
separate acts, and only the first one is automated.

## What behaves differently on mobile

| Capability           | Mobile behaviour                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Notifications        | In-app notification delivery is a no-op. Push owns delivery on iOS and Android                                                                                     |
| Push registration    | Gated on `getPlatform()` being exactly `'ios'` or `'android'`, and on the plugin being available                                                                   |
| Secret storage       | Keychain and Keystore through `@aparajita/capacitor-secure-storage`, with syncing switched off so a per-device Matrix session cannot leak across a user's devices  |
| App-icon badge       | `@capawesome/capacitor-badge`. iOS prompts once for badge authorization on first use; Android grants without a prompt                                              |
| Status bar           | `ThemeService` sets the native status-bar style to match the resolved light or dark theme                                                                          |
| Deep links           | `appUrlOpen` for a warm open, `getLaunchUrl` for a cold start                                                                                                      |
| Android back button  | The app owns the whole chain: an open overlay always consumes the press (dismissed unless it set `disableClose`), else step back through history, else minimize    |
| iOS history swipe    | Native Back/Forward stays enabled while no dialog or registered panel can intercept; both edges yield while one is active, and the drawer opens from an inset band |
| Media capture        | `MediaPickerService` opens the Capacitor gallery picker on native; elsewhere the composer falls back to a hidden file input                                        |
| Saving an attachment | Bytes are written to the cache and handed to the OS share sheet, rather than triggering a browser download                                                         |
| Service worker       | Not registered. The shell and the crypto module are already local files                                                                                            |

Everything else — the timeline, rooms and spaces, encryption, search — is the same code
running in a WebView.
