import { type MatrixEvent, type Room } from 'matrix-js-sdk';
import {
  EventShieldColour,
  EventShieldReason,
  type EventEncryptionInfo,
} from 'matrix-js-sdk/lib/crypto-api';
import {
  displayContent,
  shieldSubject,
  unencryptedMarkFor,
  type UnencryptedMark,
} from '@trinity/util/matrix';
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
 * Covers every reason matrix-js-sdk still emits. `MISMATCHED_SENDER_KEY` and `SENT_IN_CLEAR`
 * are deliberately absent: both are deprecated and never raised by matrix-sdk-crypto, so a
 * case for either would be unreachable and would put a deprecated constant in our source.
 * The default below still covers them if that changes.
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

export { shieldSubject };

/** Resolved shields, each kept against the exact event object it was computed for. */
export type ShieldStore = Pick<
  WeakMap<MatrixEvent, MessageShield | null>,
  'get' | 'has' | 'set'
>;

/**
 * The resolved shields of every event this client has checked. Keyed by object, not id: an
 * id is whatever the server put on the event, so another event reusing it must never borrow
 * its result. The timeline and threads force a fresh check when they open, so a trust change
 * made while they were closed is picked up.
 */
export const resolvedShields: ShieldStore = new WeakMap();

/**
 * The event whose text, edited mark and shield a row shows: its {@link shieldSubject}, except
 * that an encrypted edit waits until its own shield has resolved. Until then the row shows
 * the message as it was, so an edit's text never appears before its own check.
 */
export function shownSubject(
  event: MatrixEvent,
  shields: ShieldStore = resolvedShields,
): MatrixEvent {
  const subject = shieldSubject(event);
  return subject === event || !subject.isEncrypted() || shields.has(subject)
    ? subject
    : event;
}

/**
 * The encrypted events whose shields a row needs: its {@link shieldSubject}, and its own
 * event too when that is an edit, since the row shows the message's shield while the edit's
 * own check is pending.
 */
export function shieldsToCheck(event: MatrixEvent): MatrixEvent[] {
  const subject = shieldSubject(event);
  return (subject === event ? [event] : [event, subject]).filter((e) =>
    e.isEncrypted(),
  );
}

/** Whether a row shows `event`'s edit yet (see {@link shownSubject}). */
export function showsEdit(event: MatrixEvent): boolean {
  return shownSubject(event) !== event;
}

/** The content a row shows for `event`: its edit's once {@link showsEdit}, else its own. */
export function shownContent(event: MatrixEvent): Record<string, unknown> {
  return showsEdit(event) ? displayContent(event) : event.getOriginalContent();
}

/** The resolved shield of the event a row shows, or null while it is pending. */
export function shownShield(shown: MatrixEvent): MessageShield | null {
  return resolvedShields.get(shown) ?? null;
}

/**
 * The shield for a not-encrypted mark: {@link UNENCRYPTED_SHIELD}, or the quieter
 * {@link UNENCRYPTED_HISTORY_SHIELD} for a message dated before the room turned encryption on.
 */
export function unencryptedShield(
  mark: UnencryptedMark | null,
): MessageShield | null {
  if (mark === null) return null;
  return mark === 'unencrypted-history'
    ? UNENCRYPTED_HISTORY_SHIELD
    : UNENCRYPTED_SHIELD;
}

/** {@link unencryptedMarkFor} as the timeline's shields; see {@link unencryptedShield}. */
export function unencryptedShieldFor(
  room: Room,
  roomEncrypted: boolean,
): (event: MatrixEvent, subject?: MatrixEvent) => MessageShield | null {
  const markFor = unencryptedMarkFor(room, roomEncrypted);
  return (event, subject) => unencryptedShield(markFor(event, subject));
}

/** The slice of the crypto API the shield resolver needs. */
export interface ShieldCrypto {
  getEncryptionInfoForEvent(
    event: MatrixEvent,
  ): Promise<EventEncryptionInfo | null>;
}

/**
 * Resolve authenticity shields for `events` (already filtered to encrypted, displayable
 * events) into `shields`, returning true when any entry changed. A benign
 * refresh skips an already-resolved, decrypted event — only a new event, a still-
 * undecryptable one (whose info arrives on decrypt), or `force` (a trust change)
 * re-probes the async crypto API. `isStale` is checked after each await so a caller
 * that navigated away mid-resolve bails without touching state.
 */
export async function resolveShieldsInto(
  crypto: ShieldCrypto,
  events: readonly MatrixEvent[],
  shields: ShieldStore,
  opts: { force: boolean; isStale: () => boolean },
): Promise<boolean> {
  let changed = false;
  for (const event of events) {
    if (!opts.force && shields.has(event) && !event.isDecryptionFailure()) {
      continue;
    }
    let shield: MessageShield | null = null;
    try {
      shield = toShield(await crypto.getEncryptionInfoForEvent(event));
    } catch {
      // Fail CLOSED. `events` is already filtered to encrypted events, and null renders as NO
      // shield, visually identical to a fully authenticated message. A transient crypto/store
      // error must not silently upgrade an unverified message's appearance; show the cautious
      // indicator instead. (Still caught, so a probe failure can never break the timeline.)
      shield = {
        level: 'grey',
        reason: shieldReasonText(null),
        explanation: shieldExplanationText(null),
      };
    }
    if (opts.isStale()) {
      return changed; // switched rooms/threads mid-resolve
    }
    // A trusted (null) result is kept once the event is decrypted, so a pending edit can be
    // told from a checked one (see shownSubject). Before decryption it stays absent and is
    // asked again.
    const record = shields.has(event)
      ? shieldKey(shields.get(event) ?? null) !== shieldKey(shield)
      : shield !== null || event.getClearContent() !== null;
    if (record) {
      shields.set(event, shield);
      changed = true;
    }
  }
  return changed;
}
