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

## SDK-backed fetch caches {#sdk-fetch-caches}

Some data is fetched from the homeserver on demand and cached per scope (a room, an account):
for example, pinned messages outside the loaded timeline. Build every such cache the same way:

- **One cache per scope**, keyed by what is fetched (event id, state key).
- **Invalidate on the SDK event** that makes it wrong: clear the affected entries **and** take a
  new token with `guard.next()`, so a request already in flight cannot land afterwards.
- **Reset on `release()`**: clear the cache and advance the guard.
- **Model failure as a state.** A fetch that fails is `{ kind: 'failed' }`, rendered as such and
  retried — never a silent omission or a `null` that reads as "gone". A room state change or
  opening the panel retries immediately; Timeline and Decrypted events retry after a 30 s
  cooldown. Keep the server's definitive "no" (not found, forbidden) separate from a transient failure.
- **Apply a result only while its token is current** (`latestGuard()` from `@trinity/util/ui`).

```ts
private readonly fetches = latestGuard();
private token = this.fetches.next();
private cache = new Map<string, Fetch>();

private invalidate(): void {           // on the invalidating SDK event, and in release()
  this.cache = new Map();
  this.token = this.fetches.next();
}

private async fetch(id: string): Promise<void> {
  const token = this.token;
  const result = await load(id).then(
    (value) => ({ kind: 'loaded', value }) as const,
    (error) => (isDefinitiveNo(error) ? { kind: 'missing' } : { kind: 'failed' }) as const,
  );
  if (this.fetches.isCurrent(token)) this.cache.set(id, result);
}
```

The reference implementation is
[`conversation-pins.controller.ts`](https://github.com/quwisky/trinity-matrix-client/blob/main/libs/data-access/timeline/src/lib/conversation-pins.controller.ts).

**`latestGuard()` or `switchMap`?** When the work is already an Observable, use `switchMap`
(or `takeUntil` for release): the newer trigger cancels the older inner subscription and no
guard is needed. Use `latestGuard()` for Promise chains, callbacks and render hooks, where
there is no subscription to cancel.

## Keep commands event-driven {#event-driven-commands}

After a Matrix command succeeds, prefer the SDK event path to update the projected state. A routine write followed by a hand-built replacement model or unconditional refresh often means the projection lacks an invalidation source. Local echo is an explicit exception, not the default ownership model.

Read [Matrix integration](../matrix-integration/) for the SDK boundary and [capability ownership](../capability-ownership/) for scope selection.
