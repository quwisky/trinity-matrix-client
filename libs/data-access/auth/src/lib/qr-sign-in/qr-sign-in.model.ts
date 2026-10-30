// Keep this file free of imports: the browser journeys import it for the failure copy.
export type QrSignInFailure =
  | 'expired'
  | 'declined'
  | 'unsupported'
  | 'insecure'
  | 'already-signed-in'
  | 'other-server'
  | 'network'
  | 'unknown';

/** The plain sentence each failure shows, unless the device on screen words it its own way. */
export const QR_SIGN_IN_FAILURE_MESSAGES: Readonly<
  Record<QrSignInFailure, string>
> = {
  expired: 'The code expired.',
  declined: 'Sign-in was cancelled on the other device.',
  insecure:
    "The connection between the devices wasn't secure, so nothing was shared.",
  unsupported: "Your server doesn't support QR sign-in.",
  'already-signed-in': 'That device is already signed in.',
  'other-server':
    "That account is on a different server from the one you chose, so Trinity signed it out again. Sign in through that account's server.",
  network: 'Lost connection. Check your network and try again.',
  unknown: 'Something went wrong. Try again or sign in another way.',
};

export type NewDeviceState =
  | { kind: 'creating' }
  | { kind: 'showing-code'; qr: Uint8Array; expiresAt: number }
  | { kind: 'enter-check-code' }
  | { kind: 'waiting-for-approval'; userCode: string }
  | { kind: 'signing-in' }
  | { kind: 'done' }
  | { kind: 'failed'; reason: QrSignInFailure };

export type ExistingDeviceState =
  | { kind: 'connecting' }
  | { kind: 'not-sign-in-code' }
  | { kind: 'confirm-check-code'; code: string }
  // No user code: the existing device only receives the verification URI.
  | { kind: 'approve-in-browser'; verificationUri: string }
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

/** The provider will not let a newly registered client use the device grant. */
export class DeviceGrantRejectedError extends Error {
  constructor() {
    super('The provider refuses the device grant for this client.');
  }
}

/** The account the other device signed in is not on the server this device signs in to. */
export class OtherServerError extends Error {
  constructor() {
    super('The account is on a different server.');
  }
}

/** The QR sign-in returned an account this device already stores; it stays as it was. */
export class QrAccountAlreadyStoredError extends Error {
  constructor() {
    super('This device is already signed in to that account.');
  }
}

export function qrSignInFailureOf(reason: unknown): QrSignInFailure {
  if (reason instanceof TypeError) return 'network';
  if (reason instanceof DeviceGrantRejectedError) return 'unsupported';
  if (reason instanceof QrAccountAlreadyStoredError) return 'already-signed-in';
  if (reason instanceof OtherServerError) return 'other-server';
  return (
    (typeof reason === 'string' && FAILURE_BY_REASON.get(reason)) || 'unknown'
  );
}
