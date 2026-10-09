# Trinity e2e

This is the entry point for running Trinity's browser, host, and protocol journeys. Use
repository commands rather than invoking Playwright or Docker directly: each registered
target owns its build, services, credentials, teardown, and ignored artifacts.

[End-to-end test architecture](../apps/docs-developers/src/content/docs/testing/testing-strategy.md) explains that
ownership model. [Commands](../apps/docs-developers/src/content/docs/reference/commands.md)
is the canonical command list; [Testing](../apps/docs-developers/src/content/docs/testing/component-and-browser-tests.md) explains what a
result proves.

## Choose a task

| You need to check                                           | Start with                                               |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| Pull-request-classified E2E coverage                        | `pnpm e2e`                                               |
| Every required E2E suite available locally                  | `pnpm e2e:all`                                           |
| One product workflow in Chromium                            | `pnpm e2e:browser`, or focused `trinity-e2e-browser:e2e` |
| Production PWA startup, routing, or offline behavior        | `pnpm nx run trinity-e2e-web:production-pwa`             |
| Production Web renderer behavior                            | `pnpm e2e:web`                                           |
| Matrix protocol flow, verification, media, rooms, or search | `pnpm e2e:protocol` or focused `pnpm e2e:<flow>`         |
| Live login discovery smoke                                  | `pnpm smoke:login`                                       |
| Installed Android app behavior                              | `pnpm e2e:mobile`                                        |
| Launched Electron shell behavior                            | `pnpm electron:e2e`                                      |

Install browser binaries before a browser suite:

```bash
pnpm exec playwright install chromium webkit
```

## Before running a suite

Check its prerequisites. Docker is required by homeserver-backed suites unless `TRINITY_E2E_HOMESERVER_RUNTIME=native` runs Synapse and Caddy, plus Dex when `dex` is on `PATH`, as host processes (see the Matrix E2E guide). Android requires a
dedicated API 36 x86_64 emulator, its SDK and JDK 21; Electron needs its separately installed
shell dependencies and a display; iOS needs macOS, Xcode, the pinned iOS Simulator and the native homeserver runtime
(`pnpm e2e:mobile:ios`). The aggregate preflights selected suites.

