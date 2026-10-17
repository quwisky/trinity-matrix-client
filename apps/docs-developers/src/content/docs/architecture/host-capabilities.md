---
title: Host capabilities
description: Use negotiated browser, Capacitor, and Electron operations without scattering platform checks.
audience: developer
contentChannel: develop
canonicalTopic: architecture-host-capabilities
pageType: explanation
platforms: [web, desktop, android, ios]
---

Trinity models platform behavior as narrow host operations. Application and feature code consume those contracts; the selected browser, Capacitor, or Electron adapter decides whether and how an operation is supported.

## Negotiate once, consume explicit support {#capability-manifest}

The protocol-versioned host manifest covers authentication handoff, deep links, Back, file export, notification presentation, location, badges, secure storage, lifecycle, update checks, the desktop title bar (overlay colours, the application menu, the system-title-bar preference and relaunch), and App lock's user presence (the system prompt and the Trinity PIN), lock integration (the desktop menu item, power events and the hold before showing a window hidden while App lock is on) and screen privacy (the mobile app-switcher cover, which reports whether it also blocks screen capture, and the dismissal of native UI Trinity presented, on each lock). Every operation reports `supported` or a stable unavailable reason such as `not-supported` or `protocol-mismatch`.

Unsupported and disabled behavior is an expected state. Do not infer support from the user agent, a global object, screen size, or the presence of one unrelated plugin.

## Keep operations narrow {#narrow-operations}

Each operation has its own interface and Observable outcome. This prevents one broad bridge from exposing platform internals to product code and lets a host support only the operations it implements.

An outcome is `completed`, `unavailable` or `rejected`. File export adds `cancelled`: the host reported the native share sheet as dismissed, so it may not have saved anything. On Android this also covers a share target that kept Trinity in the foreground, such as Copy. Consumers report neither success nor failure for it. Browser and desktop downloads cannot observe a cancel, so they never return it.

Electron renderer code crosses a validated preload bridge. Capacitor adapters wrap native plugins. The Web adapter supplies browser behavior or an explicit unavailable result. Application Runtime combines these results into startup and recovery state without leaking raw host errors.

## Preserve semantic inputs {#semantic-inputs}

Pass a semantic destination to deep-link, notification, and Back flows. Treat values received from a host as untrusted input and validate them before applying them to Workspace or a Matrix operation. A host diagnostic contains a stable code, never a URL, token, file content, account ID, or native exception payload.

The app opens a room from `dev.trinityproject.trinity://matrix.to/#/<room id or alias>[/<event id>][?via=...]`, which is a matrix.to link behind the app scheme. The host navigation adapter validates it with `parseTrinityRoomLink` and leaves it in `InboundRoomLinkService`; the Rooms shell then opens it as it opens a tapped matrix.to link, with the `deep-link` origin. A link that arrives while signed out waits for the Rooms shell. Android cannot route https `matrix.to` links to the app, because App Link verification needs assetlinks on that domain. On desktop, Trinity Next registers `dev.trinityproject.trinity.next` instead: the Electron host adapter moves its links back onto `dev.trinityproject.trinity:` before the host navigation adapter parses them, drops links on stable's scheme, and sends sign-in callbacks to the app's own scheme (see [release channels](../../platforms/electron/#release-channels)).

## Add or change an operation {#change-operation}

Update the shared contract first, then each host adapter and its contract tests. Keep the application consumer host-neutral. Run the host architecture guards in addition to the affected unit and launched-host checks:

```bash
pnpm architecture:check
```

Static checks can prove contract shape and adapter selection; only the actual browser, Electron process, emulator, simulator, or device proves host behavior.

Read [system overview](../system-overview/) for composition and [workspace and navigation](../workspace-and-navigation/) for deep-link ownership.
