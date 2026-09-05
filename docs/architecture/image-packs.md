# Contribute to image-pack presentation

Use this guide when changing the sticker/custom-emoji picker or its Settings manager.
Trinity consumes MSC2545 room image packs and lets an Account install references for use
across Rooms. It does not author packs, copy their contents into local preferences or modify
publisher pack state. For the person using these controls, see
[Stickers & Emoji settings](../users/settings.md#stickers--emoji) and
[sending more than text](../users/messaging.md#sending-more-than-text).

## Choose the owning API

Image-pack data belongs to `@trinity/data-access/media`; presentation uses the public Trinity
component tier described in [UI and theming](ui-and-theming.md). Keep SDK access and publisher
metadata parsing in data access. Use these owners when changing behavior:

| Task                                                                            | Owner                                                                                               | Contract                                                                                                                |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Show packs available in a Conversation                                          | [ImagePackService](../../libs/data-access/media/src/lib/image-pack.service.ts)                      | Read `packsFor(roomId)`; pair `connect(roomId)` with `disconnect(roomId)` for each surface lifetime.                    |
| List installed references, discover, install, uninstall or change enabled usage | [ImagePackManagementService](../../libs/data-access/media/src/lib/image-pack-management.service.ts) | Read `installed`; pair management `connect()`/`disconnect()`. Subscribe to its cold commands for explicit user actions. |
| Parse candidate addresses, status and selection documents                       | [Management model](../../libs/data-access/media/src/lib/image-pack-management.model.ts)             | Preserve validation bounds, stable/legacy precedence and removable invalid references.                                  |
| Share a recently confirmed account-data write between manager and picker        | [ImagePackSelectionStore](../../libs/data-access/media/src/lib/image-pack-selection.store.ts)       | Internal, client-keyed server-readback snapshot; not a product preference store.                                        |

The picker combines Account-installed sources with pack state in the current Room. It watches
relevant state, account-data and own-membership changes. Leaving a source Room makes its pack
unusable even if the SDK retains the old state. Deduplicate stable/legacy aliases and repeated
sources before presentation.

The manager deliberately lists more than the picker: unavailable, missing, malformed and empty
references remain visible so they can be removed. Do not filter these away because they cannot
currently render an image.

## Preserve scope and explicit discovery

Scope is per usage (`emoticon` or `sticker`), not one label for an entire pack. An Account-enabled
sticker source appears as **All rooms**; a Room-published source appears as **This room**.
Disabling Account-wide sticker usage does not hide a Room's own copy of that source in that Room.
Trinity derives supported usage from pack metadata and applies it to every parsed image;
it does not interpret per-image usage overrides. Custom-emoji composition is not implemented:
the picker currently sends pack images as stickers, even though enabled usage is tracked
separately for stickers and emoticons.

The picker's **Manage** action only prefills the Settings source field. **Find packs** is the
explicit action that may resolve an alias, join its Room and fetch authoritative room state.
A join is participant-visible Matrix membership. Discovery does not undo that join if the Room
has no usable pack. Offer available and empty candidates; malformed state is not installable.
Uninstall removes only the exact Account reference: it does not leave the source Room, delete
its media or edit its pack state.

## Understand the two protocol layers

| Scope        | Preferred event      | Read-only legacy fallback | Meaning                                          |
| ------------ | -------------------- | ------------------------- | ------------------------------------------------ |
| Room state   | `m.room.image_pack`  | `im.ponies.room_emotes`   | Publisher metadata, usage and image declarations |
| Account data | `m.image_pack.rooms` | `im.ponies.emote_rooms`   | References enabled across Rooms                  |

Account data maps a Room ID and state key to an object. A new reference is exactly `{}`;
installing an existing one preserves its object and extension fields. Trinity's optional
`eu.qwky.trinity.enabled_usage` array restricts enabled publisher-supported usages. A missing
key enables all supported usages; an empty array disables them in Trinity without uninstalling.

Precedence differs between the layers:

1. Any preferred Account event suppresses the legacy Account event wholesale. A legacy
   reference cannot revive something removed from the preferred event.
2. Preferred Room state suppresses legacy state only for the same state key, including when
   the preferred event is empty or malformed. Other legacy keys remain eligible.

Preferred Account leaves must be objects. The legacy boolean `true` form is accepted only
when reading `im.ponies.emote_rooms`. Keep stable writes and compatibility reads separate.

## Keep parsing and rendering bounded

The source validator accepts `!room:server` and `#alias:server`, including ports and bracketed
IPv6 server names. It rejects missing sigils/separators, whitespace, empty parts and input over
1,024 characters. Alias resolution and the homeserver still make the authoritative decision.

| Parser/presentation bound                        | Limit |
| ------------------------------------------------ | ----: |
| Source/picker packs retained                     |   100 |
| Usable images in one pack                        |   500 |
| Usable images across one picker                  | 1,000 |
| Newly selectable state key, UTF-8 bytes          |   255 |
| Retained display name, attribution and shortcode |   256 |

New state keys reject control characters and oversized identities rather than truncating them.
The manager keeps existing malformed references with bounded labels so removal remains possible.

Only a valid primary `mxc://` image URL can become a rendered picker entry. Names and attribution
stay text; publisher metadata never becomes HTML. Resolve image bytes through the media
capability rather than inserting arbitrary HTTP URLs into the DOM. The publisher's full `info`
object is preserved in the outgoing `m.sticker` event, including nested URL-shaped fields.
Trinity does not render those nested fields, but recipients choose how to consume them.

## Mutate Account references without overstating consistency

Matrix account-data writes have no compare-and-swap or revision precondition. The management
service reduces lost updates through a per-client promise queue and verified merge:

1. Directly GET the preferred Account event. The SDK's post-sync account-data helper can
   answer from a stale local cache, so it is not used for this read.
2. If absent, directly read legacy data and migrate valid references.
3. Merge the requested install, uninstall or usage change. Preserve valid unknown top-level
   and per-reference fields; prune empty Room maps. Write only `m.image_pack.rooms`.
4. Use a raw account-data PUT, then directly GET the complete document. This avoids SDK
   comparison assumptions for unusual valid keys and does not wait for a sync echo.
5. Require the returned JSON document to match the whole expected merge. A visible conflicting
   update causes another read/merge/write/verify attempt, up to three attempts; exhaustion
   reports a visible conflict error.

A change that lands between Trinity's GET and PUT can still be overwritten without evidence,
and another client can write after successful verification. Neither serialization nor readback
makes this an atomic or conflict-free operation.

A successful readback populates the client-keyed selection snapshot so the picker need not wait
for the SDK cache to catch up. The snapshot is server-confirmed, not optimistic. A subsequent
preferred account-data event clears it; otherwise it expires lazily on read after 30 seconds.
There is no scheduled expiry event that forces an idle view to refresh at exactly that time.

## Account and subscription lifetimes

Picker and manager read models use active-client projections that rebuild on Account changes.
The selection store itself is a `WeakMap` of snapshots keyed to client instances, not another
projection. Management commands capture the client when subscribed, keeping remote writes on
that Account even if the Active Account changes while a request is pending.

These commands wrap Promises: unsubscribe does not cancel an in-flight join or Account write.
The manager's mutation completion also writes `installedState` from its captured client without
a generation check. Do not infer that all late results are hidden after an Account switch merely
because the normal projection reattaches. Preserve explicit surface cleanup and treat stronger
cancellation/result-isolation guarantees as an implementation change, not an existing contract.
See [runtime lifetimes](state-and-reactivity.md) for the shared projection rules.

## Retain trust and privacy feedback

Installation pins a source, not its contents. A publisher with sufficient power can replace or
delete the pack later; keeping a broken reference removable does not make that source trusted.
Preserve the advice to use trusted sources and the disclosure of discovery's possible join.

Pack images are ordinary homeserver media, outside Matrix event E2EE even when the `m.sticker`
event is encrypted. Relevant homeservers can see and serve those bytes. Keep the encrypted-Room
sticker warning. Do not call every pack anonymously public: access policy varies by deployment.

Pack authoring is not supported. Adding it would require data-access writes with the Room's
state-event authorization, rather than a picker-only feature or direct SDK call from a component.

## Verify a picker or manager change

Use [contributor validation](../contributing/testing.md) for the complete change-based policy.
The existing Media tests cover parsing, bounds, precedence, legacy migration, exact writes,
extension-field preservation, queues, readback and failure handling. Settings tests cover
explicit submission, in-flight results, usage controls, focus recovery, accessibility feedback
and uninstall disclosure. Test Account switching separately from ordinary same-Account success.

The [shared management journey](../../e2e/support/image-pack-management-journey.mts) is used by
Chromium, installed Android WebView and the built Electron shell. Its assertions cover alias
resolution/joining, multiple keys, precedence, enable/disable feedback, Account/Room scope,
sticker sending, uninstall, empty preferred Account data and unchanged publisher state.
The Web/Android wrapper additionally checks a second installed same-Account client; Electron
omits that assertion because of its single-instance lock. The journey does not prove atomic
conflict freedom or every late-result race.

Use the [E2E task guide](../../e2e/README.md) to choose the owning journey and the
[host guides](../platforms/index.md) for prerequisites. For isolated public-control rendering
and keyboard checks, use [Storybook](../../libs/components/storybook-host/README.md); a catalog
canvas does not exercise Matrix membership or Account-data consistency.
