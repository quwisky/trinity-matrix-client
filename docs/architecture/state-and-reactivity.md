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

## Projection Runtime

`@trinity/runtime/projection` is the shared lifecycle module for new projections. Its interface is
deliberately closed over four scopes: `active-account`, `all-live-accounts`, `exact-account`, and
`exact-conversation`. Product-defined strings and generic topics are not accepted, so it cannot
grow into an event bus.

A Matrix or host adapter activates one projection definition containing only its scope, attachment,
authoritative reconciliation, reset, and resource-count callbacks. Projection Runtime then owns:

- replacing the same projection and scope as one generation change;
- coalescing an invalidation burst to one reconciliation per microtask;
- refusing a late asynchronous generation's `publish()` callback;
- subscribing to cold finite reconciliation Observables and cancelling them on invalidation,
  replacement, or release;
- detaching exact listener references, cancelling queued work, and resetting on release; and
- acknowledging the current generation through a cold, finite `waitFor(scope)` Observable.

`transition(scope)` is the atomic reattachment path. It cancels each matching generation,
detaches and resets its adapter, attaches again against the now-authoritative source, reconciles,
and completes only when every new generation has acknowledged. Active Account switching commits
the persisted and live Account pointers first, then waits on `transition({ kind:
'active-account' })` before the Workspace repairs its requested room or space.

The barrier reports duration, projection and listener counts, and deterministic retained payload
bytes. The local barrier baseline is one frame (16 ms) after its projections acknowledge. Runtime
diagnostics also accumulate reconciliation count and wall time so background-Account projection
cost can be sampled without recording Account ids or projected content.

The first production adapter is Matrix Runtime's per-Account sync state. It keeps the existing
signal as the only read model, moves its one `ClientEvent.Sync` listener into Projection Runtime,
and makes Account startup wait for the exact-Account barrier. A live Account therefore retains one
sync listener. While a coalesced update is pending it can retain the published enum and a distinct
new enum: at most 40 deterministic payload bytes across the two longest distinct current
`SyncState` values (two bytes per UTF-16 code unit). Once reconciled, those references share one
value; release returns both counts to zero. Runtime/engine object overhead remains profiler
evidence rather than a portable unit-test assertion. There is no duplicate SDK store.

## Conversation Runtime

`ConversationRuntime` owns the messaging lifetime of one immutable Account-and-Room pair. A
handle freezes that key and exposes a timeline child; it never reads the route and never retargets
when Active Account changes. `RoomShellNavigationService` is the Workspace adapter: it focuses the
key derived from the active Account and routed Room, or blurs the current handle when the Room
leaves the Workspace. Feature surfaces consume `ConversationRuntime.timeline`, a stable proxy for
the focused child, rather than injecting the child implementation or a root timeline singleton.
`TimelineService` and its raw SDK context stay package-internal; the data-access action adapter
reaches that context through an internal bridge, while the public entrypoint exports only
app-owned read models and cold command services.

Each handle also owns one main-room compose child. Its persisted new-message draft is separate
from an in-progress edit draft, so cancelling an edit restores the text that was parked before it.
Reply and edit snapshots remain bounded separately from listener-owning timeline handles, so they
survive navigation that evicts a warm handle as well as Account switches.
The stable `ConversationRuntime.compose` proxy lets feature surfaces update that intent and start
typing without gaining a writable signal or SDK reference. The component retains only transient
textarea mechanics: caret, focus, autocomplete, attachment staging and toolbar state.

Each handle also exposes an exact-Conversation media command. Host-acquired `File` objects are
immediately staged by Media Pipeline and replaced with an opaque `StagedMediaReference`; the
Conversation sees that reference, a caption, and its immutable Account-and-Room key, never raw
bytes, an active-client pointer, or platform identity. `media.send()` is a cold RxJS stream of
validation, encryption, upload and send progress followed by one typed terminal outcome.
Unsubscription aborts an in-flight upload and asks the SDK to cancel a pending local echo when it
can. Retry retains the encrypted upload descriptor for that exact Account-and-Room target. An
unchanged caption resends the SDK's `NOT_SENT`/queued/encrypting event; confirmed cancellation or
an edited caption rotates to a fresh Matrix transaction id before creating a replacement echo.
While the SDK still marks the echo `SENDING`, the command reports an indeterminate terminal
outcome instead of risking a duplicate.

