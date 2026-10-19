export type QrSignInFailure =
  | 'expired'
  | 'declined'
  | 'unsupported'
  | 'insecure'
  | 'already-signed-in'
  | 'network'
  | 'unknown';

export type NewDeviceState =
  | { kind: 'creating' }
  | { kind: 'showing-code'; qr: Uint8Array; expiresAt: number }
  | { kind: 'confirm-check-code'; code: string }
  | { kind: 'waiting-for-approval'; userCode: string }
  | { kind: 'signing-in' }
  | { kind: 'done'; verified: boolean }
  | { kind: 'failed'; reason: QrSignInFailure };

export type ExistingDeviceState =
  | { kind: 'connecting' }
  | { kind: 'not-sign-in-code' }
  | { kind: 'confirm-check-code'; code: string }
  | { kind: 'approve-in-browser'; verificationUri: string; userCode: string }
  | { kind: 'sharing-secrets' }
  | { kind: 'done' }
  | { kind: 'failed'; reason: QrSignInFailure };

// Keyed by the string values of the SDK's MSC4108FailureReason and
// ClientRendezvousFailureReason enums, so this model needs no SDK import.
const FAILURE_BY_REASON: ReadonlyMap<string, QrSignInFailure> = new Map([
  ['authorization_expired', 'expired'],
  ['expired', 'expired'],
  ['user_cancelled', 'declined'],
  ['user_declined', 'declined'],
  ['unsupported_protocol', 'unsupported'],
  ['homeserver_lacks_support', 'unsupported'],
  ['etag_missing', 'unsupported'],
  ['insecure_channel_detected', 'insecure'],
  ['device_already_exists', 'already-signed-in'],
  ['other_device_already_signed_in', 'already-signed-in'],
]);

export function qrSignInFailureOf(reason: unknown): QrSignInFailure {
  if (reason instanceof TypeError) return 'network';
  return (
    (typeof reason === 'string' && FAILURE_BY_REASON.get(reason)) || 'unknown'
  );
}
