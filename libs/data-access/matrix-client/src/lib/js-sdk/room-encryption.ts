import {
  EventType,
  MatrixEvent,
  type IContent,
  type Room,
} from 'matrix-js-sdk';
import type { UnencryptedMark } from '@trinity/util/matrix';
import { validReplacement } from './replacement';
import { liveRoomState } from './room-state';

/** The crypto-store half of the SDK's own "encrypt this send?" test. */
interface RoomEncryptionProbe {
  isEncryptionEnabledInRoom(roomId: string): Promise<boolean>;
}

/**
 * The SDK's crypto backend (`RustCrypto`) takes `m.room.encryption` through this method, which
 * only its sync loop calls and the exported `CryptoApi` type leaves out.
 */
interface RoomEncryptionSink extends RoomEncryptionProbe {
  onCryptoEvent(room: Room, event: MatrixEvent): Promise<void>;
}

/**
 * Configure `crypto` for a room's `m.room.encryption` `content` as sync would, so this device
 * encrypts there even when sync never delivers the event (Tuwunel's `state_after` race), then
 * read the crypto store back. Resolves whether the room is now recorded as encrypted; rejects
 * when the backend lacks the method or refuses the content.
 */
export async function applyRoomEncryption(
  crypto: unknown,
  room: Room,
  content: IContent,
): Promise<boolean> {
  const sink = crypto as Partial<RoomEncryptionSink> | null | undefined;
  if (
    typeof sink?.onCryptoEvent !== 'function' ||
    typeof sink.isEncryptionEnabledInRoom !== 'function'
  ) {
    throw new Error('The crypto backend cannot apply room encryption.');
  }
  await sink.onCryptoEvent(
    room,
    new MatrixEvent({
      type: EventType.RoomEncryption,
      state_key: '',
      room_id: room.roomId,
      content,
    }),
  );
  return sink.isEncryptionEnabledInRoom(room.roomId);
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

/**
 * A lookup that marks each message whose text arrived in the clear in an encrypted room,
 * and returns null for everything else (encrypted messages keep their crypto-derived
 * shield). Local echoes, state events and redactions are never marked. Needs no crypto
 * call, so it is synchronous; build it once per projection pass.
 *
 * Every such message is marked, whatever its date. The date only picks the tone: a message
 * dated at or after the room's current `m.room.encryption` event gets `'unencrypted'`, an
 * earlier one the quieter `'unencrypted-history'`. A room with no such event (only the
 * crypto store says it is encrypted) has nothing to compare against, so every message gets
 * the first.
 *
 * The lookup judges the text of the event's latest edit unless given the `subject` whose
 * text is shown, such as one version in an edit history.
 */
export function unencryptedMarkFor(
  room: Room,
  roomEncrypted: boolean,
): (event: MatrixEvent, subject?: MatrixEvent) => UnencryptedMark | null {
  if (!roomEncrypted) {
    return () => null;
  }
  const encryptedAt =
    liveRoomState(room)
      ?.getStateEvents(EventType.RoomEncryption, '')
      ?.getTs() ?? null;
  return (event, subject = shieldSubject(event)) => {
    if (!arrivedInClear(event, subject)) {
      return null;
    }
    const ts = subject.getTs();
    // Only a real, earlier date earns the quieter mark; a missing or zero date stays red.
    return encryptedAt !== null &&
      Number.isFinite(ts) &&
      ts > 0 &&
      ts < encryptedAt
      ? 'unencrypted-history'
      : 'unencrypted';
  };
}

/**
 * Whether a room counts as encrypted before its content leaves the device (an upload, a link
 * preview, a server search): `flags` say so, or else the crypto store does when asked now.
 * Fails closed: with no crypto store, or one that fails to answer, the room counts as
 * encrypted, since sending in the clear is the step that cannot be undone.
 */
export async function isRoomEncrypted(
  room: Pick<Room, 'roomId' | 'hasEncryptionStateEvent'>,
  crypto: RoomEncryptionProbe | null | undefined,
  flags = new RoomEncryptionFlags(),
): Promise<boolean> {
  if (flags.isEncrypted(room) || !crypto) return true;
  try {
    return await crypto.isEncryptionEnabledInRoom(room.roomId);
  } catch {
    return true;
  }
}
