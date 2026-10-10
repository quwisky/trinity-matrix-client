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

## Package a native plugin {#native-plugins}

A Capacitor plugin that Trinity writes for both hosts is a pnpm workspace package under `libs/native/`, listed in `pnpm-workspace.yaml` and required by the root `package.json` with `workspace:*`. The Capacitor CLI finds plugins only among installed dependencies, so this is the one exception to wiring libraries through `@trinity/*` aliases alone: its TypeScript is still imported through its alias, it keeps an Nx `project.json` with tags like any library, and it declares no dependencies of its own. Synchronization adds its Android module and Swift package to the hosts and registers the plugin class, so a host never registers it by hand. On iOS, discovery is textual: Capacitor registers the class named by the first `@objc(Name)` in each `.swift` file under the package's `ios/` directory, so keep one plugin per file with that annotation first. The class must be `public` and subclass `CAPPlugin`, because automatic registration skips `CAPInstancePlugin` subclasses. `@trinity/capacitor-push` in `libs/native/capacitor-push` is the example; its `package.json` `capacitor` field names its `android` and `ios` directories.

A small plugin that belongs to one host, such as `AppSettingsPlugin`, stays in that host project and is registered there.

## Validate both shape and runtime {#validate-integration}

Contract tests prove every operation is represented and malformed host data is rejected. Static host guards prove source and packaging boundaries. Then launch every host whose behavior changed; a TypeScript test cannot prove native permissions, operating-system Back, secure storage, file export, or desktop lifecycle.

```bash
pnpm architecture:check
pnpm electron:verify
pnpm android:verify
pnpm ios:verify
```

Read [host capabilities](../../architecture/host-capabilities/) before changing the protocol and [desktop and native tests](../../testing/desktop-and-native-tests/) before claiming host behavior.
