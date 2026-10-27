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

Creating a room or DM, leaving and tagging show their effect in `rooms()`, open subscriptions included, before the command replies. Marking a room unread or read writes account data, which shows once `/sync` returns it. Every command on an account that is not live returns `account-not-live`. One contract, `defineRoomListEngineContract`, runs against `FakeRoomListEngine` in unit tests and against Synapse in `trinity-e2e-engine:contract`.

| Stream                 | Emits                                                         |
| ---------------------- | ------------------------------------------------------------- |
| `rooms(accountId)`     | `VectorDiff<RoomInfo>` batches, a `reset` first               |
| `typing(accountId)`    | joined room id to the members typing in it, own user included |
| `directMap(accountId)` | the account's `m.direct` map, left rooms included             |

## Treat synchronization as authoritative {#sync-authority}

Commands call the SDK and then allow sync or the relevant SDK event to reconcile current state. Preserve a typed error or outcome for the initiating action, but do not claim that an accepted network request has already become authoritative local state unless the SDK contract guarantees it.

Authentication, persistence, and cryptographic storage require stronger lifecycle rules than ordinary Matrix reads. When a homeserver offers both OAuth 2.0 sign-in and legacy SSO, Trinity prefers OAuth 2.0, because only that flow lets the client check that the sign-in response comes from the provider it started with. Continue with [encryption and trust](../encryption-and-trust/). For signal and command behavior, read [state and reactivity](../state-and-reactivity/).
