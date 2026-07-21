import { type MatrixEvent } from 'matrix-js-sdk';
import {
  EventShieldColour,
  EventShieldReason,
} from 'matrix-js-sdk/lib/crypto-api';
import { type MessageShield } from '@trinity/util-matrix';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveShieldsInto,
  shieldExplanationText,
  shieldKey,
  shieldReasonText,
  toShield,
} from './shields';

/** An encrypted event; only getId/isDecryptionFailure are read by the resolver. */
function event(id: string, decryptionFailure = false): MatrixEvent {
  return {
    getId: () => id,
    isDecryptionFailure: () => decryptionFailure,
  } as unknown as MatrixEvent;
}

const NOT_STALE = { force: false, isStale: () => false };

/** A shield literal; `explanation` rides along with `reason` from the same code. */
function shield(level: 'grey' | 'red', reason: string): MessageShield {
  return { level, reason, explanation: 'because' };
}

describe('shieldKey', () => {
  it('fingerprints a shield and distinguishes none from any', () => {
    expect(shieldKey(null)).toBe('');
    expect(shieldKey(shield('red', 'why'))).toBe('red:why');
    // Level and reason both participate, so a change in either re-projects.
    expect(shieldKey(shield('grey', 'why'))).not.toBe(
      shieldKey(shield('red', 'why')),
    );
  });
});

/**
 * Reason codes that deliberately have no wording of their own, by numeric value so this
 * file needn't name a deprecated constant:
 *   0 UNKNOWN               — is the fallback, by definition
 *   5 MISMATCHED_SENDER_KEY — deprecated; unused since matrix-sdk-crypto landed in v37
 *   6 SENT_IN_CLEAR         — deprecated; per the SDK, "has never been used"
 */
const FALLBACK_REASONS = new Set<number>([0, 5, 6]);

/** Every reason the SDK still emits, read off the enum so an SDK upgrade that adds one
 *  fails the coverage test below instead of silently landing on the generic wording. */
const LIVE_REASONS = Object.values(EventShieldReason).filter(
  (value): value is EventShieldReason =>
    typeof value === 'number' && !FALLBACK_REASONS.has(value),
);

describe('shield wording', () => {
  // The icon and its one-line reason say something is off; the explanation says what it
  // means. Both need to be specific for every reason — including the null/unknown case,
  // which is what the fail-closed path renders.
  const ALL: (EventShieldReason | null)[] = [...LIVE_REASONS, null];

  it('covers every reason the SDK still emits', () => {
    // Guards an SDK upgrade: a new reason code lands on the generic fallback until
    // someone writes copy for it, and this is what says so.
    expect(LIVE_REASONS).toHaveLength(6);

    for (const reason of LIVE_REASONS) {
      expect(shieldReasonText(reason)).not.toBe(shieldReasonText(null));
      expect(shieldExplanationText(reason)).not.toBe(
        shieldExplanationText(null),
      );
    }
  });

  it('explains every reason distinctly', () => {
    const texts = ALL.map((reason) => shieldExplanationText(reason));

    for (const text of texts) {
      expect(text.length).toBeGreaterThan(20);
    }
    expect(new Set(texts).size).toBe(ALL.length);
    expect(new Set(ALL.map((r) => shieldReasonText(r))).size).toBe(ALL.length);
  });

  // A shield means "we could not confirm who sent this", never "someone else read it" —
  // overstating that would frighten users away from a room that is working correctly.
  it('never claims the message was intercepted or exposed', () => {
    for (const reason of ALL) {
      expect(shieldExplanationText(reason)).not.toMatch(
        /intercept|read by|eavesdrop|compromised|leaked/i,
      );
    }
  });

  // The two most serious codes accuse someone of something, so they must say what to do
  // rather than leave the reader with a bare warning.
  it('tells the reader what to do about an identity change', () => {
    expect(
      shieldExplanationText(EventShieldReason.VERIFICATION_VIOLATION),
    ).toMatch(/verify them again/i);
    expect(shieldExplanationText(EventShieldReason.MISMATCHED_SENDER)).toMatch(
      /face value|don’t trust|treat/i,
    );
  });
});

