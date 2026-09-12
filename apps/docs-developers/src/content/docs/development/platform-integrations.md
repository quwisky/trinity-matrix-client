---
title: Platform integrations
description: Add host-dependent behavior through shared operation contracts and per-host adapters.
audience: developer
contentChannel: develop
canonicalTopic: development-platform-integrations
pageType: how-to
platforms: [web, desktop, android, ios]
---

Platform behavior enters shared application code through Host Runtime contracts. Avoid scattering `Capacitor.isNativePlatform()`, Electron bridge checks, or user-agent branches through features.

## Define the shared operation {#define-operation}

Use the narrowest semantic request and outcome that every host can understand. Add it to the host capability catalogue, including a stable supported or unavailable result and value-safe diagnostics.

The interface returns an Observable when work can fail, be cancelled, or complete asynchronously. Do not expose a native plugin object, Electron IPC channel, browser event, file path, or secret through the application contract.

## Implement each host deliberately {#implement-hosts}

Add browser, Capacitor, and Electron behavior behind the same contract. A host may return `not-supported`; it must not silently select a weaker or unrelated behavior. Electron uses its validated preload bridge, and Capacitor calls remain inside the native adapter layer.

Application Runtime owns negotiation and any cross-capability recovery. A feature consumes the operation without choosing the adapter.

## Validate both shape and runtime {#validate-integration}

Contract tests prove every operation is represented and malformed host data is rejected. Static host guards prove source and packaging boundaries. Then launch every host whose behavior changed; a TypeScript test cannot prove native permissions, operating-system Back, secure storage, file export, or desktop lifecycle.

```bash
pnpm architecture:check
pnpm electron:verify
pnpm android:verify
pnpm ios:verify
```

Read [host capabilities](../../architecture/host-capabilities/) before changing the protocol and [desktop and native tests](../../testing/desktop-and-native-tests/) before claiming host behavior.
