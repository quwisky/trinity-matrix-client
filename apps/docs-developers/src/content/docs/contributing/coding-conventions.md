---
title: Coding conventions
description: Follow Trinity's Angular, import, state, style, testing, and compatibility rules.
audience: developer
contentChannel: develop
canonicalTopic: contributing-coding-conventions
pageType: reference
platforms: [web, desktop, android, ios]
---

Match the established owner before introducing a new pattern. Repository checks enforce many of these rules as contracts.

## Code and imports {#code-imports}

- Use `@trinity/*` public entrypoints across libraries and relative imports within one library.
- Keep features independent; shared product behavior belongs to data access or application orchestration.
- Keep `matrix-js-sdk` in approved data-access adapters and Matrix modeling utilities.
- Treat deprecations as errors; migrate to the supported API instead of suppressing the diagnostic.

## Angular and state {#angular-state}

- Keep component TypeScript, template, stylesheet, and spec separate.
- Use `trn` selectors, `OnPush`, current template control flow, signal inputs/outputs, and Signal Forms for new forms.
- Expose state as read-only signals and model one-shot actions as cold finite Observables.
- End component-owned subscriptions with lifecycle cleanup.

## UI and tests {#ui-tests}

- Consume reusable UI through `@trinity/components/*`; keep vendors behind the public tier.
- Use semantic tokens rather than literal colors and do not use `::ng-deep`.
- Preserve established `data-testid` hooks.
- Put unit specs beside their source and use real-browser evidence for layout and interaction claims.
- Keep screenshots, traces, prototypes, and pixel baselines in ignored output.

## User-facing copy {#copy}

The domain language in `CONTEXT.md` capitalises Account, Room and Space for code and design discussion. User-visible text does not: it reads as plain English.

- **Sentence case.** Buttons, menu items, headings, tooltips and accessible names capitalise only the first word and proper names ("Create room", "System status", "Close edit history").
- **No capitalised domain nouns.** Write "room", "space", "account", "conversation", "light mode" mid-sentence. Name a menu or tab by its exact label when you point at it ("Open Space settings").
- **Room, not channel.** Never write "channel" in copy. The sidebar, threads, pins, empty states and prompts all say "room".
- **Plain words.** Say "this account", not "the opening Account"; "devices", not "sessions", in Settings.
- **Direct messages.** The rail button that opens the direct-message list is "Direct messages", the same as the sidebar title. "Home" is not a user-facing term.
- **Sign out vs Remove account.** "Remove account from this device" deletes this device's copy of an account (credentials, drafts, cached messages, keys) and signs it out of its homeserver. "Sign out" appears only in Settings › Devices, where it ends _another_ device's session; the device you are using has no "Sign out" action.
- **Dismissing.** "Cancel" abandons an action in progress (a form, prompt or confirmation). "Close" leaves a view that has nothing to abandon (a panel, viewer or read-only dialog). "Done" ends a completed flow. Never use "OK": `TrnAlertService` requires an explicit `confirmText` that names the action ("Leave", "Delete").
- **Delete vs Remove.** "Delete" destroys data and cannot be undone (a message, a past version). "Remove" takes an item out of a container (a room from a space, an account from this device).
- **Retry.** A button with no object reads "Try again"; one that names its object may read "Retry local setup". Error sentences end with "Try again."
- **Menu items on a message** use the bare verb ("Reply", "Report", "Delete"). Add an object only when the verb is ambiguous ("Copy text", "Copy link").
- **Errors name the cause in plain language** and never show SDK text, status lines or URLs. Route Matrix failures through `describeMatrixRequestFailure` or `matrixRequestErrorHandling`, and show the message next to the field it concerns, linked with `aria-describedby`.

Run formatting, affected project checks, and architecture guards appropriate to the change. Read [Angular components](../../development/angular-components/) and [testing strategy](../../testing/testing-strategy/) for implementation detail.