`compose.submit()` is cold and finite. Subscription snapshots the immutable Conversation key,
current text and intent, suppresses a duplicate interaction while that attempt is active, and
hands the text to the focused child’s package-internal Matrix adapter. A `sent` outcome is emitted
only after `sendMessage` resolves and the returned event id can be found in the Room’s SDK-owned
local timeline. The visible field clears optimistically, but its persisted snapshot is not cleared
until that acceptance. Server or transport rejection is a typed, retryable outcome; a missing
accepted local echo is an adapter defect on the Observable error channel. Rejection and
SDK-confirmed cancellation restore the snapshot. If the SDK reports that an event may already be
sending, unsubscription is deliberately indeterminate: Trinity does not reinsert text that could
duplicate an event already on the wire, while the persisted snapshot remains recoverable if the
handle is later recreated. No command owns a detached subscription.

Focus enables foreground effects such as read receipts, typing and room actions. Blur disables
those effects but leaves the Matrix listeners attached, so the projection remains warm. Each
Account retains at most two blurred handles in least-recently-used order. A retained child keeps
the latest 100 raw timeline events in its application projection and at most 200 sender
dependencies; focusing it rebuilds the complete loaded projection from `matrix-js-sdk`, which
remains authoritative. In a browser that is 11 listeners and at most 11,200 deterministic modeled
bytes per retained handle, or 22 listeners and 22,400 bytes for the two-entry per-Account retained
set. The one globally focused handle may add 11 listeners; its visible projection is not part of
the retention-memory baseline.

Eviction marks the exact handle `retired`, removes it from the keyed registry and destroys its
child injector. That object can never become focused again; reopening the same key creates a new
handle. Runtime teardown performs the same release for every remaining child. Diagnostics report
the last synchronous attach-to-presentable duration, active/focused/retained/retired handle counts,
total listeners and retained modeled bytes without recording Account ids, Room ids or content.
Timeline actions remain cold RxJS Observables and resolve the focused child on subscription.

## Active-client projection adapter

