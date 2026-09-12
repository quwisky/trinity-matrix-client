---
title: Desktop and native tests
description: Separate static host checks from launched Electron, Android, and iOS evidence.
audience: developer
contentChannel: develop
canonicalTopic: testing-desktop-native
pageType: how-to
platforms: [desktop, android, ios]
---

Host validation has two levels: static contracts and behavior in a launched host. Use both when a change reaches a bridge, plugin, lifecycle, packaging, or native presentation path.

## Check host contracts {#static-host-checks}

```bash
pnpm electron:verify
pnpm android:verify
pnpm ios:verify
pnpm architecture:check
```

These checks can prove source boundaries, manifests, bridge shape, and packaging configuration. They cannot prove an operating-system permission prompt, native Back, secure storage, app lifecycle, an Electron window, or an installed WebView.

## Launch the affected host {#launched-host}

```bash
pnpm electron:e2e:smoke
pnpm electron:e2e
pnpm e2e:android
pnpm nx run trinity-ios:verify-native
```

Electron needs its separate dependencies and a usable display. Android needs the SDK and a managed emulator or device. iOS validation needs macOS and Xcode. Use the platform-specific project target to inspect exact prerequisites and outputs.

Browser mobile emulation provides useful responsive evidence but does not establish Capacitor, WebView, plugin, or native operating-system behavior. An unsigned simulator build proves something different from a signed device package; state that distinction in review evidence.

## Keep proof outside the repository {#host-proof}

Store screenshots, traces, simulator logs, and temporary packages in ignored output. Report which host and build configuration ran, the command and result, and every affected host that remained unavailable.

Read [platform integrations](../../development/platform-integrations/) before changing a bridge and [diagnose failures](../diagnose-failures/) before repeating a failed run.
