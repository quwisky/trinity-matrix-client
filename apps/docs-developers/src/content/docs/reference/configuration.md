---
title: Configuration
description: Understand Trinity's build-time environment, Capacitor host, and portable settings configuration boundaries.
audience: developer
contentChannel: develop
canonicalTopic: reference-configuration
pageType: reference
platforms: [web, desktop, android, ios]
---

Configuration is split by owner. Do not create a second general-purpose environment object or expose deployment secrets through public settings.

## Build-time environment {#build-environment}

`apps/trinity/src/environments/` selects production mode and an optional native push gateway configuration. Production builds replace the development environment file through the `trinity` target. Both environments point at the Trinity push gateway (`https://push.trinityproject.dev/_matrix/push/v1/notify`); a fork can set its own URL, or `null` to build without native push. Push is build configuration only: there is no per-device gateway setting.

Production mode also sets matrix-js-sdk console logging. `main.ts` passes `matrixSdkLogLevel` to `provideTrinityApplication()`, which applies it through `provideMatrixSdkLogging()` from `@trinity/data-access/matrix-client` before any client is created. Production builds, including the Web and Electron renderer, log the SDK's warnings and errors only. Development builds keep its debug and info output, which covers sync, crypto and request details. To see that output, use a development build.

Console verbosity does not limit what Trinity keeps for bug reports. `provideTrinityApplication()` starts the on-device diagnostic log from `@trinity/data-access/diagnostic-log` and gives `provideMatrixSdkLogging()` a sink through `MATRIX_SDK_LOG_SINK`, so the SDK's debug lines are stored in every build while the console stays at the configured level. With Settings › Advanced › Keep a diagnostic log off, or unreadable, `DiagnosticLogService` detaches the sink at once through `DIAGNOSTIC_SDK_CAPTURE`, and the SDK runs at the configured level only. See [diagnostics](../diagnostics/#diagnostic-log).

`issueTracker.repositoryUrl` names the GitHub repository in which Report a bug opens a pre-filled issue, from Settings › Advanced, the sign-in screen, System status and the desktop title bar alike. A fork sets its own repository, or `null` to leave the GitHub step out.

A push gateway URL and public application identifier are configuration; FCM/APNs credentials and deployment procedures are not application source and do not belong in public documentation.

## Capacitor host {#capacitor-host}

Root `capacitor.config.ts` owns application ID `dev.trinityproject.trinity`, application name `Trinity`, and `webDir: 'www'`. Keyboard resize is `none` on iOS, where the app shrinks itself in step with the on-screen keyboard through `--trinity-keyboard-inset`, and `ios.scrollEnabled: false` pins the WebView's own scroll view so WebKit cannot scroll the page to reveal a focused field. Android ignores `resize` and keeps resizing the WebView.

Capacitor wires the native plugins it finds among the root `package.json` dependencies. Trinity's own push plugin is one of them: the workspace package `@trinity/capacitor-push`, which `pnpm install` links from `libs/native/capacitor-push`.

Capacitor logging is off in every build (`loggingBehavior: 'none'`), CI included. When it is on, the bridge writes each plugin call's arguments (Android) and the start of each result (iOS) to the device log, and those include access tokens and stored sessions. Off also silences Capacitor's own native error messages and the WebView console forwarded to logcat. For a local debugging build that needs them, set `TRINITY_CAPACITOR_LOGS=1` when the native project is synchronized, for example `TRINITY_CAPACITOR_LOGS=1 pnpm android:run` or `TRINITY_CAPACITOR_LOGS=1 pnpm ios:run`, and synchronize again without it afterwards. A debug build's WebView stays inspectable through Chrome's `chrome://inspect` or Safari's Web Inspector either way.

Electron owns a separate package and build configuration. Each native project receives the shared renderer through its Nx synchronization target.

## Portable settings {#portable-settings}

The configuration service exports only registered preference descriptors in a versioned JSON document. It validates the whole document before applying changes through owning service setters. The export format is version 4; an older file that still carries `push.gateway` imports with that entry ignored and a warning. Accounts, tokens, drafts, and other recovery-critical state are not portable settings.

Sensitive preferences declare storage and export restrictions. Never add a key to export merely because it appears in local storage. Read [security invariants](../security-invariants/) before changing configuration scope.
