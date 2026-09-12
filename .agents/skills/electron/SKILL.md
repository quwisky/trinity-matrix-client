---
name: electron
description: 'Electron desktop-host work in Trinity: bridge a supported host capability, diagnose shell behavior, or package the existing shell. Use for Electron, desktop IPC, secure storage, deep links, signing, or desktop release work.'
allowed-tools: Read, Grep, Glob, Write, Edit
---

# Trinity Electron

Use this reference for the hand-rolled Electron shell in `electron/`. Start
with the [desktop guide](../../../apps/docs-developers/src/content/docs/platforms/electron.md) for prerequisites,
build, launch, debugging, and package commands. Use the
[architecture guide](../../../apps/docs-developers/src/content/docs/architecture/host-capabilities.md) to keep host adapters
and application capabilities in their owners.

## Choose the existing seam

1. Identify the product operation in `@trinity/runtime/host` and its selected
   adapter in `@trinity/platform-native` before touching Electron.
2. Follow it through the small `trinityDesktop` preload surface, the main
   process handler, and its tests. The renderer does not receive Node,
   filesystem, or raw IPC access.
3. Keep the operation negotiated and typed. Unsupported operations are reported
   as unavailable; they are not a reason to add a broad desktop escape hatch.
4. Select proof for the changed boundary. A unit contract does not prove a
   launched shell; use the [desktop validation guidance](../../../apps/docs-developers/src/content/docs/testing/desktop-and-native-tests.md)
   and record unavailable host evidence.

Use [IPC and bridge safety](ipc-security.md) for a bridge or permission change,
[secure storage and host ownership](backend.md) for secret or host-service
work, and [packaging](packaging.md) for artifacts and signing.

## Current desktop contract

The renderer is served from the privileged `trinity://app` scheme, rather than
`file://`; the separate `eu.qwky.trinity://` scheme is an OS deep-link callback.
The main process owns the window, protocol, native integrations, and the
capability negotiation endpoint. See the implementation in
[`main.ts`](../../../electron/src/main.ts),
[`scheme.ts`](../../../electron/src/scheme.ts), and
[`host-capabilities.ts`](../../../electron/src/host-capabilities.ts).

Keep the public UI boundary intact: feature code consumes
`@trinity/components/*`, Matrix access remains in data-access libraries, and
host behavior travels through capability contracts rather than Electron imports.
