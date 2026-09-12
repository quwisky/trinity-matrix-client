---
title: Data-access services
description: Implement capability-owned state and commands while keeping SDK and host details out of features.
audience: developer
contentChannel: develop
canonicalTopic: development-data-access-services
pageType: how-to
platforms: [web, desktop, android, ios]
---

A data-access library owns one product capability's read model and commands. It is the boundary between feature code and Matrix, storage, or another external source.

## Design the public API first {#public-api}

Expose stable Trinity models, read-only signals, computed selectors, and cold finite commands through the library's `src/index.ts`. Keep SDK objects, mutable signals, listener details, and concrete storage formats private.

Use an explicit account or account-and-room key whenever the operation is scoped. Do not fall back to the active account when the caller already knows the target.

## Attach one owned projection {#owned-projection}

Choose the correct Projection Runtime scope, identify the authoritative events, rebuild the read model from the source, and define exact reset behavior. Listener setup and teardown must be symmetric. A late reconciliation must not publish after its generation is replaced or released.

For an active Matrix client, use the shared Matrix projection adapter unless the capability has a genuinely different lifetime. Keep ongoing listener ownership out of components.

## Make commands observable {#observable-commands}

Return a cold finite Observable with typed outcomes. Perform validation and permission checks at the capability boundary, call the adapter, and let authoritative events reconcile state. Avoid hidden subscriptions inside services unless the service explicitly owns that runtime lifetime.

Map expected product failures without leaking tokens, raw Matrix payloads, private content, or exception text into diagnostics.

## Validate the boundary {#validate-boundary}

Test account isolation, source replacement, invalidation, error propagation, cancellation, teardown, and late-event rejection. Run the project test, typecheck, lint, and architecture checks when public APIs or dependencies change.

Read [Matrix integration](../../architecture/matrix-integration/) and [capability ownership](../../architecture/capability-ownership/) before introducing a new service.
