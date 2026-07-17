import { type MatrixEvent } from 'matrix-js-sdk';
import {
  EventShieldColour,
  EventShieldReason,
} from 'matrix-js-sdk/lib/crypto-api';
import { type MessageShield } from '@trinity/util-matrix';
import { describe, expect, it, vi } from 'vitest';
import { resolveShieldsInto, shieldKey, toShield } from './shields';

/** An encrypted event; only getId/isDecryptionFailure are read by the resolver. */
function event(id: string, decryptionFailure = false): MatrixEvent {
  return {
    getId: () => id,
    isDecryptionFailure: () => decryptionFailure,
  } as unknown as MatrixEvent;
}

const NOT_STALE = { force: false, isStale: () => false };

describe('shieldKey', () => {
  it('fingerprints a shield and distinguishes none from any', () => {
    expect(shieldKey(null)).toBe('');
    expect(shieldKey({ level: 'red', reason: 'why' })).toBe('red:why');
    // Level and reason both participate, so a change in either re-projects.
    expect(shieldKey({ level: 'grey', reason: 'why' })).not.toBe(
      shieldKey({ level: 'red', reason: 'why' }),
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
