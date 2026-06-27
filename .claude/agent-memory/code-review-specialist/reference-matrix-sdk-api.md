---
name: reference-matrix-sdk-api
description: Verified matrix-js-sdk v41.8.0 API signatures relevant to libs/core review
metadata:
  type: reference
---

Verified against node_modules/matrix-js-sdk v41.8.0 (.d.ts files). Re-verify if the SDK is bumped.

- `startClient(opts?)`: `Promise<void>` (client.d.ts:954) — async.
- `stopClient()`: `void` (client.d.ts:963) — SYNCHRONOUS, does not await crypto/store flush.
- `scrollback(room, limit?)`: `Promise<Room>` (client.d.ts:1908). Concurrent calls return the same promise. At timeline start, `room.oldState.paginationToken` becomes null.
- `EventTimeline.getPaginationToken(Direction.Backward)`: `string | null` (event-timeline.d.ts:158). null = no more in THIS timeline.
- `sendReadReceipt(event, ...)`: `Promise<EmptyObject | undefined>` (client.d.ts:1662). Resolves undefined if event is null; THROWS "Cannot set read receipt to a pending event" if event is a pending local echo (client.js ~2685).
- `sendTextMessage/sendMessage`: `Promise<ISendEventResponse>`, auto txnId + local echo. `sendHtmlMessage(roomId, body, htmlBody)` has NO txnId param (client.d.ts:1529).
- `RoomEvent.Timeline` listener: `(event, room, toStartOfTimeline: boolean|undefined, removed: boolean, data) => void` (event-timeline-set.d.ts:58). toStartOfTimeline true = backfill/scrollback insert.
- `resendEvent(event, room)`: `Promise<ISendEventResponse>` (client.d.ts:1333), room required, may throw MatrixSafetyError.
- `createClient({baseUrl})` with no store: allocates a fresh MemoryStore + MatrixScheduler + cryptoStore on EACH call (matrix.js amendClientOpts ~103). No caching.
- `CryptoApi.createRecoveryKeyFromPassphrase(password?)`: `Promise<GeneratedSecretStorageKey>` (crypto-api/index.d.ts:370). Omit password = random key. Returns {privateKey: Uint8Array, encodedPrivateKey?: string, keyInfo?}.
