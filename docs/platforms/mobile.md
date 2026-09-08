# Mobile

Android and iOS are Capacitor 8 hosts around the shared production renderer. They contain
no platform-specific Angular product fork: the root `trinity:build` creates `www/`, then
Capacitor copies that exact renderer and refreshes native plugin wiring.

Use this guide for prerequisites, synchronization, launch and debugging, artifacts, and
native capability limits. [Commands](../contributing/commands.md#native-hosts) is the
canonical command reference; [maintainer guidance](../maintaining/index.md) owns release
signing and publication.

## Prepare the host

| Host    | Required for build                               | Required to launch             | Project and renderer floors                                                               |
| ------- | ------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------- |
| Android | Android SDK, a usable `ANDROID_HOME`, and JDK 21 | An emulator or device          | minSdk 24; compile/target SDK 36                                                          |
| iOS     | macOS and Xcode                                  | A selected simulator or device | Xcode deployment target 16.4; generated SPM package floor iOS 16; renderer Safari/iOS 17+ |

These are three distinct iOS constraints: the Xcode project deploys from 16.4, generated
Capacitor Swift Package Manager metadata names iOS 16, and Trinity's renderer support floor
is Safari/iOS 17+. The project floors describe build eligibility; they do not lower the
renderer floor. See [the stack](../reference/stack.md) and
[installation requirements](../users/install.md) for the supported-browser policy.

Android E2E additionally needs Docker, Chrome, an API 36 Google APIs x86_64 emulator image,
and Linux KVM access where applicable. An iOS build or simulator launch cannot run on Linux.

## Build, synchronize, and launch

Every normal mobile build or run target depends on `sync`, and `sync` first depends on
the shared production `trinity:build`. Use these task recipes:

```bash
pnpm android:sync
pnpm android:run
pnpm android:open
pnpm android:build

pnpm ios:sync
pnpm ios:run
pnpm ios:open
pnpm ios:build
```

`*:open` only opens Android Studio or Xcode; it does not rebuild or synchronize. After a
web change, run `pnpm android:sync` or `pnpm ios:sync` before relying on the native IDE
project. `android:build` creates the debug APK at
`android/app/build/outputs/apk/debug/`. `android:build:release` runs Gradle's release bundle
target, but this repository declares no release `signingConfig`; without externally supplied
signing configuration it produces an unsigned AAB, not a distributable Android release.
`ios:build` delegates to `cap build ios --scheme App`: it archives the app and exports an
IPA into `ios/App/output/`. The installed Capacitor CLI defaults to Release, automatic
signing and App Store Connect export, then removes its temporary archive after successful
export. Configure the appropriate team, provisioning and signing access on macOS before
using this distribution workflow. It is separate from unsigned simulator compilation through
`trinity-ios:verify-native`; the Nx target's declared `ios/App/build` output does not match
the CLI's actual IPA export directory.

CI and cross-host parity use the verified renderer aliases:

```bash
pnpm android:build:prebuilt
pnpm ios:build:prebuilt
```

They verify `dist/web-bundle-manifest.json` and the existing `www/` payload before
Capacitor synchronization, then allow only the generated Cordova files in the native
public directory. They do not compile another web renderer. The normal `android:build`,
`ios:build`, `*:sync`, and `*:run` targets retain their production renderer dependency
for standalone local workflows.

`cap sync` updates checked-in native plugin paths. After changing a Capacitor dependency,
synchronize both projects and review the regenerated files:

```bash
pnpm android:sync
pnpm ios:sync
```

Generated Android Gradle and iOS Swift Package Manager paths include pnpm's resolved
dependency location. A dependency update without a re-sync can fail with a missing
generated plugin path. Do not hand-edit generated plugin wiring.

## Debug and verify the real host

Static contracts are available without the native toolchain:

```bash
pnpm android:verify
pnpm ios:verify
```

They check the shared renderer artifact graph, configured plugins, deep-link contracts,
and native capability wiring. They do not install, launch, or permission-test an app.

Toolchain checks are distinct:

```bash
pnpm nx run trinity-android:verify-native
pnpm nx run trinity-ios:verify-native
```

Android native verification synchronizes and runs Gradle unit validation. iOS native
verification synchronizes and builds the unsigned Simulator target, so it requires macOS
and Xcode. CI runs the corresponding prebuilt iOS target on `macos-26`; it checks the
native host around the verified renderer and retains Xcode diagnostics, but does not
launch an installed simulator journey. On Linux, `pnpm ios:verify` can pass while
`trinity-ios:verify-native` is unavailable; report that difference accurately.

For Android debugging, run `pnpm android:open`, select the intended emulator or device in
Android Studio, and use its Run and Logcat windows for native errors. With a debug WebView
listed by Chrome, attach through `chrome://inspect` for renderer Console and Sources. For iOS,
run `pnpm ios:open`, select the simulator or device in Xcode, launch the App scheme, and use
Xcode's debug console. These are host diagnosis steps, not evidence that a release artifact
was signed or distributed.

For actual installed-WebView evidence, use the serialized Android lifecycle:

```bash
pnpm e2e:android
```

It builds production output, synchronizes it, verifies the copied renderer, installs a
debug APK on a validated dedicated API 36 x86_64 emulator, and runs shared journeys plus
Android-only behavior. It clears test-app data, changes the APK and logcat, and may change
ADB reverse mappings. Use `TRINITY_ANDROID_SERIAL` only for a disposable dedicated
emulator; the runner does not use a physical or arbitrary attached device. Its Android
documentation covers [ownership, TLS, diagnostics, and cleanup](../../e2e/README.md#android-webview-journeys).

Browser emulation is useful for web layout but does not prove Capacitor APIs, Android
hardware Back, native permissions, WebView TLS, or process restoration. External FCM delivery,
encrypted-key export, and compositor panning remain explicit Android E2E skips; no browser
shim is substituted as false native proof. No equivalent installed-iOS-WebView Playwright
runner exists.

## Native configuration and capability behavior

`capacitor.config.ts` declares `eu.qwky.trinity`, renderer directory `www/`, and
native keyboard resizing. The latter keeps the composer above the software keyboard; Android
already resizes its WebView and iOS honors the configured behavior.

| Capability           | Implemented native behavior and limit                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deep links           | `@capacitor/app` receives warm `appUrlOpen` and cold `getLaunchUrl`; both callback forms use `eu.qwky.trinity:`.                                                                                                                                                                                                                            |
| Secure storage       | Tokens and cross-signing secrets use Keychain/Keystore through the [secure-storage adapter](../../libs/platform-native/src/lib/secure-storage.service.ts), with cloud syncing disabled. If the native plugin is unavailable, it falls back to unencrypted Preferences and reports that anomaly. Regular preferences are not secret storage. |
| Notifications        | Local notifications present live synced events when permission and plugin support allow it; remote push requires platform configuration and registration.                                                                                                                                                                                   |
| Badge and status bar | Badges use negotiated support and typed host outcomes. The separate Appearance chrome adapter probes native platform/StatusBar plugin availability, applies resolved Mode when available and otherwise completes without a change.                                                                                                          |
| Attachments          | Native picker/camera, Filesystem, and Share provide capture and save/share behavior; browser file/download fallbacks are different.                                                                                                                                                                                                         |
| Navigation           | Android hardware Back resolves the topmost dialog/active Workspace Back owner, including registered panels, before browser history or minimization. iOS native history gestures yield while a dialog or registered panel can intercept.                                                                                                     |
| Updates              | No native update channel exists, so update capability is unavailable.                                                                                                                                                                                                                                                                       |
| Service worker       | Not registered in native hosts: the renderer and crypto assets are already local files.                                                                                                                                                                                                                                                     |

Host operations remain cold, finite commands with explicit unsupported or failed outcomes.
Do not simulate a missing native capability in a browser and call it host proof.

## Android project contracts

Android uses application ID `eu.qwky.trinity`, `singleTask` launch mode, and a
scheme-only `eu.qwky.trinity` deep-link filter. It accepts both legacy
`eu.qwky.trinity://sso-callback` and authority-less OIDC
`eu.qwky.trinity:/sso-callback`; application code validates path and parameters before
acting.

The manifest declares camera and media access for attachments and QR verification,
`POST_NOTIFICATIONS` for Android 13 and later, and a `messages` notification channel.
Without the runtime permission or channel, the OS does not deliver the notification as the
application expects.

Android uses Trinity's native badge adapter for both push snapshots and synced unread
totals. Capacitor's vendor badge plugin remains enabled for iOS only; Android links the
same pinned ShortcutBadger launcher library directly to avoid competing badge writers.
Supported numerical badges use unread counts, capped at 9,999. Launcher dots and
notification-channel sound behavior follow Android settings; see
[counts and sound behavior](../reference/push-notifications.md#android-native-and-foreground-delivery).

Android backup is explicitly disabled. The WebView crypto store holds device identity and
inbound Megolm sessions, so copying it through Android Auto Backup would compromise cached
encrypted history on restore. After a Capacitor update and sync, verify that
`android:allowBackup="false"` remains in the manifest.

The repository intentionally has no `google-services.json`. Gradle enables Google
Services only when that project-specific file is supplied; without it, FCM push delivery
does not work. See [Push notifications](../reference/push-notifications.md) for the
configuration boundary.

## iOS project contracts

The iOS project uses Swift Package Manager; its generated package declares iOS 16, while
the Xcode deployment target is 16.4 and the renderer requires Safari/iOS 17+. `Info.plist` registers
the `eu.qwky.trinity` auth callback and usage descriptions for camera, photo library,
microphone, and location. iOS terminates an application that calls a protected API without
its usage string, so add the matching plist key before shipping a new native permission.

`MainViewController` owns the local `NativeNavigation` plugin. It coordinates native
Back/Forward gestures with Angular's dialog and panel interception state, beginning in the
safe disabled state until the bridge reports that nothing needs to intercept history.

The host links Firebase Messaging directly through the Xcode project, leaving the
CLI-generated Capacitor package unchanged. `TrinityPushRegistration` guards optional
Firebase configuration and forwards FCM registration tokens through Capacitor's
existing push listener. Capacitor continues to own notification presentation and tap
callbacks. The Push Notifications entitlement selects the signing environment;
operator configuration at `ios/App/App/GoogleService-Info.plist` is optional for builds
and required for push registration. See [iOS push setup](../reference/push-notifications.md#ios-fcm-registration-and-generic-alerts).

iOS keeps the latest delivered APNs badge until Matrix sync or foreground resume
restores the combined unread count. The Badge plugin disables cached-count restoration
and automatic clearing. A background badge is a per-Account snapshot, so zero can
temporarily clear the icon while another Account remains unread. Badge-only delivery
requires the gateway's APNs alert push type with no alert or sound fields; see the
linked push reference for the gateway prerequisite, permission behavior and delivery
limits. No background execution mode or Notification Service Extension is added for
badge reconciliation.

## Package and release boundaries

Android release packaging is `pnpm android:build:release`; configure release signing outside
the checked-in Gradle target before treating its AAB as distributable. iOS distributable
packaging needs a macOS signing identity. These commands create artifacts; they do not authorize
version changes, tags, stores, or publication. Follow
[CI and releases](../maintaining/ci-and-releases.md) for the release process and record
unavailable native OS, SDK, device, or credentials with the command result.
