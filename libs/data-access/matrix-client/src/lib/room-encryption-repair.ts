import {
  EventType,
  KnownMembership,
  SyncState,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { applyRoomEncryption } from '@trinity/util/matrix';

/**
 * Returns the client's sync handler for this repair. Once per joined room per session, as sync
 * reports rooms: when the crypto store has the room as encrypted but its synced state lacks
 * `m.room.encryption` (Tuwunel's `state_after` race), fetch the server's event and apply it to
 * the crypto backend. Without it the SDK refuses every send there after a reload ("unconfigured
 * room"). A failed repair is logged; sends stay refused.
 */
export function roomEncryptionRepair(
  client: MatrixClient,
): (state: SyncState) => void {
  const checked = new Set<string>();
  return (state) => {
    if (state !== SyncState.Prepared && state !== SyncState.Syncing) return;
    for (const room of client.getRooms()) {
      if (
        checked.has(room.roomId) ||
        room.getMyMembership() !== KnownMembership.Join ||
        room.hasEncryptionStateEvent()
      ) {
        continue;
      }
      checked.add(room.roomId);
      repairRoom(client, room).catch((error: unknown) =>
        console.warn("Couldn't restore a room's encryption settings.", error),
      );
    }
  };
}

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