describe('toShield', () => {
  it('maps NONE and missing info to no shield', () => {
    expect(toShield(null)).toBeNull();
    expect(
      toShield({
        shieldColour: EventShieldColour.NONE,
        shieldReason: null,
      } as never),
    ).toBeNull();
  });

  it('carries the matching explanation alongside the reason', () => {
    const mapped = toShield({
      shieldColour: EventShieldColour.GREY,
      shieldReason: EventShieldReason.UNSIGNED_DEVICE,
    } as never);

    expect(mapped?.explanation).toBe(
      shieldExplanationText(EventShieldReason.UNSIGNED_DEVICE),
    );
    expect(mapped?.explanation).not.toBe(mapped?.reason);
  });

  it('maps RED to red and anything else to grey', () => {
    expect(
      toShield({
        shieldColour: EventShieldColour.RED,
        shieldReason: EventShieldReason.UNKNOWN_DEVICE,
      } as never),
    ).toMatchObject({ level: 'red' });
    expect(
      toShield({
        shieldColour: EventShieldColour.GREY,
        shieldReason: EventShieldReason.UNVERIFIED_IDENTITY,
      } as never),
    ).toMatchObject({ level: 'grey' });
  });
});

describe('resolveShieldsInto', () => {
  it('stores the resolved shield and reports a change', async () => {
    const shields = new Map<string, MessageShield | null>();
    const crypto = {
      getEncryptionInfoForEvent: vi.fn().mockResolvedValue({
        shieldColour: EventShieldColour.RED,
        shieldReason: EventShieldReason.UNKNOWN_DEVICE,
      }),
    };

    const changed = await resolveShieldsInto(
      crypto as never,
      [event('$a')],
      shields,
      NOT_STALE,
    );

    expect(changed).toBe(true);
    expect(shields.get('$a')).toMatchObject({ level: 'red' });
  });

  // The one that matters: `events` is already filtered to ENCRYPTED events, and a null
  // shield renders as no decoration at all — identical to a fully authenticated message.
  // A transient crypto/store error must not silently make an unverified message look
  // trustworthy.
  it('fails closed when the crypto probe throws, rather than showing no shield', async () => {
    const shields = new Map<string, MessageShield | null>();
    const crypto = {
      getEncryptionInfoForEvent: vi
        .fn()
        .mockRejectedValue(new Error('store unavailable')),
    };

    const changed = await resolveShieldsInto(
      crypto as never,
      [event('$a')],
      shields,
      NOT_STALE,
    );

    expect(changed).toBe(true);
    expect(shields.get('$a')).not.toBeNull(); // NOT "looks authenticated"
    expect(shields.get('$a')).toMatchObject({ level: 'grey' });
  });

  it('does not let a probe failure break the rest of the batch', async () => {
    const shields = new Map<string, MessageShield | null>();
    const crypto = {
      getEncryptionInfoForEvent: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({
          shieldColour: EventShieldColour.NONE,
          shieldReason: null,
        }),
    };

    await resolveShieldsInto(
      crypto as never,
      [event('$bad'), event('$good')],
      shields,
      NOT_STALE,
    );

    expect(shields.get('$bad')).toMatchObject({ level: 'grey' });
    // A genuine "no shield" is never stored: the resolver only writes when the key
    // CHANGES, and absent already fingerprints as none. Absence is the encoding.
    expect(shields.has('$good')).toBe(false);
  });

  it('bails without touching state when the caller navigated away mid-resolve', async () => {
    const shields = new Map<string, MessageShield | null>();
    const crypto = {
      getEncryptionInfoForEvent: vi.fn().mockResolvedValue({
        shieldColour: EventShieldColour.RED,
        shieldReason: null,
      }),
    };

    const changed = await resolveShieldsInto(
      crypto as never,
      [event('$a')],
      shields,
      {
        force: false,
        isStale: () => true,
      },
    );

    expect(changed).toBe(false);
    expect(shields.size).toBe(0);
  });
});
