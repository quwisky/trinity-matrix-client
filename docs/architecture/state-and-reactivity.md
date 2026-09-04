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
is comment-only and says so, and Application Runtime's `provideTrinityApplication()` provides
`provideZonelessChangeDetection()`.

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
and completes only when every new generation has acknowledged. Workspace validates and projects
its canonical destination as Account preparation; Active Account switching then commits the
persisted and live pointers and waits on `transition({ kind: 'active-account' })` before Workspace
publishes the requested Room, Space, and pane view.

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
handle freezes that key and exposes named timeline, compose, message, media, thread and pin
children; it never reads the route and never retargets when Active Account changes.
`WorkspaceNavigationService` owns one immutable Account, scope, Room, pane, and event-target view
for the application lifetime. Room-shell Account,
scope, Room, compact-list, removal, shortcut, hop, and Back actions submit semantic intent with
exact ownership. Visit history also stores the Account-and-Room pair rather than a Room id alone.
Workspace resolves each intent into scope retention, pane, history, canonical URL,
Account readiness, and Conversation focus. Its transition workflow focuses the exact Conversation
only after Account readiness and canonical URL navigation settle, or blurs the current handle when
the Room leaves Workspace. `RoomShellNavigationService` remains a small presentation adapter for
focus handoff, overlay cleanup, and typed failure feedback; it does not own semantic state or
routing. Feature surfaces consume `ConversationRuntime.timeline`, a stable proxy for the focused child, rather than
injecting the child implementation or a root timeline singleton.
When a create or invite request succeeds before `/sync` has published the Room, Workspace crosses
Room Library's bounded exact-Account readiness barrier before opening it. The barrier listens for
the SDK Room, fails with typed metadata when sync stops or the deadline expires, and always removes
its listeners; Workspace therefore never focuses an empty Conversation or waits indefinitely.
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

Message relations and actions enter through the same handle's `messages` surface. Reply and edit
intent begin only when the immutable Message Presentation model still says the target is eligible;
reaction toggles, redactions, failed-send retries and read acknowledgements are cold, finite RxJS
commands keyed to that handle's frozen Account-and-Room identity. Expected failures are typed
outcomes with retryability and no exception or event-content metadata. The Matrix adapter re-reads
the target and the current user's reaction from the SDK when subscribed, so SDK relation events
remain authoritative and Trinity creates no second relation store. The focused proxy also resolves
on subscription, while a command invoked through a retained exact handle is rejected rather than
silently retargeted.

Conversation owns the command orchestration, not room authority. Its redaction port is implemented
by Room Administration and bound in the application composition root; the adapter delegates each
event decision to the SDK RoomState policy before sending. Timeline projection asks that same port
for the moderator affordance. Automatic main-timeline receipts use the Conversation adapter too,
including the public/private privacy choice and persisted fully-read marker, and only advance the
local dedupe marker after the typed command succeeds. Closing the child cancels its in-flight
receipt subscription. Relation and receipt updates then arrive through the existing SDK listeners
and are projected back into immutable `MessageView` values.

Threads are one further keyed child: `threads.forRoot(rootEventId)` returns an immutable
Account-and-Room-and-root handle. Only one root child is live per Conversation. Navigating to a
different root, blurring the parent, eviction and runtime teardown permanently release the old
generation; a command assembled before release rejects when subscribed rather than reaching a
new thread. Text send/edit/reply use the package-internal thread adapter, while reactions,
redactions and retry reuse the Conversation message adapter with the exact root key. Thread
attachments reuse Media Pipeline with that same root in its transfer target, so retry state and
Matrix transaction ids cannot cross between the room and a thread.

Pinned messages are the handle's `pins` child, not a root service. It projects
`m.room.pinned_events` and resolves display rows from the exact Room's SDK store. Pin and unpin are
cold typed commands; Room Administration supplies the current `maySendStateEvent` decision
through a composition-root port. Successful requests do not publish optimistic state: the next
authoritative room-state event does. Unpin may remove an unloaded or redacted stale id, while a
new pin must resolve to a message in that Conversation.

## Room Administration

Room Administration owns authoritative joined-member and ban summaries, role classification and
assignable presets, aliases, power-level policy, room configuration, and the redaction/pin decisions
used by Conversations. Its membership projection listens to Matrix room-state events and publishes
per-Room read-only signals; successful moderation waits for the SDK sync echo instead of editing a
membership view optimistically.

Configuration and moderation commands are cold finite RxJS Observables. Permission is re-read from
the latest Room state inside subscription, and failures carry value-safe recovery metadata for
permission refresh, invalid input, homeserver rejection, and a completed upload whose later avatar
state write failed. The application composition root adapts Room Administration into Room Library's
invite/space-curation policy and Conversations' redaction/pin policies, so neither capability imports
the governance implementation.

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
those effects but leaves the bounded main-timeline listeners attached, so that projection remains
warm. Thread summaries and pins detach and clear on blur, then reconcile from the exact Room when
focus returns; an open root child is also permanently released. Each
Account retains at most two blurred handles in least-recently-used order. A retained child keeps
the latest 100 raw timeline events in its application projection and at most 200 sender
dependencies; focusing it rebuilds the complete loaded projection from `matrix-js-sdk`, which
remains authoritative. In a browser that is 11 listeners and at most 11,200 deterministic modeled
bytes per retained handle, or 22 listeners and 22,400 bytes for the two-entry per-Account retained
set. A focused handle adds eight thread-summary listeners and three pin listeners; an opened root
adds another eleven thread listeners. Their focused payload diagnostics count projected summaries,
pin ids, resolved pin rows and thread messages, but none enter the retention-memory baseline.

