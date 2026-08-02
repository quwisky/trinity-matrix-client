import { type MatrixEvent } from 'matrix-js-sdk';
import {
  EventShieldColour,
  EventShieldReason,
  type EventEncryptionInfo,
} from 'matrix-js-sdk/lib/crypto-api';
import { type MessageShield } from '@trinity/util-matrix';

/**
 * Per-message authenticity shields, shared by {@link TimelineService} and
 * {@link ThreadsService} so both the main timeline and the thread panel resolve and
 * render shields identically. Keeps the crypto-api mapping in one place.
 */

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