Every projecting service has to get the same three things right, and each one was independently
re-derived — and sometimes mis-derived — before they were extracted into one primitive,
[`projectFromClient()`](https://github.com/quwisky/trinity-matrix-client/blob/refactor/refine-architecture/libs/data-access/matrix-client/src/lib/project-from-client.ts).

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
  id: 'rooms.list',
  matrix: this.matrix,
  events: [ClientEvent.Sync, RoomEvent.Name /* … */],
  rebuild: (client) => this.refresh(client),
  bind: (client) => client.on(RoomStateEvent.Members, this.onMemberChanged),
  unbind: (client) => client.off(RoomStateEvent.Members, this.onMemberChanged),
  reset: () => this._rooms.set([]),
});
```

| Option                           | Default  | What it does                                                                                         |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `id`                             | required | Stable acknowledgement identity inside the active-Account scope                                      |
| `matrix`                         | required | The `MatrixClientService` to project from                                                            |
| `rebuild(client)`                | none     | Rebuild the read model during Projection Runtime reconciliation                                      |
| `events`                         | `[]`     | Events meaning "the model changed", each invalidating one coalesced runtime generation               |
| `bind(client)`, `unbind(client)` | none     | Bespoke listeners for handlers that need the event's arguments                                       |
| `reset()`                        | none     | Clear the read model on disconnect or scoped reattachment                                            |
| `reprojectOnSwitch`              | `true`   | Fallback for legacy Account changes outside the coordinated switch; do not use it as a readiness API |

The adapter registers every connected service as an `active-account` Projection Runtime entry,
so its event bursts, lifecycle, generation safety, and switch acknowledgements use the same
kernel as new architecture slices. The returned
`ClientProjection` exposes `connect()`, `disconnect()`, `isConnected()`, `client()` and
`schedule()`. `connect()` no-ops when the client service is not initialised, no-ops again if
already wired to the same client, and otherwise disconnects from the previous client first.
`disconnect()` releases the runtime lease, which detaches, calls `unbind`, cancels queued work,
nulls the connected client, and then calls `reset()`.

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

!!! warning "Do not bypass coordinated switch readiness"

    The `activeUserId()` effect is only a compatibility fallback for Account changes made outside
    the coordinated path, and it still flushes after those legacy mutations. Product flows use
    `WorkspaceAccountSwitchService`: its `ready` outcome follows Account commit, synchronous
    Projection Runtime reattachment, generation acknowledgement, and Workspace selection repair.
    Consumers can therefore act on `ready` without an `afterNextRender` timing workaround.

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

| Service                   | Keyed to               | Why the client half does not apply                                                                                                       |
| ------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `TimelineService`         | One Conversation child | Package-internal implementation bound to an immutable Account-and-Room handle; Conversation Runtime owns its `open()`/`close()` lifetime |
| `PinnedMessagesService`   | The routed open room   | The shell explicitly opens and closes its Room binding; it does not follow the mutable active client                                     |
| `MixedRoomsService`       | The mixed account set  | Attaches listeners per account and reconciles them against the live set, rather than following one active client                         |
| `MixedSpacesService`      | The mixed account set  | Same                                                                                                                                     |
| `MixedInvitesService`     | The mixed account set  | Same                                                                                                                                     |
| `UnreadAggregatorService` | The mixed account set  | Same                                                                                                                                     |

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
should not trigger an O(rooms) rebuild. They write the per-room member signals
(`membersFor(roomId)`) instead, so a member list stays reactive without re-running on every sync
tick and read receipt — and `RoomStateEvent.Members` carries the room it happened in, so only that
room's signal is written. The member handler does call `projection.schedule()` in one narrow case:
when the changed member is a DM peer, because a DM has no `m.room.avatar` and that member's picture
_is_ the room's row avatar.

**`reset` clears everything the projection owns** — the memoised member cache, the rooms signal,
the direct-room ids, the DM peer set and the per-room member signals — so a disconnected service
holds nothing stale. That last one is the easiest to forget and the one a stale read is visible
through: the member signals hold VALUES read from a particular client, so `rebuild` also re-reads
them whenever the client itself changed.

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
[`runWithBusy`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/util/ui/src/lib/with-busy.ts):

```ts
runWithBusy(this.auth.changePassword(current, next), {
  busy: this.saving,
  error: this.error,
  destroyRef: this.destroyRef,
}).subscribe(() => this.form().reset({ ...EMPTY_PASSWORDS }));
```

It sets `busy` true and clears `error`, then pipes `takeUntilDestroyed` → `catchError` →
`finalize`. Pages either call it inline like this with a per-action busy signal, or wrap it once in
a private `withBusy()` helper backed by page-level `busy` and `error` signals. State changes are
lazy: they start only when the returned Observable is subscribed. `finalize` clears `busy` after
success, failure, empty completion, explicit cancellation, or owner teardown.

!!! warning "The failure is swallowed"

    `catchError` writes the message into the `error` signal and returns `EMPTY`, so the
    subscriber's `next` callback **never runs on failure**. Cleanup or navigation placed there is
    silently skipped, and nothing reaches the caller. Request-facing call sites can supply a safe
    formatter, diagnostic reporter, and immediate presenter; the rooms shell uses that presenter
    because a zoneless failure may not schedule the component effect that formerly showed its
    toast. Do not pass a raw SDK message through a formatter: it can retain a response body or URL.

## Revision counters, and what replaced them

A bump counter is a signal holding no data: a `computed` reads it, discards the value, and
re-runs when it ticks. They appear where the underlying data is not in a signal at all — it
lives in `matrix-js-sdk` objects mutated in place — so there is nothing to depend on.

This section used to say there were four and leave it there. Issue #61 audited them; the
count was wrong in both directions, so was one of the justifications, and **every counter over
Matrix state turned out to be avoidable** — including the two that survived the first pass on
the strength of arguments that did not hold up. The survey, so the next reader inherits the
conclusions rather than the puzzle:

| Counter                                               | Verdict                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SpacesService._revision`                             | **Removed.** It stood for "which rooms am I in?", which `refresh()` already knew from its own `getRooms()` pass. Now a `_joinedRoomIds` set with structural equality.                                                                                                                                                                                             |
| `PinnedMessagesService._revision`                     | **Removed.** It was defended as irreducible — late decryption, no entity-level signal to depend on. But `MatrixEventEvent.Decrypted` _is_ that signal, the service already listened to it, and `TimelineService` solves the same problem on the same event with no counter. `pinnedMessages` is now a signal the resolve writes.                                  |
| `ManageSpaceRoomsComponent.revision`                  | **Removed.** A _component_ compensating for a service with no reactive surface. `SpaceChildrenService.linksFor` projects `m.space.child` now. It was never in this list.                                                                                                                                                                                          |
| `RoomsService.profileRevision` (was `revision`)       | **Removed** → `AccountProfilesService`, which projects `UserEvent.DisplayName`/`AvatarUrl` per signed-in account. The counter was bumped only by the ACTIVE client while two consumers read _other_ accounts' clients, so a mixed-in account's badge stayed stale until the active account happened to sync — papered over by also reading the unread aggregator. |
| `RoomsService.memberRevision`                         | **Removed** → `membersFor(roomId)`, a signal per watched room written only when a member event names it. It was never a throttle: what makes a re-read cheap is `membersOf`'s fingerprint memo returning the identical array, which `Object.is` stops. Being unfiltered, it woke every member list in the app on any room's member event.                         |
| `heightVersion` (`virtual-message-list.component.ts`) | **Kept**, and not a Matrix problem: it invalidates a `Map` a `ResizeObserver` writes. The alternative allocates per measurement. Never previously listed.                                                                                                                                                                                                         |
| `RoomShellStore.jumpRequest`                          | **Kept**, and not a Matrix problem either: it re-fires an effect for a jump to a target that has not changed, which is a command and not state. Never previously listed.                                                                                                                                                                                          |

