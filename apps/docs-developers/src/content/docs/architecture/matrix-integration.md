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

The `AccountRuntimeService` restores saved accounts and coordinates the active account. Startup waits only for the active account when it restores; the inactive accounts then restore in the background. Until they have finished, sign-in, sign-out, account removal, installation reset and account deletion are refused with `transition-in-progress`, and a session handover waits. Switching is refused only to an account still restoring, in that background run or in a retry of a failed restore (`AccountRuntimeService.restoringAccountIds`). The account switcher and “Accounts in view” show that account, and adding or removing one, disabled with “Loading…” until it settles. When the active account cannot be restored, the inactive accounts restore within startup, as before, so the recovery screen's actions are not refused. The Matrix client registry owns live client instances and their sync lifecycle. On iOS and Android, where the system suspends a backgrounded app and push wakes it, `BackgroundSync` stops every account's sync loop when the app goes to the background and restarts each from where it stopped on return, the active account first; sends, uploads and crypto carry on. Each restart waits for the stopped loop to finish what it was processing, never reports the old loop's stop, and begins with an immediate catch-up sync. A session handover's pause outlasts that return. Android keeps syncing until push delivers there, because until then its sync is what notifies; the web and desktop keep syncing in the background. Capability code resolves the client for an explicit account or follows the selected-account projection appropriate to its scope.

Each live account keeps its sync cache in its own IndexedDB database (`syncStoreDbName`). The SDK loads and saves that cache in a worker (`sync-store.worker.ts`), so a large account's cold start and its saves every five minutes do not block the main thread. A worker that reports an error or leaves any request unanswered for `SYNC_STORE_REQUEST_TIMEOUT_MS` is treated as dead and stopped. During startup the store then runs on the main thread; after startup its waiting requests fail and the store continues in memory, so sync carries on without the cache until the next start. Room members loaded on demand and queued to-device messages are then kept only in memory and do not survive a reload.

Never use the active account implicitly for work that already has an account identifier. Room and event identifiers alone do not establish which authenticated client owns an operation.

## Adapt SDK state at the boundary {#adapt-sdk-state}

Data-access services translate SDK objects and events into stable Trinity read models and commands. Feature and component code consumes those public models; it does not expose SDK objects through UI APIs or attach competing SDK listeners.

For active-client projections, the shared `projectFromClient` adapter coordinates client replacement, event attachment, burst coalescing, reconciliation, and reset. Other scopes use their matching owned projection lifetime.

## Treat synchronization as authoritative {#sync-authority}

Commands call the SDK and then allow sync or the relevant SDK event to reconcile current state. Preserve a typed error or outcome for the initiating action, but do not claim that an accepted network request has already become authoritative local state unless the SDK contract guarantees it.

Authentication, persistence, and cryptographic storage require stronger lifecycle rules than ordinary Matrix reads. When a homeserver offers both OAuth 2.0 sign-in and legacy SSO, Trinity prefers OAuth 2.0, because only that flow lets the client check that the sign-in response comes from the provider it started with. Continue with [encryption and trust](../encryption-and-trust/). For signal and command behavior, read [state and reactivity](../state-and-reactivity/).

## Calls {#calls}

`data-access-calls` runs MatrixRTC calls by embedding the bundled Element Call (`@element-hq/element-call-embedded`, served from `element-call/`) as a trusted widget. `CallService` holds the one active call for the app. The widget driver answers Element Call only for the call's room, the user's own `call.member` state keys, and the event and to-device types Element Call needs; widgets from room state keep the restricted widget driver. The driver reaches Matrix only through the `CallTransport` port, never `MatrixClient`, so another engine can implement the same port; `MatrixCallTransport` is the `matrix-js-sdk` adapter. `matrix-widget-api` and the call runtime load only when a call starts, which `scripts/lazy-vendor-imports.spec.mjs` checks.

An app-level `CallHostComponent` in `application-runtime` (loaded with `@defer (on idle)`) owns the one iframe, so the call survives navigation. It lays the iframe `position: fixed` over the element the rooms page registers through `CallStageService` (`[trnCallStage]`), or over the video slot of a dock bar laid out in flow at the bottom of `.app-frame` (so it never covers the page) when no stage is registered or a panel page covers the conversation. The dock's **Hide video** lays the iframe off-screen, so the audio continues; video starts hidden below md. Only the iframe's style changes: it is never re-parented or re-created while a call runs. Switching account or signing out ends the call. Participant counts come from `org.matrix.msc3401.call.member` state (`callParticipants`, `CallService.participants`), and `CallService.callAvailable` reports whether the server's `/rtc/transports` list is non-empty (no well-known fetch; an unsupported endpoint or a failed lookup counts as available), which the room header uses to disable its call button.
