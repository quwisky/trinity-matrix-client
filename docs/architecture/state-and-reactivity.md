# State and reactivity

Trinity has no Redux store, no NgRx, and no entity store of its own. The reason is that
`matrix-js-sdk` is already one. It holds rooms, timelines, membership, receipts and crypto state in
memory and in IndexedDB, keeps them current from `/sync`, and emits `EventEmitter` events when they
change. A second copy of that data in the app would be a cache with an invalidation problem, and
the invalidation signal would be the very events the SDK already emits.

So the rule is: **the SDK is the store, and data-access services project it into signals.**

## Signals for state, Observables for actions

Two reactive primitives, with a hard line between them.

| Concern                                     | Primitive            | Shape                                              |
| ------------------------------------------- | -------------------- | -------------------------------------------------- |
| Current state a template renders            | Angular signals      | `private writable` → `asReadonly()` → `computed()` |
| A one-shot action with a result or an error | Cold RxJS Observable | `defer(() => from(client.someCall()))`             |

State is a projection: it is derived from the SDK and can be rebuilt from it at any time. An action
is a request that happens once, can fail, and needs cancelling when the component that started it
goes away. Signals model the first badly-suited-to-failure case well and the second badly;
Observables the reverse.

The state half looks like this everywhere:

```ts
private readonly _rooms = signal<RoomSummary[]>([]);
readonly rooms = this._rooms.asReadonly();

readonly totalUnread = computed(() =>
  this.rooms().reduce((sum, r) => sum + r.unreadCount, 0),
);
```

The writable signal is private, the readable one is exposed, and derived values are `computed`.
Nothing outside the service can write. There are 63 `asReadonly()` exposures and 218 `computed()`
declarations across `libs/`.

The action half is always cold, so nothing happens until someone subscribes, and always resolves
its client at subscribe time rather than at construction time:

```ts
leave(roomId: string, accountId?: string): Observable<void> {
  return defer(() => {
    const client = this.clientOwning(accountId);
    if (!client) {
      return throwError(() => new Error('Not signed in.'));
    }
    return from(client.leave(roomId)).pipe(map(() => void 0));
  });
}
```

`leave()` does not refresh the room list afterwards. It does not need to: the server confirms by
emitting `RoomEvent.MyMembership`, the projection is listening for that event, and the room drops
out of the read model on the next rebuild. **An action that has to refresh the read model by hand
is usually a sign that the projection is missing an event** — or that the SDK genuinely has no
local echo for that write, which is a case worth handling explicitly rather than papering over
(see `setMarkedUnread` below).

Components subscribe with `takeUntilDestroyed`, which ties the subscription to the injecting
context's lifetime. Across non-spec code there are 121 `.subscribe(` sites and 92
`takeUntilDestroyed` uses; the gap is mostly service-internal subscriptions that live for the
session by design.

## Zoneless, and what that changes

The app runs without zone.js. `package.json` does not depend on it, `apps/trinity/src/polyfills.ts`
is comment-only and says so, and `main.ts` provides `provideZonelessChangeDetection()`.

Two consequences hold across the whole workspace and are worth checking against before you write
anything reactive:

- Every `*.component.ts` and `*.page.ts` sets `changeDetection: ChangeDetectionStrategy.OnPush`.
  There are no exceptions.
- There is not one `ChangeDetectorRef`, `markForCheck()` or `NgZone` use in non-spec source. The
  only match for `NgZone` in the tree is a comment explaining why one is not needed.

Without zones, a signal write is the _only_ thing that schedules change detection. That is exactly
why the projection services can attach raw `matrix-js-sdk` event handlers and do nothing special
inside them: the handler writes a signal, and the write schedules the render. Their comments say
"writes signals, which schedule change detection" for that reason, rather than wrapping anything.

It also means unit tests need a zoneless-aware render helper. Import `render` from
`@trinity/testing`, never from `@testing-library/angular` directly; see
[testing](../contributing/testing.md) for what goes wrong otherwise.

## projectFromClient

Every projecting service has to get the same three things right, and each one was independently
re-derived — and sometimes mis-derived — before they were extracted into one primitive,
[`projectFromClient()`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/data-access/matrix-client/src/lib/project-from-client.ts).

1. **Coalescing.** A completed `/sync` emits many events at once. Rebuilding an O(rooms) read model
   and re-sorting it once per event is waste.
