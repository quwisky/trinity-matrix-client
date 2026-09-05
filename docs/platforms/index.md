# Run, debug and package a host

Choose the environment you need to build or investigate. Trinity shares one Angular renderer
across Web/PWA, Electron, Android and iOS; host capabilities determine what that renderer can
do in each environment. End users should start with [Installing Trinity](../users/install.md).
Contributors first need the [checkout setup](../contributing/getting-started.md).

## Choose your workflow

| Host     | Guide                                                         | Additional prerequisites                                                                  | Local artifact                                                            |
| -------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Web/PWA  | [Run and deploy web](web.md)                                  | Browser; Playwright Chromium for PWA acceptance                                           | Root `www/` static bundle                                                 |
| Electron | [Run and package desktop](desktop.md)                         | Separate shell dependencies; display for launch; platform packaging tools                 | `electron/dist/`, copied `electron/www/`, packages in `electron/release/` |
| Android  | [Build and debug mobile](mobile.md#android-project-contracts) | Android SDK, JDK and appropriate emulator/device for launch                               | Debug APK or release AAB under `android/app/build/outputs/`               |
| iOS      | [Build and debug mobile](mobile.md#ios-project-contracts)     | macOS and Xcode for native builds; signing access for applicable distribution/device work | `ios/App/output/` IPA export; simulator compilation is separate           |

The guides cover build/sync, launch, diagnosis and packaging. The
[command reference](../contributing/commands.md) owns shared aliases and target selection;
[maintainer guidance](../maintaining/index.md) owns release and publication policy.

## What each target is built with

The renderer build emits root `www/` with `index.html` directly inside it. Electron copies
that directory and serves it locally; Capacitor sync copies it into the native projects.
These wrappers do not maintain separate Angular feature implementations.

```text
apps/trinity + libs → trinity:build → www/
                                      ├─ HTTPS static host / PWA
                                      ├─ Electron copy → electron/www/
                                      └─ Capacitor sync → Android / iOS assets
```

Ordinary host build/sync targets depend on the renderer build. Some validation and release
paths intentionally consume a prebuilt artifact under an explicit manifest contract; inspect
resolved target dependencies before assuming a command rebuilds it. Installation, static
verification and opening an IDE are distinct operations. See [web output](web.md#where-the-build-output-goes).

## Detecting the platform

Product code consumes the operations in `@trinity/runtime/host` instead of independently
choosing browser or plugin behavior. Selection and bridge negotiation belong to
[the host capability adapters](../../libs/platform-native/src/lib/host-capabilities/host-capability.adapters.ts).

Electron has no Capacitor bridge, so Capacitor reports it as web. The typed Electron preload
marker distinguishes the desktop renderer; the grouped protocol bridge is negotiated before
its operations are used. Do not restore old loose optional-method probing from legacy guides.
A capability can be unavailable even when the host is recognized.

The production web service worker uses both installed-native and Electron checks, preventing
a second cache layer over bundled host assets. OS identity and pointer capability answer
different questions: an iOS/Android interaction convention is not implied by a touchscreen
on a desktop system. See [UI and theming](../architecture/ui-and-theming.md).

## Where the differences live

Host operations have explicit support and completion/rejection outcomes. Application Runtime
owns their session lifetime, and product capabilities decide what an unavailable operation
means for the user. Preserve those boundaries when adding or debugging host behavior.

| Concern                               | Start with                                                                                         | What to check                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Authentication handoff and deep links | [Host operations](../../libs/platform-native/src/lib/host-capabilities/host-operation.adapters.ts) | Browser navigation versus native/external authorization, callback intake and negotiated bridge support |
| Back and lifecycle                    | Host capability adapters and Application Runtime                                                   | Host intents, foreground/background events and Workspace handling                                      |
| Files, location and notifications     | Host operation and notification adapters                                                           | Available APIs, permissions and typed failure outcomes; mobile push is separate from presentation      |
| Secure storage                        | Host capabilities and the platform storage adapter                                                 | OS backend availability and the documented fallback; host recognition does not prove secure storage    |
| Unread badges                         | Host badge adapters and the badge coordinator                                                      | Browser API/bridge/plugin support and the aggregate unread projection                                  |
| Updates                               | Application Runtime and host update operation                                                      | Production web service-worker updates; explicit unavailability on bundled hosts                        |

The current lifecycle adapter derives foreground/background events from document visibility
on all three host families; it does not promise work can continue after an OS terminates the
process. Web authentication navigates in the browser, while mobile and desktop hand off to an
external authorization surface. Host Back is Android-specific; browser routing and desktop
window behavior remain separate. Browser file export is also used on desktop, while mobile
uses cache-and-share when its plugins are available.

Follow the [web](web.md), [desktop](desktop.md) and [mobile](mobile.md) guides for concrete
behavior and limits. User-facing notification behavior is described in
[Notifications](../users/notifications.md); encryption and recovery remain in
[the encryption guide](../users/encryption.md).

## Match the check to the claim

| Check                                         | Evidence it provides                                            | What it does not prove                                              |
| --------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| Static desktop/Android/iOS `verify` target    | Configuration, artifacts and capability contract shape          | A running host or working OS permission                             |
| Development browser journey                   | The selected product workflow in a browser                      | Production PWA or installed native behavior                         |
| Production PWA target                         | Built shell, routing, service worker and offline asset behavior | Real installation offers, authenticated Matrix flows or mobile push |
| Launched Electron smoke/full suite            | Actual shell, bridge and renderer behavior for selected cases   | Signing, notarization or another operating system                   |
| Android native verification / WebView journey | Gradle tests or installed WebView behavior, respectively        | iOS behavior or a release signing path                              |
| iOS native verification                       | Simulator compilation on macOS/Xcode                            | A signed device launch or App Store distribution                    |

Static host checks can run on Linux, including the iOS static contract. Native iOS tools
require macOS. A skipped or unavailable environment is a limitation, not a successful check.
Use [testing](../contributing/testing.md) and the [E2E router](../../e2e/README.md) for the
execution lifecycle, fixed-port sequencing and retained diagnostics.

## Read next

- [Web/PWA](web.md) — local startup, static deployment and offline/update behavior
- [Desktop](desktop.md) — Electron launch, debugging, protocol and packaging
- [Mobile](mobile.md) — Android/iOS sync, tooling, device workflows and capability limits
- [Maintaining Trinity](../maintaining/index.md) — release ownership and publication
