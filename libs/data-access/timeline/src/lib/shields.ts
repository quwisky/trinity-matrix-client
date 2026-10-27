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
} from '@trinity/util/matrix';
import { type MessageShield } from './message-presentation';
import {
  shieldKey,
  shieldText,
  unencryptedShield,
} from './shield-presentation';
import { type ShieldCode } from './timeline-engine';

// shortcut: kept for the unchanged shields.spec.ts; drop when Task 4 moves the spec.
export { shieldKey };

/**
 * Per-message authenticity shields, shared by {@link TimelineService} and
 * {@link ThreadsService} so both the main timeline and the thread panel resolve and
 * render shields identically. Keeps the crypto-api mapping in one place.
 */

const SHIELD_REASONS: Partial<Record<EventShieldReason, ShieldCode['reason']>> =
  {
    [EventShieldReason.UNVERIFIED_IDENTITY]: 'unverified-identity',
    [EventShieldReason.UNSIGNED_DEVICE]: 'unsigned-device',
    [EventShieldReason.UNKNOWN_DEVICE]: 'unknown-device',
    [EventShieldReason.AUTHENTICITY_NOT_GUARANTEED]:
      'authenticity-not-guaranteed',
    [EventShieldReason.VERIFICATION_VIOLATION]: 'verification-violation',
    [EventShieldReason.MISMATCHED_SENDER]: 'mismatched-sender',
  };

/**
 * The {@link ShieldCode} reason for an SDK reason.
 *
 * Covers every reason matrix-js-sdk still emits. `MISMATCHED_SENDER_KEY` and `SENT_IN_CLEAR`
 * are deliberately absent: both are deprecated and never raised by matrix-sdk-crypto, so an
 * entry for either would be unreachable and would put a deprecated constant in our source.
 * `unknown` still covers them if that changes.
 */
function shieldReason(reason: EventShieldReason | null): ShieldCode['reason'] {
  return (reason !== null && SHIELD_REASONS[reason]) || 'unknown';
}

/** Map the SDK's encryption info to a {@link MessageShield}, or null for no shield. */
export function toShield(
  info: EventEncryptionInfo | null,
): MessageShield | null {
  if (!info || info.shieldColour === EventShieldColour.NONE) {
    return null;
  }
  return shieldText({
    colour: info.shieldColour === EventShieldColour.RED ? 'red' : 'grey',
    reason: shieldReason(info.shieldReason),
  });
}

/** A human-readable explanation for a shield reason code. */
export function shieldReasonText(reason: EventShieldReason | null): string {
  return shieldText({ colour: 'grey', reason: shieldReason(reason) }).reason;
}

/** What a shield means for the reader, paired with {@link shieldReasonText}. */
export function shieldExplanationText(
  reason: EventShieldReason | null,
): string {
  return shieldText({ colour: 'grey', reason: shieldReason(reason) })
    .explanation;
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
      shield = shieldText({ colour: 'grey', reason: 'unknown' });
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
