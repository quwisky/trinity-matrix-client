import { EventType, type MatrixEvent, type Room } from 'matrix-js-sdk';
import {
  EventShieldColour,
  EventShieldReason,
  type EventEncryptionInfo,
} from 'matrix-js-sdk/lib/crypto-api';
import { liveRoomState } from '@trinity/util/matrix';
import { type MessageShield } from './message-presentation';

/**
 * Per-message authenticity shields, shared by {@link TimelineService} and
 * {@link ThreadsService} so both the main timeline and the thread panel resolve and
 * render shields identically. Keeps the crypto-api mapping in one place.
 */

/** Shown on a message that was sent without end-to-end encryption into an encrypted room. */
export const UNENCRYPTED_SHIELD: MessageShield = Object.freeze({
  level: 'unencrypted',
  reason: 'Not encrypted',
  explanation: 'This message was sent without end-to-end encryption.',
});

/**
 * The quieter form of {@link UNENCRYPTED_SHIELD} for a message dated before the room
 * turned encryption on: it is just as unencrypted, but its date explains why.
 */
export const UNENCRYPTED_HISTORY_SHIELD: MessageShield = Object.freeze({
  level: 'unencrypted-history',
  reason: 'Not encrypted',
  explanation:
    'This message is dated before the room turned on end-to-end encryption.',
});

/** Stable fingerprint of a shield for cache revs + change detection ('' = none). */
export function shieldKey(shield: MessageShield | null): string {
  return shield ? `${shield.level}:${shield.reason}` : '';
}

/** Map the SDK's encryption info to a {@link MessageShield}, or null for no shield. */
export function toShield(
  info: EventEncryptionInfo | null,
): MessageShield | null {
  if (!info || info.shieldColour === EventShieldColour.NONE) {
    return null;
  }
  return {
    level: info.shieldColour === EventShieldColour.RED ? 'red' : 'grey',
    reason: shieldReasonText(info.shieldReason),
    explanation: shieldExplanationText(info.shieldReason),
  };
}

/**
 * A human-readable explanation for a shield reason code.
 *
 * Covers every reason matrix-js-sdk still emits. `MISMATCHED_SENDER_KEY` and
 * `SENT_IN_CLEAR` are deliberately absent: both are deprecated and never raised by
 * matrix-sdk-crypto (the sender_key field went unchecked in v37, and SENT_IN_CLEAR
 * "has never been used"), so a case for either would be unreachable — and would put a
 * deprecated constant in our source. The default below still covers them if that
 * changes.
 */
export function shieldReasonText(reason: EventShieldReason | null): string {
  switch (reason) {
    case EventShieldReason.UNVERIFIED_IDENTITY:
      return 'Sent by a user you haven’t verified.';
    case EventShieldReason.UNSIGNED_DEVICE:
      return 'Sent from a device its owner hasn’t verified.';
    case EventShieldReason.UNKNOWN_DEVICE:
      return 'Sent from an unknown or deleted device.';
    case EventShieldReason.AUTHENTICITY_NOT_GUARANTEED:
      return 'The authenticity of this message can’t be guaranteed.';
    case EventShieldReason.VERIFICATION_VIOLATION:
      return 'Sent by a user whose verified identity has changed.';
    case EventShieldReason.MISMATCHED_SENDER:
      return 'The sender doesn’t match the device that encrypted this.';
    default:
      return 'This message’s authenticity couldn’t be verified.';
  }
}

/**
 * What a shield means for the reader, paired with {@link shieldReasonText}. A shield
 * says the message could not be *attributed*, never that it was read by anyone — so
 * these say what the doubt is and who can clear it, without implying interception.
 */
export function shieldExplanationText(
  reason: EventShieldReason | null,
): string {
  switch (reason) {
    case EventShieldReason.UNVERIFIED_IDENTITY:
      return 'Trinity can’t confirm it really came from them. Verify this person to be sure.';
    case EventShieldReason.UNSIGNED_DEVICE:
      return 'Only its owner can confirm the device is theirs, by verifying it from another of their sessions.';
    case EventShieldReason.UNKNOWN_DEVICE:
      return 'There is no record of the device, so there is nothing to check the message against.';
    case EventShieldReason.AUTHENTICITY_NOT_GUARANTEED:
      return 'The key that decrypted it didn’t come straight from the sender — a key backup, for example.';
    case EventShieldReason.VERIFICATION_VIOLATION:
      return 'You verified this person before and their identity has changed since. Check with them another way, then verify them again.';
    case EventShieldReason.MISMATCHED_SENDER:
      return 'It claims to come from someone other than the account that set up its encryption, so don’t take the name on it at face value.';
    default:
      return 'Trinity couldn’t work out which device sent it.';
  }
}