2. **Client-instance-keyed listeners.** A logout followed by a login swaps in a brand new
   `MatrixClient`. Listeners must be keyed to the _instance_.
3. **Re-projection on account switch.** With multi-account, the active client changes underneath a
   service that is already connected.

!!! danger "Gating on a boolean instead of the client instance"

    A `private connected = false` guard makes the second `connect()` a no-op, so the listeners stay
    attached to the client that was discarded at logout. The read model then freezes: the room
    list, unread badges or crypto status stop updating, and nothing in the console says why.
    `projectFromClient` keeps `connectedClient: MatrixClient | null` and compares by identity —
    `if (connectedClient === client) return;` and otherwise `disconnect()` first. Do not hand-roll
    this.

### Configuration

```ts
private readonly projection = projectFromClient({
  matrix: this.matrix,
  events: [ClientEvent.Sync, RoomEvent.Name /* … */],
  rebuild: (client) => this.refresh(client),
  bind: (client) => client.on(RoomStateEvent.Members, this.onMemberChanged),
  unbind: (client) => client.off(RoomStateEvent.Members, this.onMemberChanged),
  reset: () => this._rooms.set([]),
});
```

| Option                           | Default  | What it does                                                                                                                           |
| -------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `matrix`                         | required | The `MatrixClientService` to project from                                                                                              |
| `rebuild(client)`                | none     | Rebuild the read model. Called synchronously by `connect()` so consumers see the model immediately, then again on each coalesced flush |
| `events`                         | `[]`     | Events meaning "the model changed", each bound to a zero-argument coalesced rebuild                                                    |
| `bind(client)`, `unbind(client)` | none     | Bespoke listeners, for handlers that need the event's arguments or must not be coalesced                                               |
| `reset()`                        | none     | Clear the read model on disconnect, so a detached service holds no stale projection                                                    |
| `coalesce`                       | `true`   | Set `false` only where events are genuinely rare and latency beats batching, and say why at the call site                              |
| `reprojectOnSwitch`              | `true`   | Set `false` only for a projection whose lifetime is already torn down by the switch                                                    |

The returned `ClientProjection` exposes `connect()`, `disconnect()`, `isConnected()`, `client()` and
`schedule()`. `connect()` no-ops when the client service is not initialised, no-ops again if
already wired to the same client, and otherwise disconnects from the previous client first.
`disconnect()` detaches, calls `unbind`, nulls the connected client, cancels any queued rebuild, and
then calls `reset()`.

A projecting service typically just delegates:

```ts
connect(): void {
  this.projection.connect();
}

disconnect(): void {
  this.projection.disconnect();
}
```

!!! warning "Call it from a field initializer or a constructor"

    `reprojectOnSwitch` creates an `effect()`, which needs an injection context so the effect is
    owned by the root injector and lives for the session. A field initializer or the constructor of
    a `providedIn: 'root'` service qualifies; a lazily called `setup()` method does not, and gives
    you NG0203 or a re-projection that silently never fires.

One more subtlety inside `rebuild`: **take the `client` argument, do not re-read
`matrix.instance`**. A rebuild coalesced from account A's events can drain after the active client
is already B. Most existing services still re-read `matrix.instance` in their own `refresh()` —
benign today, because the re-projection effect was about to rebuild from B anyway — and the
primitive's own doc comment says new code should not copy them.

## coalesce

[`coalesce(fn)`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/data-access/matrix-client/src/lib/coalesce.ts)
returns `{ schedule(), cancel(), pending() }` and queues `fn` on `queueMicrotask`. Two details in it
are load-bearing and easy to lose when reimplementing it by hand, which is why it is a shared
function rather than a described convention:

- The `scheduled` flag is cleared **before** `fn` runs, so an event arriving _during_ a rebuild
  queues the next one instead of being swallowed.
- `cancel()` drops a queued run, so a service that detaches between the schedule and the flush
  cannot rebuild against a client it has already let go of.

!!! warning "A negative assertion without a microtask flush proves nothing"

    Because the run is queued rather than immediate,
    `expect(rebuildSpy).not.toHaveBeenCalled()` passes trivially — the rebuild is merely queued and
    would have run one microtask later. Every "this listener did *not* trigger a rebuild" assertion
    in a projection spec is vacuous unless the turn is drained first with
    `await Promise.resolve()`.

## reprojectOnAccountSwitch

