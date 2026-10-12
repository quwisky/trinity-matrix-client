import { liveRoomState } from '@trinity/util/matrix';
import { EventType, type MatrixClient } from 'matrix-js-sdk';

/** The names one account knows: what a diagnostic file must replace. */
export interface AccountKnownNames {
  readonly roomNames: readonly string[];
  readonly roomTopics: readonly string[];
  readonly displayNames: readonly string[];
}

/**
 * Room names, room topics and joined members' display names, the user's own included, read
 * from one client's memory at the moment of the call. Nothing is fetched or kept.
 */
export function accountKnownNames(
  client: Pick<MatrixClient, 'getRooms' | 'getUserId' | 'getUser'>,
): AccountKnownNames {
  const roomNames = new Set<string>();
  const roomTopics = new Set<string>();
  const displayNames = new Set<string>();
  const ownId = client.getUserId();
  const ownName = ownId ? client.getUser(ownId)?.displayName : undefined;
  if (ownName) {
    displayNames.add(ownName);
  }
  for (const room of client.getRooms()) {
    addString(roomNames, stateContent(room, EventType.RoomName, 'name'));
    addString(roomTopics, stateContent(room, EventType.RoomTopic, 'topic'));
    for (const member of room.getJoinedMembers()) {
      // Without a display name, the SDK reports the user ID, which is redacted as an ID.
      if (member.rawDisplayName !== member.userId) {
        addString(displayNames, member.rawDisplayName);
      }
    }
  }
  return {
    roomNames: [...roomNames],
    roomTopics: [...roomTopics],
    displayNames: [...displayNames],
  };
}

type ClientRoom = ReturnType<MatrixClient['getRooms']>[number];

function stateContent(
  room: ClientRoom,
  type: EventType.RoomName | EventType.RoomTopic,
  field: string,
): unknown {
  const content: Record<string, unknown> | undefined = liveRoomState(room)
    ?.getStateEvents(type, '')
    ?.getContent();
  return content?.[field];
}

function addString(names: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) {
    names.add(value);
  }
}
