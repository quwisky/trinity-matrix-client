import type { MatrixEvent, Room } from 'matrix-js-sdk';
import { validReplacement } from './replacement';

/** The crypto-store half of the SDK's own "encrypt this send?" test. */
interface RoomEncryptionProbe {
  isEncryptionEnabledInRoom(roomId: string): Promise<boolean>;
}

/**
 * Whether a room counts as encrypted, by the rule matrix-js-sdk uses when it sends: the
 * room's `m.room.encryption` state says so, or the crypto store has it recorded as
 * encrypted. This covers a room whose state lacks the encryption event (a homeserver that
 * leaves it out after a cache clear, say), so its encryption marks and previews match the
 * client's own encrypted sends.
 *
 * The store's answer is async: {@link refresh} fetches it once per room and caches it for
 * {@link isEncrypted}. Callers re-project when `refresh` resolves true.
 */
export class RoomEncryptionFlags {
  private readonly stored = new Map<string, boolean>();
  private readonly pending = new Set<string>();

  isEncrypted(room: Pick<Room, 'roomId' | 'hasEncryptionStateEvent'>): boolean {
    return (
      room.hasEncryptionStateEvent() || this.stored.get(room.roomId) === true
    );
  }

  /** Whether the crypto store has answered for this room (see {@link refresh}). */
  answered(roomId: string): boolean {
    return this.stored.has(roomId);
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

/** What a preview shows instead of text that arrived unencrypted in an encrypted room. */
export const UNENCRYPTED_PREVIEW = '⚠️ Unencrypted message';

/**
 * The event whose encryption vouches for the text `event` shows: its valid latest edit when
 * it has one, else itself. An edit supplies that text, and the SDK applies it without
 * checking that it was encrypted.
 */
export function shieldSubject(event: MatrixEvent): MatrixEvent {
  return validReplacement(event) ?? event;
}

/**
 * Whether the text `event` shows (that of `subject`) arrived unencrypted. In an encrypted
 * room that text may come from any server taking part in the room, not from the member it
 * names. Local echoes, state events and redactions never count.
 */
export function arrivedInClear(
  event: MatrixEvent,
  subject: MatrixEvent = shieldSubject(event),
): boolean {
  const settled = (e: MatrixEvent): boolean =>
    !e.status && !e.isState() && !e.isRedacted();
  return settled(event) && settled(subject) && !subject.isEncrypted();
}
