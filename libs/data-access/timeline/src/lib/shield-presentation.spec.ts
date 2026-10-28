import { describe, expect, it } from 'vitest';
import {
  shieldText,
  UNENCRYPTED_HISTORY_SHIELD,
  UNENCRYPTED_SHIELD,
  unencryptedShield,
} from './shield-presentation';
import type { ShieldCode } from './timeline-engine';

describe('shieldText', () => {
  it.each<[ShieldCode['reason'], string, string]>([
    [
      'unverified-identity',
      'Sent by a user you haven’t verified.',
      'Trinity can’t confirm it really came from them. Verify this person to be sure.',
    ],
    [
      'unsigned-device',
      'Sent from a device its owner hasn’t verified.',
      'Only its owner can confirm the device is theirs, by verifying it from another of their sessions.',
    ],
    [
      'unknown-device',
      'Sent from an unknown or deleted device.',
      'There is no record of the device, so there is nothing to check the message against.',
    ],
    [
      'authenticity-not-guaranteed',
      'The authenticity of this message can’t be guaranteed.',
      'The key that decrypted it didn’t come straight from the sender — a key backup, for example.',
    ],
    [
      'verification-violation',
      'Sent by a user whose verified identity has changed.',
      'You verified this person before and their identity has changed since. Check with them another way, then verify them again or withdraw your verification from the room banner or their profile.',
    ],
    [
      'mismatched-sender',
      'The sender doesn’t match the device that encrypted this.',
      'It claims to come from someone other than the account that set up its encryption, so don’t take the name on it at face value.',
    ],
    [
      'unknown',
      'This message’s authenticity couldn’t be verified.',
      'Trinity couldn’t work out which device sent it.',
    ],
  ])(
    'every ShieldCode reason maps to today’s reason and explanation text: %s',
    (reason, text, explanation) => {
      expect(shieldText({ colour: 'red', reason })).toEqual({
        level: 'red',
        reason: text,
        explanation,
      });
      expect(shieldText({ colour: 'grey', reason }).level).toBe('grey');
    },
  );
});

describe('unencryptedShield', () => {
  it('matches UNENCRYPTED_SHIELD and UNENCRYPTED_HISTORY_SHIELD', () => {
    expect(unencryptedShield('unencrypted')).toBe(UNENCRYPTED_SHIELD);
    expect(unencryptedShield('unencrypted-history')).toBe(
      UNENCRYPTED_HISTORY_SHIELD,
    );
    expect(UNENCRYPTED_SHIELD).toEqual({
      level: 'unencrypted',
      reason: 'Not encrypted',
      explanation: 'This message was sent without end-to-end encryption.',
    });
    expect(UNENCRYPTED_HISTORY_SHIELD).toEqual({
      level: 'unencrypted-history',
      reason: 'Not encrypted',
      explanation:
        'This message is dated before the room turned on end-to-end encryption.',
    });
  });
});
