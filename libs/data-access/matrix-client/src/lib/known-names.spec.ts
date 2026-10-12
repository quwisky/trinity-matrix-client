import {
  EventTimeline,
  EventType,
  type Direction,
  type MatrixClient,
} from 'matrix-js-sdk';
import { describe, expect, it } from 'vitest';
import { accountKnownNames } from './known-names';

interface FakeRoom {
  readonly name?: unknown;
  readonly topic?: unknown;
  readonly members: readonly { userId: string; rawDisplayName: string }[];
}

/** A client whose rooms answer the state and member reads `accountKnownNames` makes. */
function fakeClient(
  rooms: readonly FakeRoom[],
  own: { userId: string; displayName?: string } | null = null,
): MatrixClient {
  const state = (content: Record<string, unknown> | null) =>
    content ? { getContent: () => content } : null;
  return {
    getRooms: () =>
      rooms.map((room) => {
        const getStateEvents = (type: string, stateKey: string) => {
          expect(stateKey).toBe('');
          if (type === EventType.RoomName) {
            return state(room.name === undefined ? null : { name: room.name });
          }
          if (type === EventType.RoomTopic) {
            return state(
              room.topic === undefined ? null : { topic: room.topic },
            );
          }
          return null;
        };
        return {
          // The live timeline's forward state is the room's current state.
          getLiveTimeline: () => ({
            getState: (direction: Direction) =>
              direction === EventTimeline.FORWARDS ? { getStateEvents } : null,
          }),
          getJoinedMembers: () => room.members,
        };
      }),
    getUserId: () => own?.userId ?? null,
    getUser: (userId: string) =>
      own && userId === own.userId ? { displayName: own.displayName } : null,
  } as unknown as MatrixClient;
}

describe('accountKnownNames', () => {
  it('reads room names, topics and joined members’ display names', () => {
    const client = fakeClient(
      [
        {
          name: 'Garden Club',
          topic: 'Roses and tulips',
          members: [
            { userId: '@alice:example.org', rawDisplayName: 'Alice Liddell' },
            { userId: '@bob:other.net', rawDisplayName: 'Bob Builder' },
          ],
        },
        {
          name: 'Workshop',
          members: [
            { userId: '@bob:other.net', rawDisplayName: 'Bob Builder' },
          ],
        },
      ],
      { userId: '@alice:example.org', displayName: 'Alice L.' },
    );

    expect(accountKnownNames(client)).toEqual({
      roomNames: ['Garden Club', 'Workshop'],
      roomTopics: ['Roses and tulips'],
      displayNames: ['Alice L.', 'Alice Liddell', 'Bob Builder'],
    });
  });

  it('ignores members without a display name and malformed state', () => {
    const client = fakeClient([
      {
        name: 42,
        topic: { text: 'not a string' },
        members: [
          {
            userId: '@carol:example.org',
            rawDisplayName: '@carol:example.org',
          },
        ],
      },
      { members: [] },
    ]);

    expect(accountKnownNames(client)).toEqual({
      roomNames: [],
      roomTopics: [],
      displayNames: [],
    });
  });
});
