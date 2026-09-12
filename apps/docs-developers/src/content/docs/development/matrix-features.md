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

## Prove protocol and presentation {#prove-feature}

Unit-test normalization, permissions, account isolation, cancellation, errors, and cleanup. Add a disposable-Synapse journey when interoperability, federation-independent server state, encryption, multiple clients, or event ordering is part of the claim. Add browser evidence for the user-visible flow.

Never place real tokens, recovery keys, server databases, or private room content in fixtures or diagnostics. Test accounts and homeservers belong to the suite that creates and destroys them.

Read [Matrix integration](../../architecture/matrix-integration/), [encryption and trust](../../architecture/encryption-and-trust/), and [Matrix E2E tests](../../testing/matrix-e2e-tests/).
