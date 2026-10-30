import type { UnencryptedMark } from '@trinity/util/matrix';
import type { MessageShield } from './message-presentation';
import type { ShieldCode } from './timeline-engine';

const REASON_TEXT: Readonly<Record<ShieldCode['reason'], string>> = {
  'unverified-identity': 'Sent by a user you haven’t verified.',
  'unsigned-device': 'Sent from a device its owner hasn’t verified.',
  'unknown-device': 'Sent from an unknown or deleted device.',
  'authenticity-not-guaranteed':
    'The authenticity of this message can’t be guaranteed.',
  'verification-violation':
    'Sent by a user whose verified identity has changed.',
  'mismatched-sender':
    'The sender doesn’t match the device that encrypted this.',
  unknown: 'This message’s authenticity couldn’t be verified.',
};

/**
 * A shield says the message could not be *attributed*, never that anyone read it — so
 * these say what the doubt is and who can clear it, without implying interception.
 */
const EXPLANATION_TEXT: Readonly<Record<ShieldCode['reason'], string>> = {
  'unverified-identity':
    'Trinity can’t confirm it really came from them. Verify this person to be sure.',
  'unsigned-device':
    'Only its owner can confirm the device is theirs, by verifying it from another of their sessions.',
  'unknown-device':
    'There is no record of the device, so there is nothing to check the message against.',
  'authenticity-not-guaranteed':
    'The key that decrypted it didn’t come straight from the sender — a key backup, for example.',
  'verification-violation':
    'You verified this person before and their identity has changed since. Check with them another way, then verify them again or withdraw your verification from the room banner or their profile.',
  'mismatched-sender':
    'It claims to come from someone other than the account that set up its encryption, so don’t take the name on it at face value.',
  unknown: 'Trinity couldn’t work out which device sent it.',
};

const SHIELDS = new Map<string, MessageShield>();

/** One shared object per code, so a row can compare shields by identity. */
export function shieldText(code: ShieldCode): MessageShield {
  const key = `${code.colour}:${code.reason}`;
  let shield = SHIELDS.get(key);
  if (!shield) {
    shield = Object.freeze({
      level: code.colour,
      reason: REASON_TEXT[code.reason],
      explanation: EXPLANATION_TEXT[code.reason],
    });
    SHIELDS.set(key, shield);
  }
  return shield;
}

/** Shown on a message that was sent without end-to-end encryption into an encrypted room. */
export const UNENCRYPTED_SHIELD: MessageShield = Object.freeze({
  level: 'unencrypted',
  reason: 'Not encrypted',
  explanation: 'This message was sent without end-to-end encryption.',
});

/**
 * The quieter form of {@link UNENCRYPTED_SHIELD} for a message dated before the room
 * turned encryption on: it is just as unencrypted, but its date explains why.
 */
export const UNENCRYPTED_HISTORY_SHIELD: MessageShield = Object.freeze({
  level: 'unencrypted-history',
  reason: 'Not encrypted',
  explanation:
    'This message is dated before the room turned on end-to-end encryption.',
});

/** The shield for a not-encrypted mark; `null` when there is no mark. */
export function unencryptedShield(mark: UnencryptedMark): MessageShield;
export function unencryptedShield(
  mark: UnencryptedMark | null,
): MessageShield | null;
export function unencryptedShield(
  mark: UnencryptedMark | null,
): MessageShield | null {
  if (mark === null) return null;
  return mark === 'unencrypted-history'
    ? UNENCRYPTED_HISTORY_SHIELD
    : UNENCRYPTED_SHIELD;
}

/** Stable fingerprint of a shield for cache revs + change detection ('' = none). */
export function shieldKey(shield: MessageShield | null): string {
  return shield ? `${shield.level}:${shield.reason}` : '';
}
