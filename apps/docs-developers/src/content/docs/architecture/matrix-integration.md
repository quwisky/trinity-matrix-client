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

## Engine interfaces {#engine-interfaces}

Each data-access capability reaches Matrix through an engine interface, so another engine can implement it later ([#1153](https://github.com/quwisky/trinity-matrix-client/issues/1153)). The `matrix-js-sdk` adapter for a capability lives in its `js-sdk/` folder; only those folders reach the SDK. Reach means importing `matrix-js-sdk`; importing `ConnectionError`, `HTTPError` or `MatrixError` from `@trinity/util/matrix`, which re-exports those SDK classes; calling `clientFor` or `detachedClient`, reading `matrix.instance`, or indexing `MatrixClientService['clientFor' | 'instance' | 'all' | 'detachedClient']`; and calling `.all()` in a file that references `MatrixClientService`. Specs and `*.spec-harness.ts` files do not count. `architecture/engine-boundary-allowlist.json` lists the files that still reach the SDK. It only shrinks: a new offender and a stale entry both fail `scripts/engine-boundary.spec.mjs`.

Values crossing an engine interface are plain data: strings, numbers, booleans, `null`, arrays, and plain objects. No `undefined`, `Date`, `Map`, `Set`, class instances, or functions.

A command is a cold observable that emits one result and completes. Expected failures arrive as `{ ok: false, failure }` with an `EngineFailure`: a `kind`, a `code` (`EngineFailureCode`), privacy-safe `diagnostic` metadata and plain-data `params` typed per code, never text. TypeScript owns the copy: `engineFailureMessage` in `@trinity/util/matrix` is the one table that turns a failure into user-facing words, so a Rust engine returns the same codes. Only unexpected faults error the stream. A subscription emits a snapshot first and changes after it. Media never crosses as bytes: commands return a URL the webview can load, and uploads take a Blob or File handle. Synchronization stays authoritative: a command's result does not replace the state that sync reconciles.

### Session engine {#session-engine}

`SessionEngine` (`libs/data-access/matrix-client`) exposes the live accounts as plain data. `session()` emits a `SessionSnapshot` (active account, per-account status, soft-logged-out ids) and every change after it. Access tokens never enter the snapshot: `accessToken(accountId)` is a separate stream. Lifecycle commands are cold, and every lifecycle command's effect is in the next `session()` snapshot before it replies. `signOutAll` revokes the tokens and leaves the accounts live until `stop()`. `SESSION_ENGINE` provides the `matrix-js-sdk` adapter.

| `SessionSyncState` | js-sdk state                                       | Rust `SyncService` state    |
| ------------------ | -------------------------------------------------- | --------------------------- |
| `starting`         | none yet (live client before its first transition) | Idle (or `stopped`)         |
| `prepared`         | Prepared                                           | room list loaded from cache |
| `syncing`          | Syncing                                            | Running                     |
| `catchup`          | Catchup                                            | unused                      |
| `reconnecting`     | Reconnecting                                       | Offline                     |
| `error`            | Error                                              | Error                       |
| `stopped`          | Stopped                                            | Terminated (or Idle)        |

Plain-data readers use `SessionStateService`, which turns the snapshot into signals. Capability adapters still get SDK clients through `JS_SDK_CLIENTS` or `MatrixClientService` until their slice moves them to an engine. `architecture/session-facade-allowlist.json` lists the files that still import `MatrixClientService`; it only shrinks, and `scripts/session-facade.spec.mjs` fails on a new caller and on a stale entry. Removal is tracked in [#1153](https://github.com/quwisky/trinity-matrix-client/issues/1153). `holdServerLogout` stays on the facade until the authentication slice.

### Room list engine {#room-list-engine}

`RoomListEngine` (`libs/data-access/room-library`) exposes an account's joined, invited and knocked rooms as plain `RoomInfo` rows. Its streams take an account id and emit a snapshot first: `rooms()` emits `VectorDiff` batches that start with a `reset`, while `typing()` and `directMap()` emit whole maps. `RoomListStore` holds one subscription per live account, and `ROOM_LIST_ENGINE` provides the `matrix-js-sdk` adapter.

Creating a room, space or DM, joining, leaving and tagging show their effect in `rooms()`, open subscriptions included, before the command replies; writing a space child link, or creating a room inside a space, shows in `spaceChildLinks()` the same way. `spaceHierarchy()` reads a space and its direct children from `/hierarchy`, page by page, and fails rather than loop when the server repeats a page token. Marking a room unread or read writes account data, which shows once `/sync` returns it. Every command on an account that is not live returns `account-not-live`. One contract, `defineRoomListEngineContract`, runs against `FakeRoomListEngine` in unit tests and against Synapse in `trinity-e2e-engine:contract`.

| Stream                                | Emits                                                         |
| ------------------------------------- | ------------------------------------------------------------- |
| `rooms(accountId)`                    | `VectorDiff<RoomInfo>` batches, a `reset` first               |
| `typing(accountId)`                   | joined room id to the members typing in it, own user included |
| `directMap(accountId)`                | the account's `m.direct` map, left rooms included             |
| `spaceChildLinks(accountId, spaceId)` | the space's live `m.space.child` links in spec order          |

### Timeline engine {#timeline-engine}

`TimelineEngine` (`libs/data-access/timeline`) exposes one room's timeline as plain `TimelineItem`s: event items plus the virtual `readMarker` and `timelineStart` items; date dividers stay on the feature side. `timeline(accountId, roomId, focus)` emits `room-unavailable` until the account holds the room, then `VectorDiff<TimelineItem>` batches that start with a `reset` and carry the back-pagination state and room state. A back-pagination emits `paginating` with no diffs, then the page's diffs and the next state in one update, so older rows and the loading flag change together; the reply follows that update. Every command replies only after its effect is in each open `timeline()` subscription, and on an account that is not live returns `account-not-live`. A send's local echo is in `timeline()` before `send` replies, and its item keeps its `uniqueId` when the remote echo replaces it; a send that fails keeps its echo, with its send state, for `retrySend` or `cancelSend`. `TimelineStore` holds one subscription per open conversation and freezes the "New messages" anchor at the first `readMarker` it sees, so reading the room does not move the divider. `TIMELINE_ENGINE` provides the `matrix-js-sdk` adapter. One contract, `defineTimelineEngineContract`, runs against `FakeTimelineEngine` in unit tests and against Synapse in `trinity-e2e-engine:contract`.

| Event item field            | Holds                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `uniqueId`                  | an id that stays stable from local echo to remote echo                                          |
| `eventId`, `transactionId`  | the server id once known, and the transaction id, kept on the remote echo on the sending device |
| `sender`, `isOwn`           | the sender's user id and whether it is the account                                              |
| `timestamp`, `sendState`    | the origin time, and `sending`, `waiting` or `failed` for an own unsent echo                    |
| `content`                   | a tagged union: message, media, sticker, location, poll, state, redacted, etc.                  |
| `edited`, `inReplyTo`       | whether an edit replaced the body, and the quoted event and its details                         |
| `reactions`, `readBy`       | grouped reaction keys with capped senders, and the readers whose receipt sits here              |
| `shield`, `unencryptedMark` | a shield code (colour and reason) rather than text, and the unencrypted mark                    |
| `profiles`                  | display name and avatar for every user the item names                                           |

### Room widget engine {#room-widget-engine}

`RoomWidgetEngine` (`libs/data-access/widgets`) exposes a room's `im.vector.modular.widgets` declarations. `roomWidgets(accountId, roomId)` emits a whole `RoomWidgetSnapshot` on each change: the widgets, whether the account may manage them, and the identity a widget URL may request. An account that is not live gets an empty snapshot. `putRoomWidget` fails with `state-key-taken` when room state already holds the id, and `removeRoomWidget` fails with `conflict` once the widget's live revision is no longer the one the caller confirmed. `WidgetsService` subscribes again when the account gets a new client, and `ROOM_WIDGET_ENGINE` provides the `matrix-js-sdk` adapter. One contract, `defineRoomWidgetEngineContract`, runs against `FakeRoomWidgetEngine` in unit tests and against Synapse in `trinity-e2e-engine:contract`.

### Media engine {#media-engine}

`MediaEngine` (`libs/data-access/media`) moves media bytes. `content(accountId, request)` mints a fresh URL the webview can load on every subscription and keeps no cache; the subscriber owns it until `release` (a `blob:` URL in the `matrix-js-sdk` adapter). It fails with `media-unavailable` when there is no source or an encrypted file fails its hash check. `upload` is a command with progress: zero or more `progress` updates, then one `done` carrying the result, and unsubscribing aborts it. An encrypted upload sends neither its name nor its type, and an upload over the server's limit fails with `too-large`. `MediaService` and `AvatarService` keep their URL caches, pins and byte cap over it: `MediaService` keys an entry by account, session generation and source, so a re-login never reuses a URL from the session before, and both hand every URL they drop back through `release`. `MEDIA_ENGINE` provides the `matrix-js-sdk` adapter. One contract, `defineMediaEngineContract`, runs against `FakeMediaEngine` in unit tests and against Synapse in `trinity-e2e-engine:contract`; `assertProgressThenResult` checks the shape of a progress command.

## Treat synchronization as authoritative {#sync-authority}

Commands call the SDK and then allow sync or the relevant SDK event to reconcile current state. Preserve a typed error or outcome for the initiating action, but do not claim that an accepted network request has already become authoritative local state unless the SDK contract guarantees it.

Authentication, persistence, and cryptographic storage require stronger lifecycle rules than ordinary Matrix reads. When a homeserver offers both OAuth 2.0 sign-in and legacy SSO, Trinity prefers OAuth 2.0, because only that flow lets the client check that the sign-in response comes from the provider it started with. Continue with [encryption and trust](../encryption-and-trust/). For signal and command behavior, read [state and reactivity](../state-and-reactivity/).
