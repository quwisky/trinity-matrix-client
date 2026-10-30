import {
  EventType,
  KnownMembership,
  SyncState,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { applyRoomEncryption } from './room-encryption';

/**
 * Returns the client's sync handler for this repair. Once per joined room per session, as sync
 * reports rooms: when the crypto store has the room as encrypted but its synced state lacks
 * `m.room.encryption` (Tuwunel's `state_after` race), fetch the server's event and apply it to
 * the crypto backend. Without it the SDK refuses every send there after a reload ("unconfigured
 * room"). A failed repair is logged and retried after {@link FIRST_RETRY_SYNCS} syncs, doubling
 * per failure up to {@link MAX_RETRY_SYNCS}; sends stay refused meanwhile.
 */
export function roomEncryptionRepair(
  client: MatrixClient,
): (state: SyncState) => void {
  /** Rooms repaired, found unencrypted, or with a repair in flight. */
  const settled = new Set<string>();
  const retries = new Map<
    string,
    { readonly at: number; readonly wait: number }
  >();
  let syncs = 0;
  return (state) => {
    if (state !== SyncState.Prepared && state !== SyncState.Syncing) return;
    syncs++;
    for (const room of client.getRooms()) {
      const { roomId } = room;
      if (
        settled.has(roomId) ||
        (retries.get(roomId)?.at ?? 0) > syncs ||
        room.getMyMembership() !== KnownMembership.Join ||
        room.hasEncryptionStateEvent()
      ) {
        continue;
      }
      settled.add(roomId);
      repairRoom(client, room).catch((error: unknown) => {
        settled.delete(roomId);
        const wait = Math.min(
          (retries.get(roomId)?.wait ?? FIRST_RETRY_SYNCS / 2) * 2,
          MAX_RETRY_SYNCS,
        );
        retries.set(roomId, { at: syncs + wait, wait });
        console.warn("Couldn't restore a room's encryption settings.", error);
      });
    }
  };
}

const FIRST_RETRY_SYNCS = 2;
const MAX_RETRY_SYNCS = 64;

async function repairRoom(client: MatrixClient, room: Room): Promise<void> {
  const crypto = client.getCrypto();
  if (!crypto || !(await crypto.isEncryptionEnabledInRoom(room.roomId))) {
    return;
  }
  const content = await client.getStateEvent(
    room.roomId,
    EventType.RoomEncryption,
    '',
  );
  if (!(await applyRoomEncryption(crypto, room, content))) {
    throw new Error('The crypto store did not record the room as encrypted.');
  }
}
