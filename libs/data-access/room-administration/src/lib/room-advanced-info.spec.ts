import { MatrixEvent, type IEvent, type RoomState } from 'matrix-js-sdk';
import { describe, expect, it } from 'vitest';
import { roomAdvancedInfo } from './room-advanced-info';

const ROOM = '!room:hs';
const CREATED_AT = 1_700_000_000_000;

function stateOf(
  events: readonly Partial<IEvent>[],
  names: Readonly<Record<string, string>> = {},
): RoomState {
  const byType = new Map(
    events.map((raw) => [
      raw.type as string,
      new MatrixEvent({ state_key: '', room_id: ROOM, ...raw }),
    ]),
  );
  return {
    getStateEvents: (type: string) => byType.get(type) ?? null,
    getMember: (userId: string) =>
      names[userId] ? { name: names[userId] } : null,
  } as unknown as RoomState;
}

const create = (
  content: Record<string, unknown>,
  sender = '@alice:hs',
): Partial<IEvent> => ({
  type: 'm.room.create',
  sender,
  origin_server_ts: CREATED_AT,
  content,
});

describe('roomAdvancedInfo', () => {
  it('reads a version 1 room, whose create event names no version', () => {
    expect(
      roomAdvancedInfo(
        ROOM,
        stateOf([create({ creator: '@alice:hs' })], { '@alice:hs': 'Alice' }),
      ),
    ).toEqual({
      roomId: ROOM,
      version: '1',
      createdBy: [{ userId: '@alice:hs', displayName: 'Alice' }],
      createdAt: CREATED_AT,
      encrypted: false,
      encryption: null,
      federated: true,
      predecessor: null,
      successor: null,
    });
  });

  it('reads a version 10 room', () => {
    const info = roomAdvancedInfo(
      ROOM,
      stateOf([create({ room_version: '10', creator: '@alice:hs' })]),
    );
    expect(info.version).toBe('10');
    expect(info.createdBy).toEqual([
      { userId: '@alice:hs', displayName: '@alice:hs' },
    ]);
  });

  it('reads a version 11 room from the create event sender', () => {
    const info = roomAdvancedInfo(
      ROOM,
      stateOf([create({ room_version: '11' }, '@bob:hs')], {
        '@bob:hs': 'Bob',
      }),
    );
    expect(info.version).toBe('11');
    expect(info.createdBy).toEqual([{ userId: '@bob:hs', displayName: 'Bob' }]);
  });

  it('adds the additional creators of a version 12 room, once each', () => {
    const info = roomAdvancedInfo(
      ROOM,
      stateOf([
        create({
          room_version: '12',
          additional_creators: ['@carol:hs', '@alice:hs', 7],
        }),
      ]),
    );
    expect(info.createdBy.map(({ userId }) => userId)).toEqual([
      '@alice:hs',
      '@carol:hs',
    ]);
  });

  it('ignores additional creators before version 12', () => {
    const info = roomAdvancedInfo(
      ROOM,
      stateOf([
        create({ room_version: '11', additional_creators: ['@carol:hs'] }),
      ]),
    );
    expect(info.createdBy.map(({ userId }) => userId)).toEqual(['@alice:hs']);
  });

  it('reads the predecessor and the successor', () => {
    const info = roomAdvancedInfo(
      ROOM,
      stateOf([
        create({
          room_version: '10',
          predecessor: { room_id: '!old:hs', event_id: '$tomb' },
        }),
        {
          type: 'm.room.tombstone',
          sender: '@alice:hs',
          content: { replacement_room: '!new:hs', body: 'Moved' },
        },
      ]),
    );
    expect(info.predecessor).toEqual({ roomId: '!old:hs', eventId: '$tomb' });
    expect(info.successor).toBe('!new:hs');
  });

  it('reads a predecessor without an event ID', () => {
    const info = roomAdvancedInfo(
      ROOM,
      stateOf([
        create({ room_version: '11', predecessor: { room_id: '!old:hs' } }),
      ]),
    );
    expect(info.predecessor).toEqual({ roomId: '!old:hs', eventId: null });
  });

  it('reports encryption on and off', () => {
    const encrypted = stateOf([
      create({ room_version: '10' }),
      {
        type: 'm.room.encryption',
        sender: '@alice:hs',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      },
    ]);
    expect(roomAdvancedInfo(ROOM, encrypted).encryption).toBe(
      'm.megolm.v1.aes-sha2',
    );
    expect(
      roomAdvancedInfo(ROOM, stateOf([create({ room_version: '10' })]))
        .encryption,
    ).toBeNull();
  });

  it('keeps an encrypted room encrypted when the algorithm is redacted', () => {
    const info = roomAdvancedInfo(
      ROOM,
      stateOf([
        create({ room_version: '10' }),
        { type: 'm.room.encryption', sender: '@alice:hs', content: {} },
      ]),
    );
    expect(info).toMatchObject({ encrypted: true, encryption: null });
    expect(
      roomAdvancedInfo(ROOM, stateOf([create({ room_version: '10' })])),
    ).toMatchObject({ encrypted: false, encryption: null });
  });

  it('falls back to the legacy creator when the sender is empty', () => {
    const info = roomAdvancedInfo(
      ROOM,
      stateOf([create({ creator: '@bob:hs' }, '')]),
    );
    expect(info.createdBy).toEqual([
      { userId: '@bob:hs', displayName: '@bob:hs' },
    ]);
  });

  it('treats a timestamp beyond the Date range as unknown', () => {
    const info = roomAdvancedInfo(
      ROOM,
      stateOf([{ ...create({ room_version: '10' }), origin_server_ts: 9e15 }]),
    );
    expect(info.createdAt).toBeNull();
  });

  it('reports a room closed to federation', () => {
    const info = roomAdvancedInfo(
      ROOM,
      stateOf([create({ room_version: '10', 'm.federate': false })]),
    );
    expect(info.federated).toBe(false);
  });

  // Partial state shows the room ID and nothing invented.
  it('shows only the room ID when the create event is missing', () => {
    const unknown = {
      roomId: ROOM,
      version: null,
      createdBy: [],
      createdAt: null,
      encrypted: false,
      encryption: null,
      federated: null,
      predecessor: null,
      successor: null,
    };
    expect(roomAdvancedInfo(ROOM, stateOf([]))).toEqual(unknown);
    expect(roomAdvancedInfo(ROOM, undefined)).toEqual(unknown);
  });

  it('ignores malformed state instead of throwing or guessing', () => {
    const info = roomAdvancedInfo(
      ROOM,
      stateOf([
        create({
          room_version: 10,
          predecessor: '!old:hs',
          'm.federate': 'no',
        }),
        {
          type: 'm.room.tombstone',
          sender: '@alice:hs',
          content: { replacement_room: '' },
        },
        {
          type: 'm.room.encryption',
          sender: '@alice:hs',
          content: { algorithm: 5 },
        },
      ]),
    );
    expect(info).toMatchObject({
      version: null,
      federated: true,
      predecessor: null,
      successor: null,
      encryption: null,
    });
  });
});
