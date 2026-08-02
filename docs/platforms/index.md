# Platforms

Trinity ships four applications from one Angular codebase. The seam that makes that work
is a single directory: the production web build emits into the repository-root `www/`, and
every other target wraps that directory unchanged.

```text
apps/trinity + libs/*  --(nx build trinity)-->  www/
                                                 |
                          +----------------------+----------------------+
                          |                      |                      |
                     served as-is        electron/scripts/copy-www   cap sync
                     (web / PWA)         -> electron/www             -> android/ ios/
```

Nothing downstream of `www/` recompiles the app. Electron copies the directory and serves
it over a custom scheme; Capacitor copies it into the native projects and loads it in a
WebView. There is no per-platform fork of the timeline, the room list, or the crypto.

## What each target is built with

| Target  | Wrapper                                   | Build command                                             | Artifact                                                 |
| ------- | ----------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| Web     | none                                      | `pnpm build`                                              | static bundle in `www/`                                  |
| Desktop | hand-rolled Electron shell in `electron/` | `pnpm electron:package` or a named `:mac`/`:linux`/`:win` | dmg, zip, AppImage, deb, nsis exe in `electron/release/` |
| Android | Capacitor                                 | `pnpm android:build`                                      | debug APK from Gradle                                    |
| iOS     | Capacitor                                 | `pnpm ios:build`                                          | Xcode build of the `App` scheme                          |

Each of the desktop and mobile scripts runs `pnpm build` first, so they always package a
freshly produced `www/`. `pnpm build` has no configuration argument and
`defaultConfiguration` is `production`, which means every desktop and native script builds
production — including during development.

## Detecting the platform

This is the single detail that trips people who have worked with Capacitor before.

**`Capacitor.isNativePlatform()` returns `false` inside the Electron desktop shell, and
`Capacitor.getPlatform()` returns `'web'` there.** Trinity has no Capacitor desktop
bridge. The Electron shell loads the plain web build, so from Capacitor's point of view it
is a browser. Code that gates a native capability on `isNativePlatform()` silently takes
the web branch on desktop, which is usually correct and occasionally catastrophic.

Desktop is detected through the preload marker instead:

| Question                     | How to answer it                                                    |
| ---------------------------- | ------------------------------------------------------------------- |
| Is this a native mobile app? | `Capacitor.isNativePlatform()`                                      |
| Which mobile OS is this?     | `Capacitor.getPlatform()`, which is `'ios'`, `'android'` or `'web'` |
| Is this the desktop shell?   | `getTrinityDesktopBridge()?.isElectron === true`                    |

`getTrinityDesktopBridge()` lives in
[libs/platform-native/src/lib/trinity-desktop-bridge.ts](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/platform-native/src/lib/trinity-desktop-bridge.ts)
and returns the typed `trinityDesktop` global the Electron preload exposes, or `undefined`
everywhere else. Every member of that interface is optional, so callers feature-detect
before calling.

The service worker registration in
[apps/trinity/src/main.ts](https://github.com/quwisky/trinity-matrix-client/blob/develop/apps/trinity/src/main.ts)
is the clearest illustration of why both checks are needed:

```ts
provideServiceWorker('ngsw-worker.js', {
  enabled: environment.production && !Capacitor.isNativePlatform() && !isElectron,
  registrationStrategy: 'registerWhenStable:30000',
});
```

Without the `!isElectron` term the desktop app would install a second cache layer over
files it already loads from local disk.

## Where the differences live

Platform branches are concentrated in a small number of services rather than sprinkled
through feature code. If you are adding a capability that behaves differently per target,
one of these is probably where it belongs.

| Concern                     | Owner                                                               | How it splits                                                                                                   |
| --------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Secret storage              | `SecureStorageService` in `@trinity/platform-native`                | Electron `safeStorage` over IPC, then native Keychain and Keystore, then plaintext on web                       |
| Notification delivery       | `NotificationService` in `@trinity/data-access/notifications`       | No-op on mobile because push owns delivery there; main-process notification on desktop; Web Notification on web |
| Push registration           | `PushService`                                                       | Gated on `getPlatform()` being `'ios'` or `'android'`                                                           |
| App icon badge              | `AppBadgeService`, `MobileBadgeService`                             | Preload `setBadgeCount` on desktop, `@capawesome/capacitor-badge` on mobile                                     |
| Native chrome               | `ThemeService`                                                      | Sets the Capacitor status-bar style on native only                                                              |
| Deep link intake            | `AppComponent` in `@trinity/feature-shell`                          | Preload `onDeepLink` on desktop, `@capacitor/app` `appUrlOpen` on mobile, the `/sso-callback` route on web      |
| Media capture and file save | `MediaPickerService`, `FileSaveService` in `@trinity/feature-rooms` | Native plugins only, with a browser fallback elsewhere                                                          |

## Read next

- [Web](web.md) — the Angular build, the output layout, the CSP and the service worker
- [Desktop](desktop.md) — the Electron shell, its scheme, its IPC surface and its packaging
- [Mobile](mobile.md) — Capacitor configuration, the plugin set, and the native projects