Eviction marks the exact handle `retired`, removes it from the keyed registry and destroys its
child injector. That object can never become focused again; reopening the same key creates a new
handle. Runtime teardown performs the same release for every remaining child. Diagnostics report
the last synchronous attach-to-presentable duration, active/focused/retained/retired handle counts,
total listeners and retained modeled bytes without recording Account ids, Room ids or content.
Remaining transitional timeline actions stay cold RxJS Observables and resolve the focused child
on subscription; message relations and actions no longer use that singleton surface.

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

Application Runtime owns one cold `RoomLibraryLifetime` after Account restoration. The lifetime
connects joined Rooms, Spaces, invitations, Space hierarchy and the selected-Account view, then
waits on Projection Runtime's finite `active-account` barrier before Workspace restores its
destination. It stays subscribed for the complete ready session, so Active Account transitions
reattach and acknowledge the same projections without restarting Application Runtime. A blocked
barrier, later blocked startup stage, stop, or destruction releases the selected sources and each
runtime lease exactly once; a retry or restart creates one fresh generation. Exact Conversation
children remain demand-owned and are not part of this preparation lifetime.

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
    the coordinated path, and it still flushes after those legacy mutations. Migrated product flows
    use `WorkspaceNavigationService.navigate()`; its `ready` outcome follows canonical URL preparation, Account
    commit, synchronous Projection Runtime reattachment, generation acknowledgement, and atomic
    Workspace view publication. Consumers can therefore act on `ready` without an
    `afterNextRender` timing workaround.

    Global Search, notification activation, native push, inbound restoration, Account actions, and
    Room surfaces all enter through the same cold semantic `navigate()` command. Router access,
    destination resolution, transition joining and rollback, repair, visit-history policy, Media
    release, and Conversation focus remain internal to `@trinity/application/workspace`; no caller
    can supply a destination or history option. The structural Workspace contract guards that
    single seam and the absence of direct Router writes in product callers.

## Who takes the whole primitive, and who takes only the batching

Fourteen services take the full `projectFromClient`:

| Service                        | Library                                    |
| ------------------------------ | ------------------------------------------ |
| `RoomLibraryService`           | `@trinity/data-access/room-library`        |
| `SpacesService`                | `@trinity/data-access/room-library`        |
| `InvitesService`               | `@trinity/data-access/room-library`        |
| `SpaceChildrenService`         | `@trinity/data-access/room-library`        |
| `RoomActionPermissionsService` | `@trinity/data-access/room-administration` |
| `RoomMembersService`           | `@trinity/data-access/room-administration` |
| `TrustService`                 | `@trinity/data-access/trust`               |
| `TrustVerificationService`     | `@trinity/data-access/trust`               |
| `TrustDevicesService`          | `@trinity/data-access/trust`               |
| `IdentityPresenceService`      | `@trinity/data-access/identity`            |
| `ImagePackService`             | `@trinity/data-access/media`               |
| `ImagePackManagementService`   | `@trinity/data-access/media`               |
| `NotificationSoundService`     | `@trinity/data-access/notifications`       |
| `WidgetsService`               | `@trinity/data-access/widgets`             |

The library column is the import alias, and it mirrors the directory:
`@trinity/data-access/room-library` is `libs/data-access/room-library`. The Nx project name is
the third string and keeps the flat hyphenated form, so the command is
`pnpm nx test data-access-room-library`.

Three take **only** `coalesce()`, and each says why at the call site. The split is not arbitrary — it
follows from what the service's lifetime is keyed to:

| Service                      | Keyed to                       | Why the client half does not apply                                                                                                       |
| ---------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `TimelineService`            | One Conversation child         | Package-internal implementation bound to an immutable Account-and-Room handle; Conversation Runtime owns its `open()`/`close()` lifetime |
| `ConversationPinsController` | One focused Conversation child | Conversation Runtime binds its exact Room, detaches it on blur, and reconciles from SDK state on refocus                                 |
| `UnreadAggregatorService`    | The mixed account set          | Same                                                                                                                                     |

`SelectedRoomLibraryService` owns the selected-Account projection path. Its single `view` signal
publishes the effective Account set, active-or-mixed mode, Rooms, Spaces, and invitations as one
read model. A one-Account selection delegates to the active projections without attaching any
additional Matrix listeners. For multiple Accounts, one internal source registry reconciles the
selected and live sets, client replacement, and listener attachment. Shared events attach once per
Account and invalidate the Room, Space, and invitation projectors through one coalescer; a
Room-only event reuses the unaffected Space and invitation slices by identity. Consumers never fan
Account ids into projectors or choose an active versus mixed source.

