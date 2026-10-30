---
title: System overview
description: Understand how Trinity shares one Angular application across web, desktop, Android, and iOS hosts.
audience: developer
contentChannel: develop
canonicalTopic: architecture-system-overview
pageType: explanation
platforms: [web, desktop, android, ios]
---

Trinity is one end-to-end encrypted Matrix client delivered through four host environments. The Angular application and its libraries are shared; the Web/PWA runs the bundle directly, while Capacitor and Electron package the same root `www/` output.

## Runtime shape {#runtime-shape}

The main parts have distinct responsibilities:

| Part                  | Responsibility                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/trinity`        | Select routes, environment values, lazy features, and application providers                       |
| Application libraries | Coordinate startup, workspace navigation, appearance, search, and badge state across capabilities |
| Data-access libraries | Own product capability state and isolate Matrix SDK access                                        |
| Feature libraries     | Present workflows and connect UI to capability APIs                                               |
| Component libraries   | Provide reusable, domain-neutral Trinity controls and layouts                                     |
| Runtime libraries     | Supply policy-free projection, preference, and host primitives                                    |
| Host adapters         | Translate browser, Capacitor, and Electron behavior into shared host contracts                    |

`provideTrinityApplication()` is the host-neutral composition boundary. It installs zoneless Angular change detection, the router, capability providers, shared UI providers, host capabilities, and the Application Runtime adapter. The application entrypoint supplies routes, environment configuration, build information, and lazy dialog loaders.

## Startup and steady state {#startup-steady-state}

Application Runtime owns ordered startup: negotiate the host, take the session lock (web and PWA), hydrate preferences, restore accounts, prepare session capabilities, restore Workspace, then open readiness and ongoing session streams. A feature does not start a parallel application lifetime.

After startup, capability services project authoritative Matrix or host events into read-only signals. Feature components render those signals and invoke finite commands. The result of a command normally returns through the same event projection rather than a second hand-maintained application store.

### One running tab on the web {#session-lock}

Every tab of one origin shares the same IndexedDB sync and crypto stores, and two tabs running their own Matrix clients on them can duplicate one-time keys, lose room keys and race the sync token. The `session-lock` stage therefore runs after host negotiation and before anything opens a Matrix client, a crypto store or account data: the tab takes the `trinity-session` Web Lock through `SessionLockService` (`@trinity/platform-native`).

- A tab that gets the lock continues startup and keeps the lock for the life of the page.
- A tab that finds it taken queues for the lock (runtime phase `waiting-for-session`). It keeps the startup spinner for 500 ms, so a reloaded tab that is granted its old page's lock a moment later never flashes the notice, and then shows "Trinity is open in another tab". When the holder closes or crashes, the first tab in the queue continues startup by itself from preference hydration; the wait is outside the startup watchdog.
- "Use here" asks the holder on the `trinity-session` `BroadcastChannel`. The holder's `SessionHandoverWorkflow` stops syncing, gives messages and uploads already on their way up to five seconds, stops its clients without wiping anything, closes dialogs, puts text messages that still have not reached the server back into their room or thread draft (`UnsentDraftsWriter`; a reply without its quote, a spoiler as `/spoiler`) and reloads its page in place (`AppRestartService.reload()`). It never releases the lock itself: the browser frees it as the old document unloads, after its clients have stopped. The fresh document waits like any other tab and, when it takes the lock again, lands on the route it showed. Unfinished uploads are dropped. The requesting tab offers "Try again" after 15 seconds and stays queued; if the browser drops a queued request, the tab offers "Try again" too, which queues again.
- Without the Web Locks API (plain HTTP on a LAN address is not a secure context) startup blocks with `session-lock-unavailable` and shows "Trinity needs a secure connection". Trinity never starts without the lock.

The desktop and mobile apps take no lock. Electron allows one instance (`app.requestSingleInstanceLock()`) with one main window and denies new windows. Android runs one `singleTask` activity, and iOS turns multiple scenes off and ships no extension. Whether `capacitor://localhost` is a secure context for Web Locks is unverified, so taking the lock there could block the app.

## How requests move {#request-flow}

A typical room action moves through these boundaries:

1. A feature component invokes a public data-access command.
2. The data-access service calls its capability engine for the exact account and room; the engine's `matrix-js-sdk` adapter is the only code that calls the SDK.
3. The engine reports the resulting change as plain data, which reconciles the owned projection.
4. Read-only signals update the `OnPush` UI.
5. Workspace remains responsible for the canonical destination and browser history.

Use [capability ownership](../capability-ownership/) to select the owner, [dependency boundaries](../dependency-boundaries/) before adding an import, and [host capabilities](../host-capabilities/) before branching on an environment.
