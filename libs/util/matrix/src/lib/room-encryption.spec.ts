import { describe, expect, it, vi } from 'vitest';
import type { MatrixEvent, Room } from 'matrix-js-sdk';
import {
  RoomEncryptionFlags,
  applyRoomEncryption,
  isRoomEncrypted,
  unencryptedMarkFor,
} from './room-encryption';

const room = (stateSaysEncrypted: boolean, roomId = '!r:hs') => ({
  roomId,
  hasEncryptionStateEvent: () => stateSaysEncrypted,
});

describe('RoomEncryptionFlags', () => {
  it('follows the room state when the crypto store has not been asked', () => {
    const flags = new RoomEncryptionFlags();

    expect(flags.isEncrypted(room(true))).toBe(true);
    expect(flags.isEncrypted(room(false))).toBe(false);
  });

  // The SDK encrypts a send when the state says so OR the crypto store has the room
  // recorded as encrypted. A room whose state lacks the encryption event but whose store
  // has it is still one the client encrypts for, so it must still count as encrypted.
  it('counts a room the crypto store reports as encrypted even when its state lacks the event', async () => {
    const flags = new RoomEncryptionFlags();
    const crypto = {
      isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
    };

    expect(flags.isEncrypted(room(false))).toBe(false);
    await expect(flags.refresh(crypto, '!r:hs')).resolves.toBe(true);

    expect(flags.isEncrypted(room(false))).toBe(true);
    expect(crypto.isEncryptionEnabledInRoom).toHaveBeenCalledWith('!r:hs');
  });

  it('keeps a room unencrypted when the store says so too', async () => {
    const flags = new RoomEncryptionFlags();
    const crypto = {
      isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(false),
    };

    await expect(flags.refresh(crypto, '!r:hs')).resolves.toBe(false);

    expect(flags.isEncrypted(room(false))).toBe(false);
  });

  it('asks the store once per room, however many refreshes follow', async () => {
    const flags = new RoomEncryptionFlags();
    const crypto = {
      isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
    };

    const first = flags.refresh(crypto, '!r:hs');
    const concurrent = flags.refresh(crypto, '!r:hs');
    await first;
    await flags.refresh(crypto, '!r:hs');

    // Only the call that fetched the answer reports it, so a caller re-projects once.
    await expect(concurrent).resolves.toBe(false);
    expect(crypto.isEncryptionEnabledInRoom).toHaveBeenCalledTimes(1);
  });

  it('keeps rooms apart', async () => {
    const flags = new RoomEncryptionFlags();
    const crypto = {
      isEncryptionEnabledInRoom: vi.fn(async (id: string) => id === '!a:hs'),
    };

    await flags.refresh(crypto, '!a:hs');
    await flags.refresh(crypto, '!b:hs');

    expect(flags.isEncrypted(room(false, '!a:hs'))).toBe(true);
    expect(flags.isEncrypted(room(false, '!b:hs'))).toBe(false);
  });

  it('reports nothing and keeps the room state when the store rejects', async () => {
    const flags = new RoomEncryptionFlags();
    const crypto = {
      isEncryptionEnabledInRoom: vi
        .fn()
        .mockRejectedValue(new Error('store unavailable')),
    };

    await expect(flags.refresh(crypto, '!r:hs')).resolves.toBe(false);
    expect(flags.isEncrypted(room(false))).toBe(false);
    expect(flags.isEncrypted(room(true))).toBe(true);
  });

  it('asks again after a failed or unavailable store, rather than caching the gap', async () => {
    const flags = new RoomEncryptionFlags();
    const crypto = {
      isEncryptionEnabledInRoom: vi
        .fn()
        .mockRejectedValueOnce(new Error('store unavailable'))
        .mockResolvedValueOnce(true),
    };

    await expect(flags.refresh(null, '!r:hs')).resolves.toBe(false);
    await expect(flags.refresh(crypto, '!r:hs')).resolves.toBe(false);
    await expect(flags.refresh(crypto, '!r:hs')).resolves.toBe(true);

    expect(flags.isEncrypted(room(false))).toBe(true);
  });
});

describe('isRoomEncrypted', () => {
  const answers = (encrypted: boolean) => ({
    isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(encrypted),
  });

  it('takes the room state without asking the crypto store', async () => {
    const crypto = answers(false);

    await expect(isRoomEncrypted(room(true), crypto)).resolves.toBe(true);
    expect(crypto.isEncryptionEnabledInRoom).not.toHaveBeenCalled();
  });

  it('counts a room the crypto store reports as encrypted when its state lacks the event', async () => {
    const crypto = answers(true);

    await expect(isRoomEncrypted(room(false), crypto)).resolves.toBe(true);
    expect(crypto.isEncryptionEnabledInRoom).toHaveBeenCalledWith('!r:hs');
  });

  it('counts a room the flags already hold as encrypted', async () => {
    const flags = new RoomEncryptionFlags();
    await flags.refresh(answers(true), '!r:hs');

    await expect(
      isRoomEncrypted(room(false), answers(false), flags),
    ).resolves.toBe(true);
  });

  it('is unencrypted only when the state and the crypto store both say so', async () => {
    await expect(isRoomEncrypted(room(false), answers(false))).resolves.toBe(
      false,
    );
  });

  it('counts the room as encrypted when there is no crypto store or it fails to answer', async () => {
    const failing = {
      isEncryptionEnabledInRoom: vi
        .fn()
        .mockRejectedValue(new Error('store unavailable')),
    };

    await expect(isRoomEncrypted(room(false), null)).resolves.toBe(true);
    await expect(isRoomEncrypted(room(false), undefined)).resolves.toBe(true);
    await expect(isRoomEncrypted(room(false), failing)).resolves.toBe(true);
  });
});

