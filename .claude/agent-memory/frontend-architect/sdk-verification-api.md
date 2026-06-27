---
name: sdk-verification-api
description: matrix-js-sdk 41.x device-verification (SAS/QR) API surface — verified symbol names for M7 VerificationService
metadata:
  type: project
---

Verified against `node_modules/matrix-js-sdk/lib/crypto-api/` (v41.8.0) for Milestone 7 (device verification). See [[architecture-overview]] for the CryptoService pattern this mirrors.

**Why:** M7 adds a `@trinity/core` VerificationService wrapping the SDK verification API; these exact symbol names were non-obvious and worth not re-deriving.
**How to apply:** Use when building/extending verification. Re-verify versions if matrix-js-sdk bumps.

Incoming requests: `CryptoEvent.VerificationRequestReceived` (`"crypto.verificationRequestReceived"`), payload `(request: VerificationRequest) => void`. Listen on the client (same `client.on/off` channel CryptoService already uses).

`CryptoApi` (from `client.getCrypto()`): `requestOwnUserVerification(): Promise<VerificationRequest>` (the MVP self-verify case), `requestDeviceVerification(userId, deviceId)`, `requestVerificationDM(userId, roomId)` (cross-user), `getVerificationRequestsToDeviceInProgress(userId): VerificationRequest[]`, `findVerificationRequestDMInProgress(roomId, userId?)`, `getDeviceVerificationStatus(userId, deviceId)`, `userHasCrossSigningKeys(userId?, downloadUncached?)`.

`VerificationRequest` (TypedEventEmitter, single event `VerificationRequestEvent.Change = "change"`, no payload): getters `phase` (`VerificationPhase` enum, NUMERIC: Unsent=1, Requested=2, Ready=3, Started=4, Cancelled=5, Done=6), `otherUserId`, `otherDeviceId`, `isSelfVerification`, `pending`, `accepting`, `declining`, `initiatedByMe`, `verifier?` (only defined when phase Started), `cancellationCode`, `cancellingUserId`, `otherDeviceId`. Methods: `accept()`, `cancel(params?)`, `startVerification(method): Promise<Verifier>`, `scanQRCode(Uint8ClampedArray): Promise<Verifier>`, `generateQRCode(): Promise<Uint8ClampedArray|undefined>` (only returns data when phase Ready AND other party can scan), `otherPartySupportsMethod(method)`. Free fn `canAcceptVerificationRequest(req): boolean`.

`Verifier` (TypedEventEmitter): events `VerifierEvent.ShowSas = "show_sas"` (payload `ShowSasCallbacks`), `VerifierEvent.ShowReciprocateQr = "show_reciprocate_qr"` (payload `ShowQrCodeCallbacks`), `VerifierEvent.Cancel = "cancel"` (payload `Error | MatrixEvent`). Methods: `verify(): Promise<void>`, `cancel(e: Error)` — NOTE cancel REQUIRES an Error arg, `getShowSasCallbacks(): ShowSasCallbacks | null`, `getReciprocateQrCodeCallbacks(): ShowQrCodeCallbacks | null`. Getters `hasBeenCancelled`, `userId`.

`ShowSasCallbacks`: `{ sas: GeneratedSas; confirm(): Promise<void>; mismatch(): void; cancel(): void }`. `GeneratedSas`: `{ emoji?: EmojiMapping[]; decimal?: [number,number,number] }` where `EmojiMapping = [emoji: string, name: string]` (7 emojis). SAS method string = `"m.sas.v1"`. QR reciprocate method = `"m.reciprocate.v1"`.

No QR/camera deps installed (no `qrcode`/`jsqr`/`@capacitor/camera`/barcode-scanner in package.json) — QR *display* needs a render lib, QR *scan* needs camera+decode. Recommended MVP: SAS-only, defer QR.
