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
- The same redactor replaces email addresses (`email1@example.invalid`) and the names this device knows: room names (`Room 1`), room topics (`Topic 1`) and the display names of joined, invited, left and banned members, the user's own included (`Person 1`). `createLogRedactor` learns the whole file first, then `learnNames` reads the names from `DIAGNOSTIC_ACCOUNT_SOURCE.knownNames()`, which Application Runtime implements with `SessionEngine.knownNames`, a group per room, from every live account's engine. The engine returns them all once, after the log is read, and the export indexes them in slices, every room name and topic before any display name; it never stores or logs them. A source that fails, answers nothing or takes over 10 seconds leaves the names unreplaced, and the file says so. Each name is matched in every spelling a line may carry: NFC and NFD, escaped for JSON (also as `\u00e9` escapes) or a URL, with its Matrix IDs and server names already replaced, and line by line for a multi-line topic, all as one placeholder. A spelling is kept only if its words occur in the file once IDs are replaced (so a localpart alone doesn't count), at most 1,000 display names per room and 20,000 names in all. A topic longer than 16 units, or another name longer than 512, is found by its start and replaced over as much of it as the line repeats, so a topic logged cut short is replaced too, where the line ends or `…` (as in Trinity's `… [N characters truncated]`), a quote or a closing bracket follows the cut. A line that goes on with other text after the topic's start (`Failed to decrypt event` or `Failed to decrypt: OlmError` against a topic `Failed to decrypt? …`) is left alone. Matching is exact, as whole words where a name starts or ends with a letter or digit of a space-separated script (Han, kana, Thai and similar scripts are exempt), never cutting into a placeholder, by a linear Aho–Corasick matcher rather than a pattern built from the names. Names shorter than 3 characters, names without a letter, and log or everyday words such as `sync`, `error` or `the` are left alone.
- What is not replaced: a name spelled with different letter case; a name this device doesn't know; part of a name quoted on its own (a single word of a room name, or less than the first 16 units of a topic, or a cut topic followed by anything but the line's end, `…`, a quote or a closing bracket); names beyond the caps, in which case the file's header says that some names were not replaced; names crafted so that more than 32 of them, or more than 8 sharing their first units, compete at one position; and file names or other free text. The dialog asks the user to check the preview before attaching the log to a public issue.
- Settings › Advanced › **Keep a diagnostic log** (on by default, one value per installation and not part of the exported configuration, `KEEP_DIAGNOSTIC_LOG_PREFERENCE`) turns capture off: the SDK sink is detached first, synchronously, so SDK loggers return to the console level, then recording stops and the database is deleted. Turning it on starts a fresh log. A setting that can't be read means off for that session, with the stored log left in place.
- Where IndexedDB can't be opened within 5 seconds, capture carries on in memory and tries the database again at the next write after 30 seconds, 2 minutes and 10 minutes. Clear diagnostic logs and turning the log off delete or empty the database itself, never only the memory copy, and fail visibly while it may still hold a log.
- The export code (bundle builder and redactor) loads on demand, outside the initial bundle, and builds the file in slices of about 8 ms so a full log doesn't freeze the UI. The issue URL builder stays in the initial bundle, so if the export chunk fails to load, the report still opens GitHub with the facts and says there is no log. One report reads the accounts, and probes each homeserver, once.
- Nothing is uploaded. The user saves the file and attaches it to an issue. A factory reset stops the log before it wipes local data, so no pending write recreates the database, then deletes it and returns the setting to its default. Once the wipes are done, a session that keeps running reads the setting again and, finding it on, starts a fresh log (`resumeAfterReset`) without saving the setting.

Log through `console.warn`, `console.error` or the SDK logger; nothing writes to the store directly. Never pass a credential to a logger, even one the scrubber would mask. A new log format that carries an identifier needs a case in `redaction-corpus.ts`, and one that can carry a secret needs a case in `CAPTURED_SHAPES` (`scrub-secrets.spec.ts`); both tests fail when something survives.

Tests should feed hostile secret-shaped values into adapters and prove they do not cross the public outcome. Read [security invariants](../security-invariants/) for enforced boundaries.
