# Secure storage and desktop host ownership

Trinity has no generic Electron backend. Do not add an Express service, SQLite
store, custom sync layer, or arbitrary file/database IPC for a feature. Start
with the host capability and the domain service that owns the requested
behavior.

## Work on secure storage

The desktop secure store is a narrow main-process service:

- [`secure-store.ts`](../../../electron/src/secure-store.ts) encrypts values
  through Electron `safeStorage` and persists its ciphertext map under
  `userData` with owner-only file permissions.
- On Linux it rejects `basic_text` and `unknown` backends even when Electron
  reports encryption available. Treat that as unavailable secure storage, not
  successful encryption.
- [`secure-store-ipc.ts`](../../../electron/src/secure-store-ipc.ts) accepts
  only the main window sender and string keys/values. Invalid sender/input is
  rejected with false/null/no-op results; unavailable secure storage makes `get`
  return null and `set` return false without writing. Decryption errors are caught
  and return null. Encryption or persistence errors from `set`, and persistence
  errors from `delete`, reject their IPC promises; preserve that distinction
  instead of treating an operation failure as unavailable support.
- [`preload.ts`](../../../electron/src/preload.ts) exposes only the negotiated
  `secureStore` operations; it does not expose the keyring, ciphertext file, or
  `ipcRenderer`.

The platform adapter chooses the secure-store capability and reports support to
application code. Follow
[`host-capability.adapters.ts`](../../../libs/platform-native/src/lib/host-capabilities/host-capability.adapters.ts)
and the [Matrix persistence contract](../../../docs/architecture/matrix-and-encryption.md#secure-storage-backend-selection)
before changing a fallback or error path.

## Finish safely

Keep secret values out of diagnostics and logs. Preserve the capability's
unavailable result so the existing storage selection policy can handle it. Add
or update focused source and behavior tests for a new branch; do not claim that
an Electron or OS keychain check ran unless it did.
