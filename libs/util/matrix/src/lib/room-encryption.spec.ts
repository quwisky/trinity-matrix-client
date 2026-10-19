import { describe, expect, it, vi } from 'vitest';
import type { MatrixEvent } from 'matrix-js-sdk';
import {
  RoomEncryptionFlags,
  applyRoomEncryption,
  isRoomEncrypted,
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
