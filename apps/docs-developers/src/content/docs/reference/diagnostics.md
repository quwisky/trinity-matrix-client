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

## On-device diagnostic log {#diagnostic-log}

`@trinity/data-access/diagnostic-log` keeps up to 48 hours or about 5 MB, whichever comes first, of matrix-js-sdk debug output, Trinity's console warnings and errors, uncaught errors and lifecycle markers in IndexedDB on the device, for the user to attach to a bug report. It is the one sanctioned place where identifiers and URLs are kept before redaction, an exception the owner confirmed on 2026-10-12; tokens, keys, passwords, message bodies and precise locations never are.

- **No secrets, ever.** `scrubMessage` runs on every entry before it is buffered, and that is the guarantee: tokens (access, refresh, login, registration, OpenID), `Authorization` and `Cookie` values, passwords and the UIA `auth` dict, OIDC codes, verifiers, states and client secrets, recovery keys and passphrases, secret storage, pickle and backup keys, push keys and device tokens, TURN credentials, message-content fields and precise locations never reach storage, whether they appear in JSON, a query or form string, a header or free text. It fails closed: a value that can't be formatted is stored as `<redacted>`, a message is scrubbed before it is cut to length, and a token straddling a length limit is dropped whole. Typed arrays are stored as their length only. Export redaction is a second line of defence, not the rule. No setting or debug flag turns scrubbing off.
- Matrix IDs, server names and homeserver URLs stay in the on-device store and are replaced when the file is built, by one `createLogRedactor` per file, with stable placeholders such as `@user1:server1`. The preview and the saved file are the same text.
- Settings › Advanced › **Keep a diagnostic log** (on by default, one value per installation and not part of the exported configuration, `KEEP_DIAGNOSTIC_LOG_PREFERENCE`) turns capture off: the SDK sink is detached first, synchronously, so SDK loggers return to the console level, then recording stops and the database is deleted. Turning it on starts a fresh log. A setting that can't be read means off for that session, with the stored log left in place.
- Nothing is uploaded. The user saves the file and attaches it to an issue. A factory reset stops the log before it wipes local data, so no pending write recreates the database, then deletes it and returns the setting to its default. Once the wipes are done, a session that keeps running reads the setting again and, finding it on, starts a fresh log (`resumeAfterReset`) without saving the setting.

Log through `console.warn`, `console.error` or the SDK logger; nothing writes to the store directly. Never pass a credential to a logger, even one the scrubber would mask. A new log format that carries an identifier needs a case in `redaction-corpus.ts`, and one that can carry a secret needs a case in `CAPTURED_SHAPES` (`scrub-secrets.spec.ts`); both tests fail when something survives.

Tests should feed hostile secret-shaped values into adapters and prove they do not cross the public outcome. Read [security invariants](../security-invariants/) for enforced boundaries.
