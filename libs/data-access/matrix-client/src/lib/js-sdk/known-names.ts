import { liveRoomState } from './room-state';
import { EventType, type MatrixClient, type RoomState } from 'matrix-js-sdk';
import type { AccountNameGroup } from '../session-engine';

/** `SessionEngine.knownNames`, read from the client's memory. */
export function accountKnownNames(
  client: Pick<MatrixClient, 'getRooms' | 'getUserId' | 'getUser'>,
): readonly AccountNameGroup[] {
  const ownId = client.getUserId();
  const ownName = ownId ? client.getUser(ownId)?.displayName : undefined;
  return [
    { roomNames: [], roomTopics: [], displayNames: ownName ? [ownName] : [] },
    ...client.getRooms().map((room) => {
      const state = liveRoomState(room);
      return {
        roomNames: strings(stateContent(state, EventType.RoomName, 'name')),
        roomTopics: strings(stateContent(state, EventType.RoomTopic, 'topic')),
        displayNames: memberNames(state),
      };
    }),
  ];
}

function memberNames(state: RoomState | undefined): readonly string[] {
  return (state?.getMembers() ?? []).flatMap((member) =>
    // Without a display name, the SDK reports the user ID, which is redacted as an ID.
    member.rawDisplayName && member.rawDisplayName !== member.userId
      ? [member.rawDisplayName]
      : [],
  );
}

function stateContent(
  state: RoomState | undefined,
  type: EventType.RoomName | EventType.RoomTopic,
  field: string,
): unknown {
  const content: Record<string, unknown> | undefined = state
    ?.getStateEvents(type, '')
    ?.getContent();
  return content?.[field];
}

function strings(value: unknown): readonly string[] {
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}
