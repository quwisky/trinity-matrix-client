---
title: Diagnostics
description: Emit actionable, stable, and secret-safe diagnostic information across capabilities and hosts.
audience: developer
contentChannel: develop
canonicalTopic: reference-diagnostics
pageType: reference
platforms: [web, desktop, android, ios]
---

Diagnostics help identify an owner and recovery action without reproducing user data or host payloads.

## Allowed information {#allowed-diagnostics}

Use stable error or support codes, capability and operation names, bounded timing metrics, counts, terminal status, retry availability, and general recovery guidance. Prefer typed outcomes such as `unavailable`, `rejected`, `partial-cleanup`, or `uncertain-cleanup` over raw exceptions.

## Forbidden information {#forbidden-diagnostics}

Never include access or refresh tokens, recovery keys, encryption secrets, private message bodies, precise location, preference values, raw server responses, complete URLs, account or room identifiers, database names discovered by scanning, file contents, or unfiltered native/SDK exception messages.

Sanitize at the adapter boundary before a failure reaches Application Runtime, UI, telemetry, logs, or a copied support report. Redaction at the final rendering surface is too late.

## Preserve useful ownership {#diagnostic-ownership}

A diagnostic should name the stable capability or host operation responsible and distinguish an expected unavailable state from an unexpected failure. Timeouts describe observation, not cancellation; report an unresolved action as uncertain when the underlying owner may still complete.

## Logs and bug reports {#diagnostic-log}

Trinity keeps no log on the device and uploads none. Console output stays in the console: matrix-js-sdk prints at the level `provideMatrixSdkLogging()` sets (see [configuration](../configuration/)), and nothing records it. Never pass a credential or message content to a logger.

Report a bug opens a GitHub issue pre-filled with the user's description, the build, the platform and each signed-in homeserver's software (`BugReportFactsService` in `@trinity/platform-native`, which reads the accounts and probes each homeserver once), never a server name or an identifier.

Earlier versions kept a diagnostic log in the `trinity-diagnostic-log` IndexedDB database, behind Settings › Advanced › Keep a diagnostic log (`trinity.diagnostics.keep-log`). `RetiredDiagnosticLogCleanup` starts deleting both at every startup, without waiting for the database, so a window of an older build that holds it open never delays startup. The factory reset deletes the database by name too.

Tests should feed hostile secret-shaped values into adapters and prove they do not cross the public outcome. Read [security invariants](../security-invariants/) for enforced boundaries.
