---
title: State and reactivity
description: Model current state with signals, finite actions with Observables, and lifetimes with owned projections.
audience: developer
contentChannel: develop
canonicalTopic: architecture-state-reactivity
pageType: explanation
platforms: [web, desktop, android, ios]
---

Trinity keeps authoritative Matrix state in `matrix-js-sdk` and projects it into application-facing state. It does not maintain a second Redux-style entity store.

## Signals describe current state {#signals-current-state}

Data-access services publish read-only signals and computed views. `OnPush` components read them directly. The service retains the writable signal, attaches the source listeners, and resets its view when its owner is released.

A component must not copy another capability's signal into a writable store just to make it local. Derive presentation with `computed()` or a view-local signal, and leave the canonical state with its owner.

## Observables describe actions and lifetimes {#observables-actions}

One-shot actions return cold, finite RxJS Observables. Calling a method describes the work; subscribing starts it. Errors and typed outcomes remain observable to the caller, and component-owned subscriptions use lifecycle cleanup such as `takeUntilDestroyed()`.

Ongoing streams belong to the runtime or capability that owns their lifetime. Application Runtime starts one retained process lifetime. An account capability owns account-scoped listeners; a conversation capability owns the exact account-and-room timeline handle.

## Projection Runtime owns reconciliation mechanics {#projection-runtime}

`libs/runtime/projection` provides reusable listener attachment, invalidation coalescing, generation control, cancellation, reset, and readiness barriers. A capability still defines what its projection means and which source events invalidate it.

The supported scopes are active account, all live accounts, exact account, and exact conversation. Releasing a scope detaches the exact listeners it attached, cancels queued work, prevents late generations from publishing, and resets the owned read model.

## Keep commands event-driven {#event-driven-commands}

After a Matrix command succeeds, prefer the SDK event path to update the projected state. A routine write followed by a hand-built replacement model or unconditional refresh often means the projection lacks an invalidation source. Local echo is an explicit exception, not the default ownership model.

Read [Matrix integration](../matrix-integration/) for the SDK boundary and [capability ownership](../capability-ownership/) for scope selection.
