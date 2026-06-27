---
name: project-core-lib
description: Structure and conventions of libs/core (@trinity/core), the matrix-js-sdk wrapper layer
metadata:
  type: project
---

`libs/core/src/lib` is `@trinity/core`: Angular 20 (`providedIn: 'root'`) services wrapping matrix-js-sdk 41.x. Components must NEVER import matrix-js-sdk directly — they go through these services.

**Conventions observed:**
- Async APIs are exposed as COLD Observables, built with `defer(() => from(promise))` so work runs on subscribe. RxJS, not async/await, at the public surface.
- Read models are bridged to Angular signals (`signal()` + `.asReadonly()`); SDK events drive `refresh()` which re-`set()`s the signal with freshly-mapped view models.
- View models are plain interfaces (RoomSummary, MessageView, etc.) — no SDK types leak out.
- Listener handlers are stable arrow class fields so they can be `.off()`'d in teardown.
- `connect()` methods are idempotent via a `connected` boolean flag.

**Key services:** matrix-client.service (owns the single MatrixClient + lifecycle), auth.service (.well-known/login/logout), rooms.service (spaces/rooms/members read model), timeline.service (per-room timeline + send/edit/etc.), crypto.service (cross-signing/4S/backup bootstrap), secret-storage-key.service (in-memory 4S key holder).

**How to apply:** When reviewing core, check that new event listeners are removed in teardown/close, that signals are only written from refresh-style methods (not during computation), and that Observables are cold + complete. See [[feedback-core-recurring-issues]].
