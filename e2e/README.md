# Trinity e2e

This is the entry point for running Trinity's browser, host, and protocol journeys. Use
repository commands rather than invoking Playwright or Docker directly: each registered
target owns its build, services, credentials, teardown, and ignored artifacts.

[End-to-end test architecture](../docs/contributing/e2e-architecture.md) explains that
ownership model. [Commands](../docs/contributing/commands.md#end-to-end-and-protocol-checks)
is the canonical command list; [Testing](../docs/contributing/testing.md) explains what a
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
| Installed Android WebView behavior                          | `pnpm e2e:android`                                       |
| Launched Electron shell behavior                            | `pnpm electron:e2e`                                      |

Install browser binaries before a browser suite:

```bash
pnpm exec playwright install chromium webkit
```

## Before running a suite

Check its prerequisites. Docker is required by Synapse-backed suites. Android requires a
dedicated API 36 x86_64 emulator and its SDK; Electron needs its separately installed
shell dependencies and a display; iOS needs macOS and Xcode but has no installed-WebView
Playwright runner. The aggregate preflights selected suites.

The disposable Synapse stack uses fixed ports and shared state. Run Synapse-backed commands
sequentially, never in parallel. Lifecycle targets and aggregates are uncached and serialized;
let them start and stop their own services. Do not start a competing Docker stack, server,
emulator, or Playwright process. A missing prerequisite is unavailable validation, not a pass.
Every current registered suite is required by the full local gate.

## Focus a canonical browser journey

The canonical browser target remains the owner even when selecting one file or title:

```bash
pnpm nx run trinity-e2e-browser:e2e -- conversations/message-links.spec.mts
pnpm nx run trinity-e2e-browser:e2e -- --grep "message link"
```

The browser suite uses a development build and disposable Synapse. It cannot prove a
production service worker, Android, or Electron boundary; choose the matching task above
when that boundary matters. Browser journeys are cataloged by one capability and one primary
contract type; add or move a spec with its `e2e/browser/journey-catalog.mts` entry.

## Android WebView journeys

`pnpm e2e:android` builds the production Capacitor app, installs it on a validated
dedicated emulator, and runs shared browser journeys in the app's WebView plus Android-only
checks. It can clear the test application and change ADB reverse mappings. Set
`TRINITY_ANDROID_SERIAL` only for a disposable dedicated emulator. See
[E2E architecture](../docs/contributing/e2e-architecture.md#lifecycle-and-resource-ownership)
for ownership and cleanup limits.

## MSC2545 image-pack management

The image-pack journey is shared by browser, Android WebView, and Electron wrappers. It
covers finding a pack, adding and removing an account reference, selecting it in a room,
and sending its sticker against disposable Synapse. Run its browser copy through the owner:

```bash
pnpm nx run trinity-e2e-browser:e2e -- conversations/stickers-custom-emoji.spec.mts
```

Use Android or Electron when the host boundary is part of the change. Their prerequisites
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
  [E2E architecture](../docs/contributing/e2e-architecture.md).
- Exact commands and focused protocol aliases:
  [Commands](../docs/contributing/commands.md#end-to-end-and-protocol-checks).
- Validation choice, source-shape guards, and result limits:
  [Testing](../docs/contributing/testing.md).
- Web, desktop, Android, and iOS prerequisites:
  [Platforms](../docs/platforms/index.md).
