import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api';
import type { UndecryptableReason } from '../message-presentation';

/**
 * The SDK's decryption failure code as a reason a person can act on. Codes that may still
 * resolve on their own (a key arriving late, a backup that is working) and codes Trinity
 * cannot explain better stay "missing key", which keeps the generic text.
 */
export function undecryptableReasonOf(
  code: DecryptionFailureCode | null,
): UndecryptableReason {
  switch (code) {
    case DecryptionFailureCode.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE:
      return 'device-unverified';
    case DecryptionFailureCode.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED:
      return 'history-locked';
    case DecryptionFailureCode.MEGOLM_KEY_WITHHELD:
      return 'withheld';
    case DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP:
      return 'sent-before-sign-in';
    case DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED:
      return 'sent-before-joining';
    case DecryptionFailureCode.UNSIGNED_SENDER_DEVICE:
    case DecryptionFailureCode.UNKNOWN_SENDER_DEVICE:
      return 'unverified-sender-device';
    case DecryptionFailureCode.SENDER_IDENTITY_PREVIOUSLY_VERIFIED:
      return 'sender-identity-changed';
    default:
      return 'missing-key';
  }
}
