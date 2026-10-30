import {
  EventTimeline,
  EventType,
  type Direction,
  type MatrixClient,
} from 'matrix-js-sdk';
import { describe, expect, it } from 'vitest';
import { assertPlainData } from '@trinity/util/matrix';
import { accountKnownNames } from './known-names';

interface FakeMember {
  readonly userId: string;
  readonly rawDisplayName: string;
  readonly membership: string;
}

interface FakeRoom {
  readonly name?: unknown;
  readonly topic?: unknown;
  readonly members: readonly FakeMember[];
}

/** A client whose rooms answer the state reads `accountKnownNames` makes. */
function fakeClient(
  rooms: readonly FakeRoom[],
  own: { userId: string; displayName?: string } | null = null,
) {
  const content = (value: Record<string, unknown> | null) =>
    value ? { getContent: () => value } : null;
  const getRooms = () =>
    rooms.map((room) => {
      const state = {
        getStateEvents: (type: string, stateKey: string) => {
          expect(stateKey).toBe('');
          if (type === EventType.RoomName) {
            return content(
              room.name === undefined ? null : { name: room.name },
            );
          }
          if (type === EventType.RoomTopic) {
            return content(
              room.topic === undefined ? null : { topic: room.topic },
            );
          }
          return null;
        },
        getMembers: () => room.members,
      };
      return {
        // The live timeline's forward state is the room's current state.
        getLiveTimeline: () => ({
          getState: (direction: Direction) =>
            direction === EventTimeline.FORWARDS ? state : null,
        }),
      };
    });
  const client = {
    getRooms,
    getUserId: () => own?.userId ?? null,
    getUser: (userId: string) =>
      own && userId === own.userId ? { displayName: own.displayName } : null,
  } as unknown as MatrixClient;
  return { client };
}

describe('accountKnownNames', () => {
  it('reads the own name, then each room’s name, topic and members', () => {
    const { client } = fakeClient(
      [
        {
          name: 'Garden Club',
          topic: 'Roses and tulips',
          members: [
            {
              userId: '@alice:example.org',
              rawDisplayName: 'Alice Liddell',
              membership: 'join',
            },
            {
              userId: '@bob:other.net',
              rawDisplayName: 'Bob Builder',
              membership: 'invite',
            },
            {
              userId: '@carol:other.net',
              rawDisplayName: 'Carol Gone',
              membership: 'leave',
            },
            {
              userId: '@dave:other.net',
              rawDisplayName: 'Dave Banned',
              membership: 'ban',
            },
          ],
        },
        { name: 'Workshop', members: [] },
      ],
      { userId: '@alice:example.org', displayName: 'Alice L.' },
    );

    expect(accountKnownNames(client)).toEqual([
      { roomNames: [], roomTopics: [], displayNames: ['Alice L.'] },
      {
        roomNames: ['Garden Club'],
        roomTopics: ['Roses and tulips'],
        displayNames: [
          'Alice Liddell',
          'Bob Builder',
          'Carol Gone',
          'Dave Banned',
        ],
      },
      { roomNames: ['Workshop'], roomTopics: [], displayNames: [] },
    ]);
  });

  it('reads plain data', () => {
    const { client } = fakeClient([{ name: 'Plain', members: [] }]);

    expect(() => assertPlainData(accountKnownNames(client))).not.toThrow();
  });

  it('ignores members without a display name and malformed state', () => {
    const { client } = fakeClient([
      {
        name: 42,
        topic: { text: 'not a string' },
        members: [
          {
            userId: '@carol:example.org',
            rawDisplayName: '@carol:example.org',
            membership: 'join',
          },
        ],
      },
    ]);

    expect(accountKnownNames(client)).toEqual([
      { roomNames: [], roomTopics: [], displayNames: [] },
      { roomNames: [], roomTopics: [], displayNames: [] },
    ]);
  });
});
