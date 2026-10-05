import type { HomeserverCapabilities } from './homeserver-info.model';

/** How a room's version compares with what its homeserver offers. */
export type RoomVersionStatus = 'current' | 'newer-available' | 'unstable';

/**
 * Compare `roomVersion` with the server's `m.room_versions` capability.
 *
 * - `unstable` when the server lists the room's version as unstable;
 * - `newer-available` when the server's default is stable and a higher-numbered version;
 * - otherwise `current`.
 *
 * Null when the server stated neither a default nor an available map. "Newer" needs both
 * versions to be whole numbers: a room created elsewhere at v12 on a server defaulting to
 * v10 is not behind. A default without a stability entry counts as stable — the server
 * chose it as the version it creates rooms at.
 */
export function roomVersionStatus(
  roomVersion: string,
  capabilities: HomeserverCapabilities | null,
): RoomVersionStatus | null {
  const preferred = capabilities?.defaultRoomVersion ?? null;
  const available = capabilities?.roomVersions ?? null;
  if (preferred === null && available === null) {
    return null;
  }
  if (available?.[roomVersion] === 'unstable') {
    return 'unstable';
  }
  if (
    preferred !== null &&
    available?.[preferred] !== 'unstable' &&
    wholeNumber(preferred) > wholeNumber(roomVersion)
  ) {
    return 'newer-available';
  }
  return 'current';
}

/** A version string as a whole number, or NaN for anything else (`org.matrix.msc…`). */
function wholeNumber(version: string): number {
  return /^\d+$/.test(version) ? Number(version) : Number.NaN;
}
