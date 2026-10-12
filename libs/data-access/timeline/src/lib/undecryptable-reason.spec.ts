import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api';
import { describe, expect, it } from 'vitest';
import { undecryptableReasonOf } from './undecryptable-reason';

describe('undecryptableReasonOf', () => {
  it.each([
    [
      DecryptionFailureCode.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE,
      'device-unverified',
    ],
    [
      DecryptionFailureCode.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED,
      'history-locked',
    ],
    [DecryptionFailureCode.MEGOLM_KEY_WITHHELD, 'withheld'],
    [
      DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP,
      'sent-before-sign-in',
    ],
    [
      DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED,
      'sent-before-joining',
    ],
    [DecryptionFailureCode.UNSIGNED_SENDER_DEVICE, 'unverified-sender-device'],
    [DecryptionFailureCode.UNKNOWN_SENDER_DEVICE, 'unverified-sender-device'],
    [
      DecryptionFailureCode.SENDER_IDENTITY_PREVIOUSLY_VERIFIED,
      'sender-identity-changed',
    ],
    [DecryptionFailureCode.HISTORICAL_MESSAGE_WORKING_BACKUP, 'missing-key'],
    [DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID, 'missing-key'],
    [DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX, 'missing-key'],
    [DecryptionFailureCode.UNKNOWN_ERROR, 'missing-key'],
    [null, 'missing-key'],
  ] as const)('maps %s to %s', (code, reason) => {
    expect(undecryptableReasonOf(code)).toBe(reason);
  });
});
