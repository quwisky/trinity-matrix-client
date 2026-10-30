import { liveRoomState } from './js-sdk/room-state';
import { EventType, type MatrixClient, type RoomState } from 'matrix-js-sdk';

/** Names one source knows: the account itself, or one room. */
export interface AccountNameGroup {
  readonly roomNames: readonly string[];
  readonly roomTopics: readonly string[];
  /** Read lazily, so a large room is read a few names at a time. */
  readonly displayNames: Iterable<string>;
}

/**
 * The account's own display name, then each room's name, topic and members' display names
 * (joined, invited, left and banned), read from the client's memory as they are iterated.
 * Nothing is fetched or kept.
 */
export function* accountKnownNames(
  client: Pick<MatrixClient, 'getRooms' | 'getUserId' | 'getUser'>,
): Generator<AccountNameGroup, void> {
  const ownId = client.getUserId();
  const ownName = ownId ? client.getUser(ownId)?.displayName : undefined;
  yield {
    roomNames: [],
    roomTopics: [],
    displayNames: ownName ? [ownName] : [],
  };
  for (const room of client.getRooms()) {
    const state = liveRoomState(room);
    yield {
      roomNames: strings(stateContent(state, EventType.RoomName, 'name')),
      roomTopics: strings(stateContent(state, EventType.RoomTopic, 'topic')),
      displayNames: memberNames(state),
    };
  }
}

function* memberNames(state: RoomState | undefined): Generator<string, void> {
  for (const member of state?.getMembers() ?? []) {
    // Without a display name, the SDK reports the user ID, which is redacted as an ID.
    if (member.rawDisplayName && member.rawDisplayName !== member.userId) {
      yield member.rawDisplayName;
    }
  }
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
