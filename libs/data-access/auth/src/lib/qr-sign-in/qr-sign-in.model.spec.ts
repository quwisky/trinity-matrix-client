import { describe, expect, it } from 'vitest';
import { qrSignInFailureOf, type QrSignInFailure } from './qr-sign-in.model';

describe('qrSignInFailureOf', () => {
  it.each<[unknown, QrSignInFailure]>([
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
    [new TypeError('Failed to fetch'), 'network'],
    ['invalid_code', 'unknown'],
    ['device_not_found', 'unknown'],
    ['unexpected_message_received', 'unknown'],
    ['other_device_not_signed_in', 'unknown'],
    ['constructor', 'unknown'],
    ['toString', 'unknown'],
    [undefined, 'unknown'],
    [{}, 'unknown'],
  ])('maps %s to %s', (reason, expected) => {
    expect(qrSignInFailureOf(reason)).toBe(expected);
  });
});
