import { EventTimeline, EventType, type MatrixClient } from 'matrix-js-sdk';
import { Observable, defer, from, map, of, tap } from 'rxjs';
import {
  roomEncryptionInitialState,
  visibilityOptions,
} from '@trinity/util/matrix';
import { type CreateRoomOptions } from './room-library.service';

/** Shared active/exact Account implementation for encrypted Room creation. */
export function createEncryptedRoom(
  client: MatrixClient,
  options: CreateRoomOptions,
): Observable<string> {
  return from(
    client.createRoom({
      name: options.name.trim(),
      ...(options.topic?.trim() ? { topic: options.topic.trim() } : {}),
      ...visibilityOptions(options.isPublic),
      initial_state: [roomEncryptionInitialState()],
    }),
  ).pipe(
    map((response) => response.room_id),
    tap((roomId) => openCallsToMembers(client, roomId)),
  );
}

const CALL_MEMBER = 'org.matrix.msc3401.call.member';

/**
 * Lets every member of a room Trinity just created publish MatrixRTC call membership, as
 * Element Web does, by merging one key into the server's own power levels: an override at
 * creation would replace the server's whole default `events` map. Best-effort and not
 * awaited; on failure the room keeps the server's levels, so only moderators can join calls.
 * shortcut: a power-level edit sent before this lands could be overwritten by it; it runs
 * right after creation, before the room's settings can open.
 */
export function openCallsToMembers(client: MatrixClient, roomId: string): void {
  const synced = client
    .getRoom(roomId)
    ?.getLiveTimeline()
    .getState(EventTimeline.FORWARDS)
    ?.getStateEvents(EventType.RoomPowerLevels, '')
    ?.getContent<PowerLevels>();
  (synced
    ? Promise.resolve(synced)
    : (client.getStateEvent(
        roomId,
        EventType.RoomPowerLevels,
        '',
      ) as Promise<PowerLevels>)
  )
    .then((content) => {
      const level =
        content.events?.[CALL_MEMBER] ?? content.state_default ?? 50;
      if (level <= (content.users_default ?? 0)) return;
      const next = structuredClone(content);
      next.events = { ...next.events, [CALL_MEMBER]: 0 };
      return client.sendStateEvent(
        roomId,
        EventType.RoomPowerLevels,
        next as never,
        '',
      );
    })
    .catch(() => undefined);
}

interface PowerLevels {
  events?: Record<string, number>;
  state_default?: number;
  users_default?: number;
}

/**
 * The id of an existing, not-left DM room with `userId` from the `m.direct` map, or null. A
 * joined room is preferred; an outstanding invite we sent (membership `invite`) is also
 * reused so a second DM isn't created while the first is pending.
 */
export function existingDirectRoom(
  client: MatrixClient,
  userId: string,
): string | null {
  const candidates = directMap(client)[userId] ?? [];
  let firstUsable: string | null = null;
  for (const roomId of candidates) {
    const room = client.getRoom(roomId);
    const membership = room?.getMyMembership();
    if (membership === 'join') {
      return roomId; // a live DM — prefer it
    }
    if (!firstUsable && membership === 'invite') {
      firstUsable = roomId; // pending invite we sent — usable fallback
    }
  }
  return firstUsable;
}

/** Merge `roomId` into `m.direct[userId]` and persist the updated map. */
export function addToDirectMap(
  client: MatrixClient,
  userId: string,
  roomId: string,
): Observable<void> {
  // `setAccountData` does a *full replace* of m.direct, so merge against the freshest map,
  // re-read at write time (inside the defer, on subscribe), not a snapshot from before
  // `createRoom`; otherwise an m.direct update that arrived during the create round-trip
  // (another device, a concurrent DM) would be clobbered by our PUT.
  return defer(() => {
    const current = directMap(client);
    const forUser = current[userId] ?? [];
    if (forUser.includes(roomId)) {
      return of(void 0); // already recorded — nothing to write
    }
    const next = { ...current, [userId]: [...forUser, roomId] };
    return from(client.setAccountData(EventType.Direct, next)).pipe(
      map(() => void 0),
    );
  });
}

/**
 * Current `m.direct` map (`{ userId: roomId[] }`), or empty when unset. `getAccountData` is
 * called optionally so a stub client without account data yields an empty map rather than
 * throwing.
 */
function directMap(client: MatrixClient): Record<string, string[]> {
  return (
    client
      .getAccountData?.(EventType.Direct)
      ?.getContent<Record<string, string[]>>() ?? {}
  );
}
