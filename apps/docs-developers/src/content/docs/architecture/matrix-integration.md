---
title: Matrix integration
description: Understand the client registry, SDK authority, account-aware adapters, and event projection boundary.
audience: developer
contentChannel: develop
canonicalTopic: architecture-matrix-integration
pageType: explanation
platforms: [web, desktop, android, ios]
---

Trinity uses `matrix-js-sdk` as the authoritative source for Matrix protocol state. SDK construction and direct SDK access live in data-access libraries, principally Matrix Client and the capability adapters built over it.

## One client per live account {#client-registry}

The `AccountRuntimeService` restores saved accounts and coordinates the active account. The Matrix client registry owns live client instances and their sync lifecycle. Capability code resolves the client for an explicit account or follows the selected-account projection appropriate to its scope.

Never use the active account implicitly for work that already has an account identifier. Room and event identifiers alone do not establish which authenticated client owns an operation.

## Adapt SDK state at the boundary {#adapt-sdk-state}

Data-access services translate SDK objects and events into stable Trinity read models and commands. Feature and component code consumes those public models; it does not expose SDK objects through UI APIs or attach competing SDK listeners.

For active-client projections, the shared `projectFromClient` adapter coordinates client replacement, event attachment, burst coalescing, reconciliation, and reset. Other scopes use their matching owned projection lifetime.

## Treat synchronization as authoritative {#sync-authority}

Commands call the SDK and then allow sync or the relevant SDK event to reconcile current state. Preserve a typed error or outcome for the initiating action, but do not claim that an accepted network request has already become authoritative local state unless the SDK contract guarantees it.

Authentication, persistence, and cryptographic storage require stronger lifecycle rules than ordinary Matrix reads. Continue with [encryption and trust](../encryption-and-trust/). For signal and command behavior, read [state and reactivity](../state-and-reactivity/).
