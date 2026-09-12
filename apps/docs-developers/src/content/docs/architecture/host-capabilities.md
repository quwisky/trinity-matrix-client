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

The protocol-versioned host manifest covers authentication handoff, deep links, Back, file export, notification presentation, location, badges, secure storage, lifecycle, and update checks. Every operation reports `supported` or a stable unavailable reason such as `not-supported` or `protocol-mismatch`.

Unsupported and disabled behavior is an expected state. Do not infer support from the user agent, a global object, screen size, or the presence of one unrelated plugin.

## Keep operations narrow {#narrow-operations}

Each operation has its own interface and Observable outcome. This prevents one broad bridge from exposing platform internals to product code and lets a host support only the operations it implements.

Electron renderer code crosses a validated preload bridge. Capacitor adapters wrap native plugins. The Web adapter supplies browser behavior or an explicit unavailable result. Application Runtime combines these results into startup and recovery state without leaking raw host errors.

## Preserve semantic inputs {#semantic-inputs}

Pass a semantic destination to deep-link, notification, and Back flows. Treat values received from a host as untrusted input and validate them before applying them to Workspace or a Matrix operation. A host diagnostic contains a stable code, never a URL, token, file content, account ID, or native exception payload.

## Add or change an operation {#change-operation}

Update the shared contract first, then each host adapter and its contract tests. Keep the application consumer host-neutral. Run the host architecture guards in addition to the affected unit and launched-host checks:

```bash
pnpm architecture:check
```

Static checks can prove contract shape and adapter selection; only the actual browser, Electron process, emulator, simulator, or device proves host behavior.

Read [system overview](../system-overview/) for composition and [workspace and navigation](../workspace-and-navigation/) for deep-link ownership.
