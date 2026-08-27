# Image packs

Trinity implements the client side of MSC2545 image packs in
`@trinity/data-access/media`. A pack is room state owned by its publisher; an account-wide
installation is only a reference to one room ID and state key. The application never copies a
pack into local settings and never creates or edits `m.room.image_pack` state.

This page records the precedence, mutation and trust rules that are easy to lose when changing
the picker or manager. User-facing behavior is covered under
[Settings](../users/settings.md#stickers--emoji) and [Messaging](../users/messaging.md#sending-more-than-text).

## The two layers of MSC2545 data

| Scope        | Stable event         | Read-only legacy fallback | Meaning                                      |
| ------------ | -------------------- | ------------------------- | -------------------------------------------- |
| Room state   | `m.room.image_pack`  | `im.ponies.room_emotes`   | Pack metadata, usages and image declarations |
| Account data | `m.image_pack.rooms` | `im.ponies.emote_rooms`   | Packs selected for use in every room         |

The account event maps a room ID and state key to an object. Trinity writes each new leaf as
exactly `{}`. The object shape is deliberate extension space, so an install preserves an existing
object rather than replacing unknown future fields.

The two legacy fallbacks obey different precedence rules:

1. If stable account data exists at all, it suppresses the legacy account event wholesale. A
   stale legacy reference cannot bring back a pack removed from the stable event.
2. Within a source room, stable state for one state key suppresses legacy state for that same key,
   even when the stable event is empty or malformed. Other legacy state keys remain eligible.

Stable account leaves must be objects. The old boolean `true` representation is accepted only
while reading `im.ponies.emote_rooms`.

## Three services, three responsibilities

`ImagePackService` is the picker projection. Callers ask for `packsFor(roomId)`, connect while the
surface is alive, and read a signal. The projection combines:

- account-selected packs, which are available in every room for the active account; and
- pack state published by the current room, which is available there without installation.

It listens for relevant room-state, account-data and own-membership changes. A left source room is
not usable even if the SDK retains its state in memory. Stable/legacy aliases and repeated sources
are deduplicated before the picker sees them.

`ImagePackManagementService` owns Settings. Its installed signal is intentionally broader than the
picker projection: it retains unavailable, missing, malformed and empty references so the user can
remove them. Discovery validates a room ID or alias, resolves an alias, joins when the active
account is not already a member, then calls the authoritative `roomState` endpoint. It can return
available and empty candidates; malformed state is not offered for installation.

The query parameter used by the picker's **Manage** action only prefills the source field. It must
never start discovery or membership by itself. Choosing **Find packs** is the explicit action that
may join the room. A join is ordinary participant-visible Matrix membership and is not rolled back
when discovery finds no usable pack.

`ImagePackSelectionStore` bridges the gap between a confirmed HTTP write and the SDK sync echo. It
holds a short-lived, server-confirmed stable account-data snapshot keyed by `MatrixClient` so the
picker and manager update immediately. It is not optimistic state: the store is populated only
after readback confirms the requested reference state. The stable account-data event clears it,
and an unconsumed snapshot expires after 30 seconds.

All three are active-client projections. Switching accounts rebuilds them from the new
`MatrixClient`; installed references and source-room membership therefore never leak between
accounts.

## Discovery and validation bounds

The room address validator accepts `!room:server` and `#alias:server` forms, including server names
with explicit ports or bracketed IPv6. It rejects missing sigils or separators, whitespace, empty
parts and input longer than 1,024 characters. Alias resolution and the homeserver remain the
authoritative validators.

Pack parsing is deliberately bounded before UI rendering:

| Bound                     | Limit |
| ------------------------- | ----: |
| Account/source packs      |   100 |
| Images read from one pack |   500 |
| Images across one picker  | 1,000 |
| Display text              |   256 |

Only `mxc://` image URLs with a server and media ID are accepted. Names, attribution and image info
remain text/data; the UI never renders publisher metadata as HTML. Media resolution continues
through the media data-access path rather than placing arbitrary remote HTTP URLs in the DOM.

## Account-data mutation is best effort

Matrix account-data PUT has no compare-and-swap or revision precondition. Trinity reduces lost
updates but cannot make them impossible:

1. Mutations are queued per `MatrixClient`, so two operations from this application do not race.
2. Every attempt performs a direct authenticated GET of the stable account event. The SDK's
   `getAccountDataFromServer()` helper is not used because it reads the local store after initial
   sync and can lag another device.
3. When stable data is absent, one direct GET reads legacy data and valid references are migrated.
4. The requested reference is merged into the fresh stable document. Valid unknown top-level and
   per-reference stable fields are preserved, empty room maps are pruned, and only
   `m.image_pack.rooms` is written.
5. The SDK PUT is followed by another direct GET. If the requested reference is not in the desired
   state, Trinity repeats the read, merge, write and verification, for at most three attempts.
6. Repeated failure becomes a visible conflict error rather than a false success.

This protects against stale local sync state and catches many overlapping writes. It is not an
atomic guarantee: another client can still write after Trinity's successful verification and win.
Do not describe the implementation as conflict-free.

Uninstall removes only the exact account reference. It never leaves the room, deletes media, or
edits pack state. Installing likewise writes no room pack state; the only possible room-state
change in this workflow is the membership event caused by joining.

## Trust and privacy boundaries

Installation pins a source, not its contents. A room publisher with sufficient power can change or
delete the pack later. The manager keeps the resulting broken reference visible, but it cannot make
an untrusted publisher safe. The user documentation therefore tells people to install only from
sources they trust.

Pack images are ordinary homeserver media rather than encrypted attachments. Relevant homeservers
can see and serve those bytes even when the `m.sticker` event carrying the MXC reference is encrypted
inside the room. This is why the encrypted-room sticker flow keeps its warning. Do not call all pack
media anonymously public: server access policy and deployment vary, while the important invariant is
that the bytes are outside Matrix event E2EE.

Pack authoring is out of scope. If it is added later, publishing or editing room state belongs in
the data-access layer and must enforce the room's state-event power levels.

## Test ownership

Unit tests in `libs/data-access/media` own parsing, bounds, precedence, legacy migration, exact
stable writes, preservation, serialization, server readback and failure behavior. Settings tests
own explicit submission, in-flight results, accessibility feedback and removal disclosure.

`e2e/playwright/stickers-custom-emoji.spec.mts` is a canonical journey collected by both Chromium
and the installed Android WebView. It proves alias resolution and joining, multiple state keys,
stable-over-legacy deduplication, immediate composer availability, sticker sending, uninstall,
final empty stable account data, and survival of the publisher's source state. It does not prove
another-device propagation or atomic conflict freedom.

Focused commands and native prerequisites are kept in [`e2e/README.md`](../../e2e/README.md).
