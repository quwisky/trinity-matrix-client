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
  };
}

/** A human-readable explanation for a shield reason code. */
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
    default:
      return 'This message’s authenticity couldn’t be verified.';
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
      shield = null; // never let a shield probe break the timeline
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