/**
 * The event a row's shield must judge: its latest edit when it has one, else itself. An
 * edit supplies the text the row shows, and the SDK applies it without checking that it
 * was encrypted, so the edit's own encryption is what vouches for that text.
 */
export function shieldSubject(event: MatrixEvent): MatrixEvent {
  return event.replacingEvent() ?? event;
}

/**
 * A lookup that marks each message whose text arrived in the clear in an encrypted room,
 * and returns null for everything else (encrypted messages keep their crypto-derived
 * shield). Local echoes, state events and redactions are never marked. Needs no crypto
 * call, so it is synchronous; build it once per projection pass.
 *
 * Every such message is marked, whatever its date. The date only picks the tone: a message
 * dated at or after the room's current `m.room.encryption` event gets
 * {@link UNENCRYPTED_SHIELD}, an earlier one the quieter {@link UNENCRYPTED_HISTORY_SHIELD}.
 * A room with no such event (only the crypto store says it is encrypted) has nothing to
 * compare against, so every message gets the first.
 */
export function unencryptedShieldFor(
  room: Room,
  roomEncrypted: boolean,
): (event: MatrixEvent) => MessageShield | null {
  if (!roomEncrypted) {
    return () => null;
  }
  const encryptedAt =
    liveRoomState(room)
      ?.getStateEvents(EventType.RoomEncryption, '')
      ?.getTs() ?? null;
  const settled = (e: MatrixEvent): boolean =>
    !e.status && !e.isState() && !e.isRedacted();
  return (event) => {
    const subject = shieldSubject(event);
    if (!settled(event) || !settled(subject) || subject.isEncrypted()) {
      return null;
    }
    const ts = subject.getTs();
    // Only a real, earlier date earns the quieter mark; a missing or zero date stays red.
    return encryptedAt !== null &&
      Number.isFinite(ts) &&
      ts > 0 &&
      ts < encryptedAt
      ? UNENCRYPTED_HISTORY_SHIELD
      : UNENCRYPTED_SHIELD;
  };
}

/** The slice of the crypto API the shield resolver needs. */
export interface ShieldCrypto {
  getEncryptionInfoForEvent(
    event: MatrixEvent,
  ): Promise<EventEncryptionInfo | null>;
}

/**
 * Resolve authenticity shields for `events` (already filtered to encrypted, displayable
 * events) into the `shields` map, returning true when any entry changed. A benign
 * refresh skips an already-resolved, decrypted event — only a new event, a still-
 * undecryptable one (whose info arrives on decrypt), or `force` (a trust change)
 * re-probes the async crypto API. `isStale` is checked after each await so a caller
 * that navigated away mid-resolve bails without touching state.
 */
export async function resolveShieldsInto(
  crypto: ShieldCrypto,
  events: readonly MatrixEvent[],
  shields: Map<string, MessageShield | null>,
  opts: { force: boolean; isStale: () => boolean },
): Promise<boolean> {
  let changed = false;
  for (const event of events) {
    const id = event.getId() ?? '';
    if (!opts.force && shields.has(id) && !event.isDecryptionFailure()) {
      continue;
    }
    let shield: MessageShield | null = null;
    try {
      shield = toShield(await crypto.getEncryptionInfoForEvent(event));
    } catch {
      // Fail CLOSED. `events` is already filtered to encrypted events, and null renders
      // as NO shield — visually identical to a fully authenticated message. A transient
      // crypto/store error must not silently upgrade an unverified message's appearance;
      // show the cautious indicator instead. (Still caught, so a probe failure can never
      // break the timeline — that part of the original intent stands.)
      shield = {
        level: 'grey',
        reason: shieldReasonText(null),
        explanation: shieldExplanationText(null),
      };
    }
    if (opts.isStale()) {
      return changed; // switched rooms/threads mid-resolve
    }
    if (shieldKey(shields.get(id) ?? null) !== shieldKey(shield)) {
      shields.set(id, shield);
      changed = true;
    }
  }
  return changed;
}
