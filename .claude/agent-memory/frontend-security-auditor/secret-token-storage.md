---
name: secret-token-storage
description: Where the Matrix session token and the 4S recovery/secret-storage key live, and the in-memory zeroing convention
metadata:
  type: project
---

Token and secret storage model for trinity-matrix-client.

**Session token (access token):** persisted via `@capacitor/preferences`
(`SessionStorageService`, key `matrix.session`) — native secure-ish storage on
device, **localStorage on web**. So on web the Matrix access token is
XSS-exfiltratable. This is a pre-existing platform tradeoff (Capacitor),
not introduced by the crypto UI.

**4S secret-storage private key (≈ the account recovery key):** held
in-memory only by `SecretStorageKeyService` (libs/core), handed to the SDK via
the `getSecretStorageKey` crypto callback. Never written to disk. `clear()`
zeroes the bytes (`.fill(0)`) on logout/teardown as best-effort defense.

**Recovery key (encoded string shown to the user):** emitted ONCE by
`CryptoService.setUp()`, never persisted by the service.

**Why:** E2EE secrets must not touch disk; the recovery key is the root of the
account's encryption recovery.

**How to apply:** When auditing crypto/auth diffs, check that the recovery key
and decoded private keys stay transient (no localStorage/sessionStorage, no
logs, no URLs/router state) and that Uint8Array private keys get `.fill(0)`
when discarded. See [[crypto-bootstrap-ui]].
