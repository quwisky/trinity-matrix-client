import { type MatrixEvent, type Room } from 'matrix-js-sdk';
import {
  EventShieldColour,
  EventShieldReason,
} from 'matrix-js-sdk/lib/crypto-api';
import { type MessageShield } from '../message-presentation';
import { describe, expect, it, vi } from 'vitest';
import { shieldKey } from '../shield-presentation';
import {
  resolveShieldsInto,
  shieldSubject,
  toShield,
  unencryptedShieldFor,
} from './shields';

/** An encrypted event; only getId/isDecryptionFailure are read by the resolver. */
function event(
  id: string,
  decryptionFailure = false,
  decrypted = false,
): MatrixEvent {
  return {
    getId: () => id,
    isDecryptionFailure: () => decryptionFailure,
    getClearContent: () => (decrypted ? {} : null),
  } as unknown as MatrixEvent;
}

/** The wording a reason maps to, read through the SDK-to-code mapping. */
function shieldReasonText(reason: EventShieldReason | null): string {
  return toShield({
    shieldColour: EventShieldColour.GREY,
    shieldReason: reason,
  } as never)!.reason;
}

function shieldExplanationText(reason: EventShieldReason | null): string {
  return toShield({
    shieldColour: EventShieldColour.GREY,
    shieldReason: reason,
  } as never)!.explanation;
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
    const shields = new Map<MatrixEvent, MessageShield | null>();
    const crypto = {
      getEncryptionInfoForEvent: vi.fn().mockResolvedValue({
        shieldColour: EventShieldColour.RED,
        shieldReason: EventShieldReason.UNKNOWN_DEVICE,
      }),
    };

    const a = event('$a');
    const changed = await resolveShieldsInto(
      crypto as never,
      [a],
      shields,
      NOT_STALE,
    );

    expect(changed).toBe(true);
    expect(shields.get(a)).toMatchObject({ level: 'red' });
  });

  // The one that matters: `events` is already filtered to ENCRYPTED events, and a null
  // shield renders as no decoration at all — identical to a fully authenticated message.
  // A transient crypto/store error must not silently make an unverified message look
  // trustworthy.
  it('fails closed when the crypto probe throws, rather than showing no shield', async () => {
    const shields = new Map<MatrixEvent, MessageShield | null>();
    const crypto = {
      getEncryptionInfoForEvent: vi
        .fn()
        .mockRejectedValue(new Error('store unavailable')),
    };

    const a = event('$a');
    const changed = await resolveShieldsInto(
      crypto as never,
      [a],
      shields,
      NOT_STALE,
    );

    expect(changed).toBe(true);
    expect(shields.get(a)).not.toBeNull(); // NOT "looks authenticated"
    expect(shields.get(a)).toMatchObject({ level: 'grey' });
  });

  it('does not let a probe failure break the rest of the batch', async () => {
    const shields = new Map<MatrixEvent, MessageShield | null>();
    const crypto = {
      getEncryptionInfoForEvent: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({
          shieldColour: EventShieldColour.NONE,
          shieldReason: null,
        }),
    };

    const bad = event('$bad');
    const good = event('$good');
    await resolveShieldsInto(crypto as never, [bad, good], shields, NOT_STALE);

    expect(shields.get(bad)).toMatchObject({ level: 'grey' });
    // Not decrypted yet: a "no shield" answer is not kept, so it is asked again.
    expect(shields.has(good)).toBe(false);
  });

  it('keeps a "no shield" answer for a decrypted event, and reports it once', async () => {
    const shields = new Map<MatrixEvent, MessageShield | null>();
    const crypto = {
      getEncryptionInfoForEvent: vi.fn().mockResolvedValue({
        shieldColour: EventShieldColour.NONE,
        shieldReason: null,
      }),
    };
    const a = event('$a', false, true);
    const resolve = () =>
      resolveShieldsInto(crypto as never, [a], shields, NOT_STALE);

    expect(await resolve()).toBe(true);
    expect(shields.has(a)).toBe(true);
    expect(shields.get(a)).toBeNull();
    expect(await resolve()).toBe(false);
  });

  it('checks an event on its own even when another with the same id was checked', async () => {
    const shields = new Map<MatrixEvent, MessageShield | null>();
    const crypto = {
      getEncryptionInfoForEvent: vi.fn((e: MatrixEvent) =>
        Promise.resolve(
          e === forged
            ? {
                shieldColour: EventShieldColour.RED,
                shieldReason: EventShieldReason.UNKNOWN_DEVICE,
              }
            : null,
        ),
      ),
    };
    const trusted = event('$t', false, true);
    const forged = event('$t', false, true);

    await resolveShieldsInto(
      crypto as never,
      [trusted, forged],
      shields,
      NOT_STALE,
    );

    expect(crypto.getEncryptionInfoForEvent).toHaveBeenCalledTimes(2);
    expect(shields.get(trusted)).toBeNull();
    expect(shields.get(forged)).toMatchObject({ level: 'red' });
  });

  it('bails without touching state when the caller navigated away mid-resolve', async () => {
    const shields = new Map<MatrixEvent, MessageShield | null>();
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
  // A valid edit of this message, filled in on the test's own object.
  const replacement =
    o.replacement &&
    Object.assign(o.replacement, {
      getRelation: () => ({ rel_type: 'm.replace', event_id: id }),
      getOriginalContent: () => ({
        'm.new_content': { msgtype: 'm.text', body: '' },
      }),
      getClearContent: () => ({}),
    });
  return {
    getId: () => id,
    getSender: () => '@a:hs',
    getType: () => 'm.room.message',
    isRelation: () => false,
    getTs: () => o.ts ?? 0,
    isState: () => o.state ?? false,
    isRedacted: () => o.redacted ?? false,
    isEncrypted: () => o.encrypted ?? false,
    replacingEvent: () => replacement ?? null,
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
  const lookup = unencryptedShieldFor(roomEncryptedAt(1_000), true);

  it('maps the unencrypted mark to the red shield', () => {
    expect(lookup(sent('$later', { ts: 2_000 }))).toEqual(RED);
  });

  it('maps the unencrypted-history mark to the quieter grey shield', () => {
    expect(lookup(sent('$older', { ts: 999 }))).toEqual(GREY);
  });

  it('gives an unmarked message no shield', () => {
    expect(lookup(sent('$sealed', { encrypted: true, ts: 2_000 }))).toBeNull();
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

  it('is the event itself when its edit came from someone else', () => {
    const edit = { ...sent('$edit'), getSender: () => '@m:hs' } as MatrixEvent;
    const edited = sent('$orig', { replacement: edit });

    expect(shieldSubject(edited)).toBe(edited);
  });
});
