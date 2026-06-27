---
name: feedback-core-recurring-issues
description: Recurring defect patterns worth checking first when reviewing libs/core
metadata:
  type: project
---

Patterns flagged during the full libs/core review (2026-06-27). Check these first on future core reviews.

1. **`connect()` flags never reset on teardown.** RoomsService/CryptoService set `connected = true` but the flag is on the service (root singleton) while listeners are on the MatrixClient (recreated each login). After logout→login the new client never gets listeners re-attached, but the service still thinks it's connected → stale UI. Listeners are also leaked (added in connect, never removed in any teardown path).
2. **timeline `refresh()` re-maps the whole timeline on every single timeline event** (ignores the `removed`/`toStartOfTimeline` args) — O(n) per event, fine for small rooms, a perf smell for large ones.
3. **`sendReadReceipt(last)` in timeline.open** can throw on a pending local-echo event (SDK throws for pending events) — and the result promise is fire-and-forget (`void`), so a rejection is an unhandled rejection.
4. **Recovery key Uint8Array zeroing is inconsistent**: secret-storage-key.service zeroes on clear, and recover() zeroes on a failed checkKey, but the successful path hands the key to `set()` and it lives until logout (acceptable, documented). setUp()'s privateKey from createRecoveryKeyFromPassphrase is never zeroed.
5. **auth.service.logout** clears storage even if `matrix.stop()` is fine, but if the server logout + stop happen, the crypto IndexedDB store is NOT cleared (stopClient is sync and doesn't wipe crypto store) — next login for a different user reuses... actually new client w/ new deviceId. Verify crypto store cleanup expectations.

**Why:** these are the real-world-impact items (stale state after re-login, unhandled rejections) vs. style. **How to apply:** lead the review with the connect()/teardown lifecycle gap — it's the highest-impact recurring bug class here.
