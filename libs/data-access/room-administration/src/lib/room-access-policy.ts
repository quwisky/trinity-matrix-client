import { RestrictedAllowType } from 'matrix-js-sdk';
import type { RoomJoinRulesEventContent } from 'matrix-js-sdk/lib/@types/state_events';

/** Read the unique, well-formed Space IDs understood by Matrix restricted joins. */
export function allowedSpaceIdsOf(allow: unknown): string[] {
  if (!Array.isArray(allow)) return [];
  return allow
    .filter(
      (entry): entry is { type: string; room_id: string } =>
        !!entry &&
        typeof entry === 'object' &&
        (entry as { type?: unknown }).type ===
          RestrictedAllowType.RoomMembership &&
        typeof (entry as { room_id?: unknown }).room_id === 'string' &&
        (entry as { room_id: string }).room_id.length > 0,
    )
    .map((entry) => entry.room_id)
    .filter((roomId, index, ids) => ids.indexOf(roomId) === index);
}

/** Return the first invalid Space ID so the command can fail before any write. */
export function invalidAllowedSpaceId(
  allowedSpaceIds: readonly string[],
): string | undefined {
  return allowedSpaceIds.find((value) => !/^![^:\s]+:.+$/.test(value));
}

/**
 * Build a restricted allow list from understood Space IDs while retaining extension entries.
 * The SDK models only the specified room-membership rule, but Matrix state is extensible; the
 * assertion stays at this SDK boundary until the public type grows an extension shape.
 */
export function restrictedAllowEntriesForWrite(
  allowedSpaceIds: readonly string[],
  currentAllow: unknown,
): RoomJoinRulesEventContent['allow'] {
  const roomMembershipEntries = [...new Set(allowedSpaceIds)].map((roomId) => ({
    type: RestrictedAllowType.RoomMembership,
    room_id: roomId,
  }));
  const unknownEntries = Array.isArray(currentAllow)
    ? currentAllow.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as { type?: unknown }).type === 'string' &&
          (entry as { type: string }).type !==
            RestrictedAllowType.RoomMembership,
      )
    : [];
  return [
    ...roomMembershipEntries,
    ...unknownEntries,
  ] as RoomJoinRulesEventContent['allow'];
}