The domain projectors preserve active-owner preference, every contributing Room Account, the
loudest unread state, unioned Space children, per-Account space-child membership, and every
Account-scoped invitation. Local search and the Room shell's Recent, Home, Rooms, Space, rail,
badge, invitation presentation, action lookup, and shortcut validation read that same generation.
Rows emit exact Account identities; shared-row commands deduplicate and target every contributing
Account, while create, join, permalink, and confirmed-membership flows retain their initiating
Account across asynchronous work. The former public mixed Room, Space, and invitation projections
no longer exist.

The selected Account set is a Room Library-owned typed installation preference. Its command writes
before publishing, so unavailable storage returns typed retry guidance while the prior selected
view remains visible. Stale persisted ids stay stored but are intersected with live Accounts before
they can contribute rows. See [ADR-0009](../adr/0009-selected-room-library-view.md).

`NotificationService` takes neither. It binds per account, with push scoring, own-message
suppression and event dedupe all keyed by account, and an account-set effect in its constructor is
its equivalent of the projection.

The rule to apply when writing a new service: if your listeners follow _the active client_, take
`projectFromClient`. If they follow a room or a set of accounts, take `coalesce` and own the rest.

## A worked example: RoomLibraryService

[`RoomLibraryService`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/data-access/room-library/src/lib/room-library.service.ts)
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

**Three event responses use hand-bound listeners.** `RoomStateEvent.Members` and
`RoomMemberEvent.Typing` stay out of the main event list: a member change schedules the O(rooms)
projection only when a DM peer's profile affects the room row, while typing feeds a separate
per-room coalescer. `RoomEvent.MyMembership` deliberately has both roles — it remains in the main
event list to rebuild rooms after a join or leave, and its hand-bound handler also clears typing
state for a room that was left. Joined-member and ban projections live in `RoomMembersService`, not
Room Library.

**`reset` clears everything the projection owns** — the rooms signal, direct-room ids, DM peer set,
pending typing work, and per-room typing state — so a disconnected service holds nothing stale.
Room Administration independently resets its authoritative membership caches and signals.

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

| Counter                                               | Verdict                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SpacesService._revision`                             | **Removed.** It stood for "which rooms am I in?", which `refresh()` already knew from its own `getRooms()` pass. Now a `_joinedRoomIds` set with structural equality.                                                                                                                                                                                                                              |
| `PinnedMessagesService._revision`                     | **Removed.** It was defended as irreducible — late decryption, no entity-level signal to depend on. But `MatrixEventEvent.Decrypted` _is_ that signal, the service already listened to it, and `TimelineService` solves the same problem on the same event with no counter. `pinnedMessages` is now a signal the resolve writes.                                                                   |
| `ManageSpaceRoomsComponent.revision`                  | **Removed.** A _component_ compensating for a service with no reactive surface. `SpaceChildrenService.linksFor` projects `m.space.child` now. It was never in this list.                                                                                                                                                                                                                           |
| `RoomsService.profileRevision` (was `revision`)       | **Removed** → `AccountIdentitiesService`, which projects display-name/avatar events through the narrow Identity Matrix port per signed-in account. The counter was bumped only by the ACTIVE client while two consumers read _other_ accounts' clients, so a mixed-in account's badge stayed stale until the active account happened to sync — papered over by also reading the unread aggregator. |
| `RoomsService.memberRevision`                         | **Removed** → `membersFor(roomId)`, a signal per watched room written only when a member event names it. It was never a throttle: what makes a re-read cheap is `membersOf`'s fingerprint memo returning the identical array, which `Object.is` stops. Being unfiltered, it woke every member list in the app on any room's member event.                                                          |
| `heightVersion` (`virtual-message-list.component.ts`) | **Kept**, and not a Matrix problem: it invalidates a `Map` a `ResizeObserver` writes. The alternative allocates per measurement. Never previously listed.                                                                                                                                                                                                                                          |
| `RoomShellStore.jumpRequest`                          | **Kept**, and not a Matrix problem either: it re-fires an effect for a jump to a target that has not changed, which is a command and not state. Never previously listed.                                                                                                                                                                                                                           |

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
keyed on ONE active client. `ConversationPinsController` is exact-Conversation-scoped and takes
`coalesce` alone; `membersFor` writes per-room signals from the owning service's own listeners. Where the
projection is keyed on the ACCOUNT SET rather than one active client, reconcile a listener per
account instead (`AccountIdentitiesService`, selected Room Library, `UnreadAggregatorService`) — and
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

Application Runtime now solely owns the Room Library preparation lifetime; the Rooms route no
longer attaches joined Rooms, Spaces, invitations, or Space hierarchy. The page temporarily retains
startup only for Trust, Identity, and Notification projections until their own session lifetimes
migrate. Local notification delivery is not page-owned: the readiness-gated session stream stays
dormant until final readiness and releases every Matrix and host listener on runtime stop.