describe('applyRoomEncryption', () => {
  // The SDK hands m.room.encryption to its crypto backend only from the sync loop, through a
  // method its exported CryptoApi type leaves out. An upgrade that renames it must fail here.
  it('relies on a method the installed RustCrypto backend still has', async () => {
    const { RustCrypto } =
      await import('matrix-js-sdk/lib/rust-crypto/rust-crypto');

    expect(typeof RustCrypto.prototype.onCryptoEvent).toBe('function');
    expect(typeof RustCrypto.prototype.isEncryptionEnabledInRoom).toBe(
      'function',
    );
  });

  it('hands the backend the content as an m.room.encryption state event and reads the store back', async () => {
    const target = room(false);
    const onCryptoEvent = vi.fn((_room: unknown, _event: MatrixEvent) =>
      Promise.resolve(),
    );
    const crypto = {
      onCryptoEvent,
      isEncryptionEnabledInRoom: () => Promise.resolve(true),
    };

    await expect(
      applyRoomEncryption(crypto, target as never, {
        algorithm: 'm.megolm.v1.aes-sha2',
      }),
    ).resolves.toBe(true);

    const [appliedRoom, event] = onCryptoEvent.mock.calls[0] ?? [];
    expect(appliedRoom).toBe(target);
    expect(event?.getType()).toBe('m.room.encryption');
    expect(event?.getStateKey()).toBe('');
    expect(event?.getRoomId()).toBe('!r:hs');
    expect(event?.getContent()).toEqual({ algorithm: 'm.megolm.v1.aes-sha2' });
  });

  it('rejects a crypto backend without the method', async () => {
    const content = { algorithm: 'm.megolm.v1.aes-sha2' };

    await expect(
      applyRoomEncryption(
        { isEncryptionEnabledInRoom: () => Promise.resolve(true) },
        room(false) as never,
        content,
      ),
    ).rejects.toThrow();
    await expect(
      applyRoomEncryption(null, room(false) as never, content),
    ).rejects.toThrow();
  });
});

/** A message-or-state event as the unencrypted-mark lookup reads it. */
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

describe('unencryptedMarkFor', () => {
  const at = (encryptedAt: number | null, roomEncrypted = true) =>
    unencryptedMarkFor(roomEncryptedAt(encryptedAt), roomEncrypted);

  it('marks a message dated at or after the encryption event as unencrypted', () => {
    const lookup = at(1_000);

    expect(lookup(sent('$later', { ts: 2_000 }))).toBe('unencrypted');
    expect(lookup(sent('$same', { ts: 1_000 }))).toBe('unencrypted');
  });

  it('marks a message dated before the encryption event as unencrypted-history', () => {
    expect(at(1_000)(sent('$older', { ts: 999 }))).toBe('unencrypted-history');
  });

  it('keeps a message with a zero or missing date as unencrypted', () => {
    const lookup = at(1_000);

    expect(lookup(sent('$zero', { ts: 0 }))).toBe('unencrypted');
    expect(
      lookup({
        ...sent('$missing'),
        getTs: () => undefined,
      } as unknown as MatrixEvent),
    ).toBe('unencrypted');
  });

  it('marks every message as unencrypted when the room has no encryption state event', () => {
    // Only the crypto store says the room is encrypted, so there is no date to compare to.
    const lookup = at(null);

    expect(lookup(sent('$old', { ts: 1 }))).toBe('unencrypted');
    expect(lookup(sent('$new', { ts: 9_999_999 }))).toBe('unencrypted');
  });

  // Dating a message earlier only changes the tone; it is never a reason to leave
  // a plaintext message unmarked.
  it('never leaves a plaintext message unmarked on its date alone', () => {
    const lookup = at(1_000);

    for (const ts of [0, 1, 999, 1_000, 1_001, Number.MAX_SAFE_INTEGER]) {
      expect(lookup(sent(`$${ts}`, { ts }))).not.toBeNull();
    }
  });

  it('leaves an encrypted message unmarked, whatever its date', () => {
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
    it('leaves an encrypted message unmarked over its ignored plaintext edit', () => {
      const original = sent('$orig', {
        encrypted: true,
        ts: 500,
        replacement: sent('$edit', { ts: 2_000 }),
      });

      expect(at(1_000)(original)).toBeNull();
    });

    it('judges the date of the edit, not of the message it replaces', () => {
      const oldEdit = sent('$orig', {
        ts: 2_000,
        replacement: sent('$edit', { ts: 500 }),
      });

      expect(at(1_000)(oldEdit)).toBe('unencrypted-history');
    });

    it('judges the given subject instead of the latest edit', () => {
      const original = sent('$orig', {
        ts: 2_000,
        replacement: sent('$edit', { ts: 500 }),
      });

      expect(at(1_000)(original, original)).toBe('unencrypted');
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
