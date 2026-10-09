import type { Room } from 'matrix-js-sdk';

/** The crypto-store half of the SDK's own "encrypt this send?" test. */
interface RoomEncryptionProbe {
  isEncryptionEnabledInRoom(roomId: string): Promise<boolean>;
}

/**
 * Whether a room counts as encrypted, by the rule matrix-js-sdk uses when it sends: the
 * room's `m.room.encryption` state says so, or the crypto store has the room recorded as
 * encrypted. Following both means a room whose state lacks the encryption event (a
 * homeserver that leaves it out after a cache clear, say) still gets the marks and previews
 * that depend on it, while the client keeps encrypting its own sends.
 *
 * The store's answer is async: {@link refresh} fetches it once per room and caches it, and
 * {@link isEncrypted} reads the cache synchronously. Callers re-project when `refresh`
 * resolves true.
 */
export class RoomEncryptionFlags {
  private readonly stored = new Map<string, boolean>();
  private readonly pending = new Set<string>();

  isEncrypted(room: Pick<Room, 'roomId' | 'hasEncryptionStateEvent'>): boolean {
    return (
      room.hasEncryptionStateEvent() || this.stored.get(room.roomId) === true
    );
  }

  /**
   * Ask the crypto store about a room, once. Resolves true when that answer is "encrypted",
   * so only the call that fetched it reports it. A missing store or a failed read caches
   * nothing, and a later call asks again.
   */
  async refresh(
    crypto: RoomEncryptionProbe | null | undefined,
    roomId: string,
  ): Promise<boolean> {
    if (!crypto || this.stored.has(roomId) || this.pending.has(roomId)) {
      return false;
    }
    this.pending.add(roomId);
    try {
      const encrypted = await crypto.isEncryptionEnabledInRoom(roomId);
      this.stored.set(roomId, encrypted);
      return encrypted;
    } catch {
      return false;
    } finally {
      this.pending.delete(roomId);
    }
  }
}