The whole of it is three lines:

```ts
effect(() => {
  matrix.activeUserId();
  if (isConnected()) {
    connect();
  }
});
```

Reading `activeUserId()` and discarding the value is the dependency registration — the effect has
to depend on the active account without caring what it is. The `isConnected()` gate is what stops
an account switch from eagerly connecting page-scoped services that nothing is displaying yet: a
viewing service connects on demand and re-wires when the account changes, with no per-service
multi-account design.

!!! warning "Do not act on the new account the moment switchAccount resolves"

    The re-projection runs from an effect, which flushes *after* the switch Observable completes. A
    space hierarchy requested in the `subscribe` callback is wiped by that flush, and the symptom
    is a sidebar whose sub-space sections stay empty until the account pill is clicked a second
    time. `AccountRoutingService.runOnAccount` therefore wraps its follow-up in
    `afterNextRender(() => then(), { injector })` — defer past the render that follows the switch,
    not just past the Observable.

## Who takes the whole primitive, and who takes only the batching

Seven services take the full `projectFromClient`:

| Service               | Library                        |
| --------------------- | ------------------------------ |
| `RoomsService`        | `@trinity/data-access/rooms`   |
| `SpacesService`       | `@trinity/data-access/rooms`   |
| `InvitesService`      | `@trinity/data-access/invites` |
| `CryptoService`       | `@trinity/data-access/crypto`  |
| `VerificationService` | `@trinity/data-access/crypto`  |
| `DevicesService`      | `@trinity/data-access/crypto`  |
| `PresenceService`     | `@trinity/data-access/profile` |

The library column is the import alias, and it mirrors the directory:
`@trinity/data-access/rooms` is `libs/data-access/rooms`. The Nx project name is the third
string and keeps the flat hyphenated form, so the command stays
`pnpm exec nx test data-access-rooms`.

Six take **only** `coalesce()`, and each says why at the call site. The split is not arbitrary — it
follows from what the service's lifetime is keyed to:

| Service                   | Keyed to              | Why the client half does not apply                                                                                             |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `TimelineService`         | The open room         | Binds to a `Room` as well as a client, so its lifetime is `open()` and `close()`. An account switch closes the open room first |
| `PinnedMessagesService`   | The open room         | Same                                                                                                                           |
| `MixedRoomsService`       | The mixed account set | Attaches listeners per account and reconciles them against the live set, rather than following one active client               |
| `MixedSpacesService`      | The mixed account set | Same                                                                                                                           |
| `MixedInvitesService`     | The mixed account set | Same                                                                                                                           |
| `UnreadAggregatorService` | The mixed account set | Same                                                                                                                           |

`NotificationService` takes neither. It binds per account, with push scoring, own-message
suppression and event dedupe all keyed by account, and an account-set effect in its constructor is
its equivalent of the projection.

The rule to apply when writing a new service: if your listeners follow _the active client_, take
`projectFromClient`. If they follow a room or a set of accounts, take `coalesce` and own the rest.

## A worked example: RoomsService

[`RoomsService`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/data-access/rooms/src/lib/rooms.service.ts)
is the reference implementation, and the annotations in it are the actual documentation for the
awkward cases.

**The event list is annotated event by event with why it is there.** Two entries are the
interesting ones:

- `MatrixEventEvent.Decrypted` is listed because in an encrypted room the notification count is
  only recomputed once the message decrypts, which lands _after_ the `Sync` that carried the
  ciphertext. Relying on `ClientEvent.Sync` alone silently drops unread increments in exactly the
  rooms where they matter most.
- `RoomEvent.AccountData` is listed because it carries the marked-unread flag. Before it was added,
  a room flagged unread on another device would not surface until some unrelated event happened to
  rebuild the list.

**Two listeners are deliberately kept out of the coalesced rebuild.** `RoomStateEvent.Members` and
`RoomEvent.MyMembership` are attached through `bind`/`unbind` rather than `events`, because they
should not trigger an O(rooms) rebuild. They bump a separate `memberRevision` signal, which exists
so a member-list projection can stay reactive without re-running on every sync tick and read
receipt. The member handler does call `projection.schedule()` in one narrow case: when the changed
member is a DM peer, because a DM has no `m.room.avatar` and that member's picture _is_ the room's
row avatar.

