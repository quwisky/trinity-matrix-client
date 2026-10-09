import { describe, expect, it, vi } from 'vitest';
import { RoomEncryptionFlags } from './room-encryption';

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
