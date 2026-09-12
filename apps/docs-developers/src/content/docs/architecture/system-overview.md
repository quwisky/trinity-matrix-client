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

Application Runtime owns ordered startup: negotiate the host, hydrate preferences, restore accounts, prepare session capabilities, restore Workspace, then open readiness and ongoing session streams. A feature does not start a parallel application lifetime.

After startup, capability services project authoritative Matrix or host events into read-only signals. Feature components render those signals and invoke finite commands. The result of a command normally returns through the same event projection rather than a second hand-maintained application store.

## How requests move {#request-flow}

A typical room action moves through these boundaries:

1. A feature component invokes a public data-access command.
2. The data-access adapter calls `matrix-js-sdk` for the exact active account and room.
3. SDK events invalidate or reconcile the owned projection.
4. Read-only signals update the `OnPush` UI.
5. Workspace remains responsible for the canonical destination and browser history.

Use [capability ownership](../capability-ownership/) to select the owner, [dependency boundaries](../dependency-boundaries/) before adding an import, and [host capabilities](../host-capabilities/) before branching on an environment.