**`reset` clears everything the projection owns** — the memoised member cache, the rooms signal,
the direct-room ids and the DM peer set — so a disconnected service holds nothing stale.

**Optimistic writes are explicit and reversible.** `setMarkedUnread` is the one place a write
cannot wait for the server, and the comment explains why: `setRoomAccountData` is a bare PUT with
no local echo, and `Room.accountData` is only ever written from `/sync`, so refreshing after the
write re-reads the _old_ value and the row does not change until the sync echo lands. The service
therefore keeps a `pendingUnread` map, writes it before the request, refreshes, and on failure
deletes the entry and refreshes again to put the row back.

**Actions in the mixed-account view take an `accountId`.** In that view a row can belong to a
signed-in account that is not the active one, so every action resolves its client through
`clientOwning(accountId?)`, which returns `matrix.clientFor(accountId)` when given an id and
`matrix.instance` otherwise. Assuming `matrix.instance` here is how a favourite fails to stick or a
badge refuses to clear.

## runWithBusy

Pages that run one-shot actions share a busy and error convention through
[`runWithBusy`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/ui/src/lib/util/with-busy.ts):

```ts
runWithBusy(this.auth.changePassword(current, next), {
  busy: this.saving,
  error: this.error,
  destroyRef: this.destroyRef,
}).subscribe(() => this.form().reset({ ...EMPTY_PASSWORDS }));
```

It sets `busy` true and clears `error`, then pipes `takeUntilDestroyed` → `catchError` →
`finalize`. Pages either call it inline like this with a per-action busy signal, or wrap it once in
a private `withBusy()` helper backed by page-level `busy` and `error` signals.

!!! warning "The failure is swallowed, and busy is set eagerly"

    `catchError` writes the message into the `error` signal and returns `EMPTY`, so the
    subscriber's `next` callback **never runs on failure**. Cleanup or navigation placed there is
    silently skipped, and nothing reaches the caller — the template's error banner is the only
    channel by design. Separately, `busy` is set to `true` at call time, before the returned
    Observable is subscribed, so calling `runWithBusy` and never subscribing leaves `busy` stuck
    true because `finalize` never runs.

## Revision counters are a known strain

Four signals in the codebase are bump counters rather than data: `RoomsService.revision`,
`RoomsService.memberRevision`, a private one in `SpacesService`, and a coalesced one in
`PinnedMessagesService`. A `computed` reads the counter, discards the value, and re-runs when it
ticks:

```ts
readonly pinnedMessages = computed<PinnedMessageView[]>(() => {
  this._revision();
  const ids = this._pinnedEventIds();
  // …resolve each id against the room's locally-loaded events
});
```

They exist because the underlying data is not in a signal at all — it lives in `matrix-js-sdk`
objects that are mutated in place. `membersOf(roomId)` reads `Room.getJoinedMembers()` directly, so
there is nothing for a `computed` to depend on except a hand-ticked counter. The alternative, an
entity store mirroring SDK state into signals, is the thing this architecture deliberately does not
build.

Treat them as a documented strain, not a pattern to reach for. Before adding a fifth, check whether
the value can be projected into a real signal by the service that owns the events. If a counter is
genuinely the answer, take the two lessons the existing ones encode: keep it separate from the main
revision when it is bumped by different events (`memberRevision` exists precisely so a member list
does not re-run on every read receipt), and coalesce it when the events are per-message, as
`PinnedMessagesService` does — a bump per backfilled event is the difference between per-message
and per-turn work in a busy room.

The rooms shell used to be the other recorded strain — a single 2,000-line page holding every
room and space workflow. It was decomposed into thirteen page-scoped classes beside it: a
`RoomShellStore` for the shell's own signals, a `ShellStatusService` owning one busy/error
channel, a `RoomShellViewModel` for the derived state, and ten workflow coordinators. The page
itself is now the wiring layer, and `libs/feature/rooms/src/lib/rooms/` is where the pieces live.

Two things about that layout matter when adding to it. The coordinators are `@Injectable()` with
no `providedIn`, listed in `RoomsPage`'s `providers:` array, because `runWithBusy` ties its
subscriptions to the injected `DestroyRef` — a root-provided coordinator's never fires, so every
one of those subscriptions would outlive the page. And the page is still the single place the
client projections are started: `ngOnInit` calls `connect()` on rooms, spaces, invites, crypto,
presence and notifications, so read it before adding another projection to the shell.