Two general lessons, both learned the hard way here:

**A counter is usually a missing signal, not a missing dependency.** Every one removed above
turned out to have a real value hiding behind it — a set of ids, a resolved list. Ask what the
counter _stands for_ and store that instead; it is inspectable in a debugger, it can carry an
`equal` so an unchanged sync stops there, and it cannot silently drift out of step with the
thing it was standing in for.

**Undeclared liveness is worse than no liveness.** The Organise-rooms dialog re-read on every
sync — not through any dependency it declared, but because a _name lookup_ it also read handed
back a fresh array each rebuild. It worked, it was untested, and severing the real dependency
still leaves the end-to-end test green. Pin a projection where the accident cannot reach it:
in the data-access spec, not the component's.

What is left is two counters, neither over Matrix state: `heightVersion` above, and
`RoomShellStore.jumpRequest`, which re-fires an effect for a jump to a target that has not
changed. Before adding another, check
whether the value can be projected by the service that owns the
events — the answer has been "yes, project it" five times running. Which projection shape
depends on what it is keyed on, and only two of those five used `projectFromClient`:
it decides listener lifecycle, coalescing and account-switch re-projection for a read model
keyed on ONE active client. `PinnedMessagesService` is room-scoped and takes `coalesce`
alone; `membersFor` writes per-room signals from the owning service's own listeners. Where the
projection is keyed on the ACCOUNT SET rather than one active client, reconcile a listener per
account instead (`AccountProfilesService`, `MixedRoomsService`, `UnreadAggregatorService`) — and
keep the `held.client === client` identity re-check, or re-adding a signed-in account strands
the listener on a stopped client.

## Page-scoped coordinators

The rooms shell used to be the other recorded strain — a single 2,000-line page holding every
room and space workflow. It is now about 310 lines, and the workflows live in thirteen classes
beside it in `libs/feature/rooms/src/lib/rooms/`. The shape is worth copying, because the cut is
not the obvious one.

The obvious cut is by domain: a service for spaces, one for rooms, one for messages. That does
not work here, and the reason generalises. Every domain workflow ends by changing which room is
open, and most of them report failure through the same channel — so domain-first services all
reach back into the page, or into each other, on day one. Cutting horizontally instead removes
the collision before it can happen:

| Layer                     | What it holds                                          | Depends on      |
| ------------------------- | ------------------------------------------------------ | --------------- |
| `RoomShellStore`          | The shell's own signals: selection, panes, jump target | nothing         |
| `ShellStatusService`      | One busy/error pair, and the toasts it drives          | nothing         |
| `RoomShellViewModel`      | Every `computed()` the shell derives                   | the store       |
| Ten workflow coordinators | Prompts, confirmations, writes, terminal navigation    | the three above |

The store and the view model are pure — no writes, no subscriptions, no side effects. That
purity is what lets the coordinators and the view model both depend on the store without a
cycle: derived state reads the selection, workflows write it, and neither sees the other.

!!! warning "Never `providedIn: 'root'` for one of these"

    They are `@Injectable()` with no `providedIn`, listed in the page's `providers:` array, so
    they share the page's lifetime and its `DestroyRef`. That is not stylistic. `runWithBusy`
    ties its subscription to the injected `DestroyRef`, and a root-provided service's never
    fires — every one of those subscriptions would outlive the page, toasting into a screen the
    user has navigated away from. A root-provided store would also keep selection alive across
    navigations, so returning to `/rooms` would show a room marked active whose panes
    `ngOnDestroy` already closed.

    `shell-invariants.spec.ts` pins both halves: that none of the thirteen resolves from a bare
    injector, and that the page really declares them itself.

Two things stay on the component because they cannot leave it. A `viewChild` query only exists
on a component, so the mobile focus handoff is a callback the page hands to the navigation
coordinator in its constructor — not `ngOnInit`, because `TestBed.inject(RoomsPage)` never runs
lifecycle hooks and that left the callback unset for every unit test. And a `host` binding can
only name a member of the component class, so the global keydown listener keeps a one-line
delegate.

The page is also still the single place the client projections are started: `ngOnInit` calls
`connect()` on rooms, spaces, invites, crypto, presence and notifications, so read it before
adding another projection to the shell.
