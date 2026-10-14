---
title: Matrix features
description: Add Matrix-backed behavior through account-aware capabilities, SDK events, and protocol-level tests.
audience: developer
contentChannel: develop
canonicalTopic: development-matrix-features
pageType: how-to
platforms: [web, desktop, android, ios]
---

A Matrix feature crosses protocol, capability, presentation, and often encryption boundaries. Keep each concern with its owner.

## Start from the protocol behavior {#protocol-behavior}

Identify the Matrix event, state key, endpoint, account scope, room scope, permissions, and encryption implications. Check the installed `matrix-js-sdk` types and implementation before assuming an API or event order.

Choose the owning data-access capability. Add a stable Trinity model and command there, and export only that public contract. Feature components consume it without importing the SDK.

## Project authoritative events {#project-events}

Attach only the SDK events that invalidate the read model and reconcile from the supplied client. Keep the projection tied to the exact account or conversation lifetime. Define what happens on client replacement, soft logout, sync reset, room change, and release.

Commands remain cold and finite. Preserve local echo only where the product explicitly needs it; otherwise allow SDK events to publish the accepted result.

## Render formatted messages {#formatted-messages}

`formatted_body` is sender-controlled HTML. `sanitizeMatrixHtml` in `@trinity/util/matrix` scrubs it once against the Matrix allowlist and then runs render-only passes whose output is memoized per body, so nothing that depends on the viewer, the theme or the platform may enter that string. `MatrixHtmlDirective` in the Rooms feature binds the result with `[innerHTML]`, where Angular's sanitizer runs again, and composes the leaf directives that need the live DOM. Data Angular strips at that leaf (`data-*`, `style`) travels as a class token or an inert attribute Angular keeps, or is re-read from the sanitized string by parsing it once and pairing marked elements in document order. `sanitizeOutgoingHtml` shares the allowlist but none of the render-only passes.

### Links {#message-links}

The render pass gives `http(s)` links `target="_blank"` and `rel="noopener noreferrer"`, and so does the linkified plain-text body, so a middle-click, a modifier-click or a context-menu open behaves like a plain click. `matrix.to` and `matrix:` links get neither and stay routed in Trinity by `MatrixLinkDirective`, and a sender's own `target` and `rel` never survive the allowlist. A plain click still goes through `window.open(…, 'noopener,noreferrer')`, which Electron hands to the system browser. On Capacitor, `e2e/mobile/specs/message-links.e2e.mts` checks that a message link leaves the WebView. On iOS the WebView hands the link to the system browser; Android does too.

### Allowed HTML, colours and spoiler reasons {#message-html-fidelity}

The allowlist follows Matrix spec v1.19. It adds `s` and `data-mx-maths`, enforces each attribute on its own tag in the shared DOMPurify hook, drops `name` and any `title` outside `img`, keeps `class` only as `language-*` on `code`, and flattens anything nested more than 100 deep to its text. `color` and `start` are URI-safe for DOMPurify, because the allowlist's URI pattern would otherwise reject their values. The spec's `width` and `height` on `img` stay out until inline images are capped in height, so a sender cannot open an arbitrarily tall empty box. `font` and `strike` are still read; `sanitizeOutgoingHtml` unwraps `font` and sends `strike` as `del`.

Sender colours are accepted only as `#RRGGBB`. The render pass turns `data-mx-color`, `data-mx-bg-color` and a `font`'s `color` into `mx-fg-rrggbb` and `mx-bg-rrggbb` class tokens and removes `color`, so nothing unchecked is painted. `SenderColoursDirective` resolves the body's `--trinity-message-surface` (the workspace pane in the timeline and thread, set by the composer preview and edit history for their own surfaces, the canvas only as a fallback), its text colour, `--trinity-link` and `--trinity-rail` to sRGB, and keeps a colour only if it reaches 3:1 by WCAG 2 relative luminance against what it is drawn on: a text colour against the nearest kept sender background or the surface, a background against the inherited text colour, and a pair against each other before the background is checked alone. Links and table headers change that context: text inside a link is the link colour, so a kept background that holds a link must also read with it, and a table header draws on the rail, so a kept text colour that holds one must also read on the rail. If a value cannot be resolved, nothing is painted. It reads computed style once per body, re-checks every mounted body when the root's `dark` class or `data-theme` changes, and never colours code, mention pills or the spoiler element itself.

A spoiler's reason loses control and bidi formatting characters, is trimmed, collapsed to one line, cut to 80 characters and copied into `label`, which Angular keeps; CSS shows it, isolated, as generated content on the concealed bar. A concealed spoiler is a button named `Spoiler: <reason>, activate to reveal` (or `Spoiler, activate to reveal`). Revealing it removes that name and role at once, and its tab stop when it next loses focus, so keyboard focus is never dropped.

## Prove protocol and presentation {#prove-feature}

Unit-test normalization, permissions, account isolation, cancellation, errors, and cleanup. Add a disposable-homeserver journey when interoperability, federation-independent server state, encryption, multiple clients, or event ordering is part of the claim. Add browser evidence for the user-visible flow.

Never place real tokens, recovery keys, server databases, or private room content in fixtures or diagnostics. Test accounts and homeservers belong to the suite that creates and destroys them.

Read [Matrix integration](../../architecture/matrix-integration/), [encryption and trust](../../architecture/encryption-and-trust/), and [Matrix E2E tests](../../testing/matrix-e2e-tests/).
