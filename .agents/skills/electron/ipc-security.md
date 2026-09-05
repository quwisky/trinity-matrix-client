# Electron IPC and bridge safety

Treat every renderer request as untrusted. Trinity's bridge is deliberately
small and capability-negotiated; use the existing contract rather than adding a
generic channel or exposing an Electron object.

## Change a host operation

1. Start with the typed operation in
   [`@trinity/runtime/host`](../../../libs/runtime/host/src/lib/host-capability.models.ts)
   and the selected platform adapter. Decide whether the operation is supported,
   unavailable, or belongs to another capability.
2. Extend the versioned negotiation and public preload surface only when the
   operation has that ownership. The current bridge is
   [`preload.ts`](../../../electron/src/preload.ts); it exposes
   `trinityDesktop`, not raw `ipcRenderer` or Node APIs.
3. In main, accept only the current main-window `webContents` sender and validate
   every untrusted payload before native work. Mirror the existing
   [`host-capabilities.ts`](../../../electron/src/host-capabilities.ts),
   [`secure-store-ipc.ts`](../../../electron/src/secure-store-ipc.ts), and
   notification handlers rather than inventing a permissive validator.
4. Add focused proof for accepted input, malformed input, unavailable support,
   and a foreign sender. Keep protocol and bridge tests aligned.

The renderer's application origin is `trinity://app`; it is not `file://`.
`eu.qwky.trinity://` is only the operating-system deep-link callback. Preserve
that distinction in navigation, permission, and CORS work; see
[`scheme.ts`](../../../electron/src/scheme.ts),
[`window.ts`](../../../electron/src/window.ts), and
[`deep-link.ts`](../../../electron/src/deep-link.ts).

A capability that is not implemented remains unavailable. Do not use arbitrary
SQL, filesystem, shell, or opaque-object IPC to work around that result.
