import { EventType, Preset, type MatrixClient } from 'matrix-js-sdk';
import { Observable, defer, from, map, of, switchMap, throwError } from 'rxjs';
import {
  isValidUserId,
  roomEncryptionInitialState,
  visibilityOptions,
} from '@trinity/util/matrix';
import { type CreateRoomOptions } from '../room-library.service';

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
  ).pipe(map((response) => response.room_id));
}

/**
 * Open (or reuse) a 1:1 direct message with `userId` and resolve its room id.
 *
 * A DM that `m.direct` records with this user and that we have not left is reused, so
 * repeated "message" actions don't spawn duplicates. Otherwise a new invite-only, encrypted
 * room is created (`is_direct`, `trusted_private_chat` preset, the user invited, Megolm
 * enabled) and registered in `m.direct` so both ends and future reuse treat it as a DM.
 * Rejects when `userId` isn't a valid MXID. Cold.
 */
export function openDirectRoom(
  client: MatrixClient,
  userId: string,
): Observable<string> {
  return defer(() => {
    if (!isValidUserId(userId)) {
      return throwError(() => new Error(`Invalid user id: ${userId}`));
    }
    const existing = existingDirectRoom(client, userId);
    if (existing) {
      return of(existing);
    }
    return from(
      client.createRoom({
        is_direct: true,
        invite: [userId],
        preset: Preset.TrustedPrivateChat,
        initial_state: [roomEncryptionInitialState()],
      }),
    ).pipe(
      switchMap((res) =>
        addToDirectMap(client, userId, res.room_id).pipe(
          map(() => res.room_id),
        ),
      ),
    );
  });
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
