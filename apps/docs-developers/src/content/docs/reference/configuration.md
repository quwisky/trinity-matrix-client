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

A push gateway URL and public application identifier are configuration; FCM/APNs credentials and deployment procedures are not application source and do not belong in public documentation.

## Capacitor host {#capacitor-host}

Root `capacitor.config.ts` owns application ID `dev.trinityproject.trinity`, application name `Trinity`, and `webDir: 'www'`. Keyboard resize is explicitly native so the WebView viewport follows the on-screen keyboard.

Electron owns a separate package and build configuration. Each native project receives the shared renderer through its Nx synchronization target.

## Portable settings {#portable-settings}

The configuration service exports only registered preference descriptors in a versioned JSON document. It validates the whole document before applying changes through owning service setters. The export format is version 4; an older file that still carries `push.gateway` imports with that entry ignored and a warning. Accounts, tokens, drafts, and other recovery-critical state are not portable settings.

Sensitive preferences declare storage and export restrictions. Never add a key to export merely because it appears in local storage. Read [security invariants](../security-invariants/) before changing configuration scope.
