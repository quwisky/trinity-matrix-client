import { describe, expect, it } from 'vitest';
import type {
  AdministeredRoom,
  JsonObject,
  RoomCreatorInfo,
} from './room-administration-engine';
import { roomAdvancedInfo } from './room-advanced-info';
import { administeredRoom } from './room-administration.spec-harness';

const ROOM = '!room:hs';
const CREATED_AT = 1_700_000_000_000;

function roomOf(
  create: JsonObject | null,
  {
    creators = [{ userId: '@alice:hs', displayName: '@alice:hs' }],
    encryption = null,
    tombstone = null,
    encrypted = encryption !== null,
    originServerTs = CREATED_AT,
  }: {
    readonly creators?: readonly RoomCreatorInfo[];
    readonly encryption?: JsonObject | null;
    readonly tombstone?: JsonObject | null;
    readonly encrypted?: boolean;
    readonly originServerTs?: number | null;
  } = {},
): AdministeredRoom {
  const base = administeredRoom(ROOM, '@alice:hs');
  return {
    ...base,
    state: {
      ...base.state,
      create: create && {
        sender: '@alice:hs',
        originServerTs,
        content: create,
      },
      encryption,
      tombstone,
    },
    creators: create ? creators : [],
    encryption: encrypted ? 'encrypted' : 'unencrypted',
  };
}

describe('roomAdvancedInfo', () => {
  it('reads a version 1 room, whose create event names no version', () => {
    expect(
      roomAdvancedInfo(
        ROOM,
        roomOf(
          { creator: '@alice:hs' },
          { creators: [{ userId: '@alice:hs', displayName: 'Alice' }] },
        ),
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

  it('reads the version and the creators the engine lists', () => {
    const creators = [
      { userId: '@bob:hs', displayName: 'Bob' },
      { userId: '@carol:hs', displayName: '@carol:hs' },
    ];
    const info = roomAdvancedInfo(
      ROOM,
      roomOf({ room_version: '12' }, { creators }),
    );
    expect(info.version).toBe('12');
    expect(info.createdBy).toEqual(creators);
  });

  it('reads the predecessor and the successor', () => {
    const info = roomAdvancedInfo(
      ROOM,
      roomOf(
        {
          room_version: '10',
          predecessor: { room_id: '!old:hs', event_id: '$tomb' },
        },
        { tombstone: { replacement_room: '!new:hs', body: 'Moved' } },
      ),
    );
    expect(info.predecessor).toEqual({ roomId: '!old:hs', eventId: '$tomb' });
    expect(info.successor).toBe('!new:hs');
  });

  it('reads a predecessor without an event ID', () => {
    const info = roomAdvancedInfo(
      ROOM,
      roomOf({ room_version: '11', predecessor: { room_id: '!old:hs' } }),
    );
    expect(info.predecessor).toEqual({ roomId: '!old:hs', eventId: null });
  });

  it('reports encryption on and off', () => {
    expect(
      roomAdvancedInfo(
        ROOM,
        roomOf(
          { room_version: '10' },
          { encryption: { algorithm: 'm.megolm.v1.aes-sha2' } },
        ),
      ),
    ).toMatchObject({ encrypted: true, encryption: 'm.megolm.v1.aes-sha2' });
    expect(
      roomAdvancedInfo(ROOM, roomOf({ room_version: '10' })),
    ).toMatchObject({ encrypted: false, encryption: null });
  });

  it('keeps an encrypted room encrypted when the algorithm is redacted', () => {
    const info = roomAdvancedInfo(
      ROOM,
      roomOf({ room_version: '10' }, { encryption: {} }),
    );
    expect(info).toMatchObject({ encrypted: true, encryption: null });
  });

  it('reports encryption the crypto store knows of without state', () => {
    expect(
      roomAdvancedInfo(
        ROOM,
        roomOf({ room_version: '10' }, { encrypted: true }),
      ),
    ).toMatchObject({ encrypted: true, encryption: null });
  });

  it('reports encryption off while it is unknown', () => {
    expect(
      roomAdvancedInfo(ROOM, {
        ...roomOf({ room_version: '10' }),
        encryption: 'unknown',
      }).encrypted,
    ).toBe(false);
  });

  it('treats a timestamp beyond the Date range as unknown', () => {
    const info = roomAdvancedInfo(
      ROOM,
      roomOf({ room_version: '10' }, { originServerTs: 9e15 }),
    );
    expect(info.createdAt).toBeNull();
  });

  it('reports a room closed to federation', () => {
    const info = roomAdvancedInfo(
      ROOM,
      roomOf({ room_version: '10', 'm.federate': false }),
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
    expect(roomAdvancedInfo(ROOM, roomOf(null))).toEqual(unknown);
    expect(roomAdvancedInfo(ROOM, null)).toEqual(unknown);
  });

  it('ignores malformed state instead of throwing or guessing', () => {
    const info = roomAdvancedInfo(
      ROOM,
      roomOf(
        { room_version: 10, predecessor: '!old:hs', 'm.federate': 'no' },
        {
          tombstone: { replacement_room: '' },
          encryption: { algorithm: 5 },
        },
      ),
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
