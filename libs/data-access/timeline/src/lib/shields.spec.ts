import { type MatrixEvent, type Room } from 'matrix-js-sdk';
import {
  EventShieldColour,
  EventShieldReason,
} from 'matrix-js-sdk/lib/crypto-api';
import { type MessageShield } from './message-presentation';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveShieldsInto,
  shieldExplanationText,
  shieldKey,
  shieldReasonText,
  shieldSubject,
  toShield,
  unencryptedShieldFor,
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

/** A message-or-state event as the unencrypted-shield lookup reads it. */
function sent(
  id: string,
  o: {
    encrypted?: boolean;
    status?: string | null;
    state?: boolean;
    redacted?: boolean;
    ts?: number;
    replacement?: MatrixEvent;
  } = {},
): MatrixEvent {
  return {
    getId: () => id,
    getTs: () => o.ts ?? 0,
    isState: () => o.state ?? false,
    isRedacted: () => o.redacted ?? false,
    isEncrypted: () => o.encrypted ?? false,
    replacingEvent: () => o.replacement ?? null,
    status: o.status ?? null,
  } as unknown as MatrixEvent;
}

/** The two looks of a "Not encrypted" mark; the wording is the same, the tone is not. */
const RED = {
  level: 'unencrypted',
  reason: 'Not encrypted',
  explanation: 'This message was sent without end-to-end encryption.',
};
const GREY = {
  level: 'unencrypted-history',
  reason: 'Not encrypted',
  explanation:
    'This message is dated before the room turned on end-to-end encryption.',
};

/**
 * A room as the lookup reads it: `encryptedAt` is the `origin_server_ts` of its current
 * `m.room.encryption` state event, or null for a room with no such event.
 */
function roomEncryptedAt(encryptedAt: number | null): Room {
  return {
    getLiveTimeline: () => ({
      getState: () => ({
        getStateEvents: (type: string, key: string) =>
          type === 'm.room.encryption' && key === '' && encryptedAt !== null
            ? { getTs: () => encryptedAt }
            : null,
      }),
    }),
  } as unknown as Room;
}

describe('unencryptedShieldFor', () => {
  const at = (encryptedAt: number | null, roomEncrypted = true) =>
    unencryptedShieldFor(roomEncryptedAt(encryptedAt), roomEncrypted);

  it('marks a message dated at or after the encryption event in the red tone', () => {
    const lookup = at(1_000);

    expect(lookup(sent('$later', { ts: 2_000 }))).toEqual(RED);
    expect(lookup(sent('$same', { ts: 1_000 }))).toEqual(RED);
  });

  it('marks a message dated before the encryption event in the quieter grey tone', () => {
    expect(at(1_000)(sent('$older', { ts: 999 }))).toEqual(GREY);
  });

  it('keeps a message with a zero or missing date in the red tone', () => {
    const lookup = at(1_000);

    expect(lookup(sent('$zero', { ts: 0 }))).toEqual(RED);
    expect(
      lookup({
        ...sent('$missing'),
        getTs: () => undefined,
      } as unknown as MatrixEvent),
    ).toEqual(RED);
  });

  it('marks every message in the red tone when the room has no encryption state event', () => {
    // Only the crypto store says the room is encrypted, so there is no date to compare to.
    const lookup = at(null);

    expect(lookup(sent('$old', { ts: 1 }))).toEqual(RED);
    expect(lookup(sent('$new', { ts: 9_999_999 }))).toEqual(RED);
  });

  // Dating a message earlier only changes how it looks; it is never a reason to leave
  // a plaintext message unmarked.
  it('never leaves a plaintext message unmarked on its date alone', () => {
    const lookup = at(1_000);

    for (const ts of [0, 1, 999, 1_000, 1_001, Number.MAX_SAFE_INTEGER]) {
      expect(lookup(sent(`$${ts}`, { ts }))).not.toBeNull();
    }
  });

  it('leaves an encrypted message unmarked, whatever its decryption outcome or date', () => {
    expect(
      at(1_000)(sent('$sealed', { encrypted: true, ts: 2_000 })),
    ).toBeNull();
    expect(
      at(1_000)(sent('$old-sealed', { encrypted: true, ts: 1 })),
    ).toBeNull();
  });

  it('marks nothing in a room that is not encrypted', () => {
    expect(at(1_000, false)(sent('$plain', { ts: 2_000 }))).toBeNull();
  });

  it.each(['sending', 'encrypting', 'queued', 'not_sent', 'sent'])(
    'skips a local echo that is still %s',
    (status) => {
      expect(at(1_000)(sent('$echo', { status, ts: 2_000 }))).toBeNull();
    },
  );

  it('skips state events and redacted messages', () => {
    const lookup = at(1_000);

    expect(lookup(sent('$topic', { state: true, ts: 2_000 }))).toBeNull();
    expect(lookup(sent('$gone', { redacted: true, ts: 2_000 }))).toBeNull();
  });

  // The text a row shows comes from its latest edit, and the SDK applies an edit without
  // checking that it was encrypted, so the edit, and its date, are what get judged.
  describe('for an edited message', () => {
    it('marks an encrypted message whose later plaintext edit is dated after encryption in red', () => {
      const original = sent('$orig', {
        encrypted: true,
        ts: 500,
        replacement: sent('$edit', { ts: 2_000 }),
      });

      expect(at(1_000)(original)).toEqual(RED);
    });

    it('judges the date of the edit, not of the message it replaces', () => {
      const lookup = at(1_000);
      const oldEdit = sent('$orig', {
        ts: 2_000,
        replacement: sent('$edit', { ts: 500 }),
      });

      expect(lookup(oldEdit)).toEqual(GREY);
    });

    it('leaves an encrypted message with an encrypted edit unmarked', () => {
      const original = sent('$orig', {
        encrypted: true,
        replacement: sent('$edit', { encrypted: true, ts: 2_000 }),
      });

      expect(at(1_000)(original)).toBeNull();
    });

    it('does not mark a message while its own edit is still being sent', () => {
      const original = sent('$orig', {
        encrypted: true,
        replacement: sent('$edit', { status: 'sending', ts: 2_000 }),
      });

      expect(at(1_000)(original)).toBeNull();
    });

    it('does not mark a redacted message that still has an edit', () => {
      const original = sent('$orig', {
        redacted: true,
        replacement: sent('$edit', { ts: 2_000 }),
      });

      expect(at(1_000)(original)).toBeNull();
    });
  });
});

describe('shieldSubject', () => {
  it('is the latest edit when there is one, and the event itself otherwise', () => {
    const edit = sent('$edit');
    const edited = sent('$orig', { replacement: edit });
    const plain = sent('$plain');

    expect(shieldSubject(edited)).toBe(edit);
    expect(shieldSubject(plain)).toBe(plain);
  });
});