The disposable homeserver is Tuwunel unless `TRINITY_E2E_HOMESERVER=synapse` selects Synapse
(see the [Matrix E2E guide](../apps/docs-developers/src/content/docs/testing/matrix-e2e-tests.md#choose-homeserver)).
The disposable homeserver stack uses fixed ports and shared state. Run homeserver-backed commands
sequentially, never in parallel. Lifecycle targets and aggregates are uncached and serialized;
let them start and stop their own services. Do not start a competing Docker stack, server,
emulator, or Playwright process. A missing prerequisite is unavailable validation, not a pass.
Every current registered suite except `mobile.ios` is required by the full local gate; `pnpm e2e:all` skips iOS where its preflight fails.

## Focus a canonical browser journey

The canonical browser target remains the owner even when selecting one file or title:

```bash
pnpm nx run trinity-e2e-browser:e2e -- conversations/message-links.spec.mts
pnpm nx run trinity-e2e-browser:e2e -- --grep "message link"
```

The browser suite uses a development build and the disposable homeserver. It cannot prove a
production service worker, installed Android app, or Electron boundary; choose the matching task above
when that boundary matters. Browser specs live directly under
`e2e/browser/journeys/<capability>/`; `node scripts/e2e-suite-registry.mjs check` (part of `pnpm architecture:check`) rejects a spec outside a known
capability folder, a capability folder with no spec, and specs left in the former `e2e/playwright/` root.

## Mobile (Android and iOS)

Playwright owns renderer journeys (`e2e/browser`, including touch and mobile viewport
profiles) and Electron. `pnpm e2e:mobile` runs the WebdriverIO and Appium suite in
`e2e/mobile`, which owns installed-app behavior. It builds the production Capacitor app,
installs it on a validated dedicated emulator, and can clear the test application and change
ADB reverse mappings. Set `TRINITY_ANDROID_SERIAL` only for a disposable dedicated emulator.

Mobile layer rule: a test belongs in `e2e/mobile` only if it needs the installed app (native plugin, OS UI, hardware or system event, deep link). Everything else stays in `e2e/browser`.

- Prerequisites: Android SDK, the `Trinity_API_36` AVD, JDK 21 and Docker (homeserver).
- `pnpm e2e:mobile` installs the pinned UiAutomator2 driver into the repo-local `.appium`
  (`node scripts/setup-appium.mjs` does that step alone), then runs every spec.
- `pnpm e2e:mobile -- --spec e2e/mobile/specs/<file>.e2e.mts` runs one spec.
- Artifacts land in `dist/.playwright/trinity-e2e-mobile/<run-id>/mobile.android/wdio`
  (Appium log, JUnit, failure screenshots and native hierarchies). Text artifacts are
  scrubbed of Matrix ids, tokens and passwords when the run completes.
- CI runs this as two `mobile-e2e` jobs, with no retries. Each selects half the specs
  through `TRINITY_MOBILE_SPECS` (comma-separated paths relative to `e2e/mobile`, listed in
  `.github/workflows/ci.yml`); `TRINITY_MOBILE_SPECS=./specs/smoke.e2e.mts pnpm e2e:mobile`
  narrows a local run the same way.
- iOS: `TRINITY_E2E_HOMESERVER=synapse TRINITY_E2E_HOMESERVER_RUNTIME=native pnpm e2e:mobile:ios`
  on macOS with Xcode, `python3` and `caddy` on `PATH`, plus `dex` (`brew install dexidp`) for the
  SSO spec, which skips without it. It boots (or reuses) the pinned `iPhone 17` on `iOS 26.5`
  (override with `TRINITY_IOS_DEVICE`, `TRINITY_IOS_RUNTIME` or `TRINITY_IOS_UDID`), builds and
  installs the simulator app, trusts the run's Caddy root in the Simulator keychain and installs
  the pinned XCUITest driver. The first session builds
  WebDriverAgent (about 7 minutes) into `dist/ios-wda`. Artifacts land under `mobile.ios/`.
- Platform-only tests call `onlyOn('android' | 'ios', reason)`, which skips with the reason in
  the run log; Back for open panels, attachments, location, notifications and share are
  Android-only.
- CI runs iOS in the `E2E (iOS nightly)` workflow, never on pull requests.

## MSC2545 image-pack management

The image-pack journey is shared by browser and Electron wrappers. It
covers finding a pack, adding and removing an account reference, selecting it in a room,
and sending its sticker against the disposable homeserver. Run its browser copy through the owner:

```bash
pnpm nx run trinity-e2e-browser:e2e -- conversations/stickers-custom-emoji.spec.mts
```

Use Electron when the host boundary is part of the change. Their prerequisites
and cleanup rules still apply.

## Protocol suites and remote mode

Focused protocol commands such as `pnpm e2e:verify`, `pnpm e2e:verify:qr`, and
`pnpm e2e:media` use disposable accounts and the lifecycle-owned stack by default.
Remote mode is opt-in with `TRINITY_E2E_PROTOCOL_MODE=remote` and requires all of
`TRINITY_HS`, `TRINITY_USER`, and `TRINITY_PASS`. The homeserver must be an absolute HTTPS
URL with no embedded credentials. `e2e:rooms` and `e2e:search` also require
`TRINITY_SECONDARY_USER` and `TRINITY_SECONDARY_PASS`; a partial set is rejected before work
starts. The exact validation is owned by [`e2e/protocol/runtime.mts`](protocol/runtime.mts).

Remote mode can create rooms, messages, account data, and encryption state. Use dedicated test
accounts, never a personal account. It keeps normal TLS verification and suppresses traces so
credentials cannot enter artifacts. The aggregate protocol gate remains disposable-only.

## Results and failure handling

Runs write traces, screenshots, reports, and summaries under ignored
`dist/.playwright/` paths. Inspect the first failure and its retained diagnostics before
retrying. A retry can identify a flaky first attempt; it does not make an initial failure
a clean pass. For review, record command, exit status, host, and unavailable prerequisites.

## Where former detail moved

- Suite ownership, fixed-port sequencing, and coverage catalog:
  [E2E architecture](../apps/docs-developers/src/content/docs/testing/testing-strategy.md).
- Exact commands and focused protocol aliases:
  [Commands](../apps/docs-developers/src/content/docs/reference/commands.md).
- Validation choice, source-shape guards, and result limits:
  [Testing](../apps/docs-developers/src/content/docs/testing/component-and-browser-tests.md).
- Web, desktop, Android, and iOS prerequisites:
  [Platforms](../apps/docs-developers/src/content/docs/platforms/web-and-pwa.md).
