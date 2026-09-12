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

`apps/trinity/src/environments/` selects production mode and an optional native push gateway configuration. Production builds replace the development environment file through the `trinity` target. The default push value is `null`, which leaves native push disabled.

A push gateway URL and public application identifier are configuration; FCM/APNs credentials and deployment procedures are not application source and do not belong in public documentation.

## Capacitor host {#capacitor-host}

Root `capacitor.config.ts` owns application ID `eu.qwky.trinity`, application name `Trinity`, and `webDir: 'www'`. Keyboard resize is explicitly native so the WebView viewport follows the on-screen keyboard.

Electron owns a separate package and build configuration. Each native project receives the shared renderer through its Nx synchronization target.

## Portable settings {#portable-settings}

The configuration service exports only registered preference descriptors in a versioned JSON document. It validates the whole document before applying changes through owning service setters. Accounts, tokens, drafts, push ledgers, and other recovery-critical state are not portable settings.

Sensitive preferences declare storage and export restrictions. Never add a key to export merely because it appears in local storage. Read [security invariants](../security-invariants/) before changing configuration scope.
