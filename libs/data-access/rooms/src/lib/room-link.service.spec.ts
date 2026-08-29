import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MatrixError } from '@trinity/util/matrix';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  describeRoomLinkPreviewFailure,
  roomLinkAction,
  RoomLinkService,
  type RoomLinkPreview,
} from './room-link.service';

function state(joinRule = 'invite', topic = 'Local topic') {
  return {
    getStateEvents: (type: string) => ({
      getContent: () =>
        type === 'm.room.join_rules' ? { join_rule: joinRule } : { topic },
    }),
  };
}

function localRoom(options: {
  id?: string;
  membership?: string;
  alias?: string | null;
  altAliases?: string[];
  joinRule?: string;
}) {
  return {
    roomId: options.id ?? '!local:hs',
    name: 'Local room',
    getMyMembership: () => options.membership ?? 'join',
    getCanonicalAlias: () => options.alias ?? '#local:hs',
    getAltAliases: () => options.altAliases ?? [],
    getMxcAvatarUrl: () => 'mxc://hs/local',
    getJoinedMemberCount: () => 7,
    hasEncryptionStateEvent: () => true,
    isSpaceRoom: () => false,
    getLiveTimeline: () => ({
      getState: () => state(options.joinRule),
    }),
  };
}

function setup(options: {
  rooms?: ReturnType<typeof localRoom>[];
  summary?: Record<string, unknown>;
}) {
  const rooms = options.rooms ?? [];
  const getRoomSummary = vi.fn().mockResolvedValue(
    options.summary ?? {
      room_id: '!remote:remote',
      name: 'Remote room',
      topic: 'Remote topic',
      avatar_url: 'mxc://remote/avatar',
      num_joined_members: 42,
      join_rule: 'public',
      membership: 'leave',
      canonical_alias: '#remote:remote',
      'im.nheko.summary.encryption': 'm.megolm.v1.aes-sha2',
      world_readable: false,
      guest_can_join: false,
    },
  );
  const joinRoom = vi.fn().mockResolvedValue({ roomId: '!remote:remote' });
  const knockRoom = vi.fn().mockResolvedValue({ room_id: '!remote:remote' });
  const client = {
    getRoom: (id: string) => rooms.find((room) => room.roomId === id) ?? null,
    getRooms: () => rooms,
    getRoomSummary,
    joinRoom,
    knockRoom,
  };
  TestBed.configureTestingModule({
    providers: [
      RoomLinkService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: client as never,
      }),
    ],
  });
  return {
    service: TestBed.inject(RoomLinkService),
    getRoomSummary,
    joinRoom,
    knockRoom,
  };
}

function preview(overrides: Partial<RoomLinkPreview> = {}): RoomLinkPreview {
  return {
    roomId: '!room:hs',
    requestedAddress: '!room:hs',
    canonicalAddress: null,
    name: 'Room',
    initial: 'R',
    topic: null,
    avatarMxc: null,
    memberCount: null,
    encrypted: null,
    joinRule: 'public',
    membership: 'leave',
    action: 'join',
    isSpace: false,
    via: [],
    ...overrides,
  };
}

describe('roomLinkAction', () => {
  it.each([
    ['join', 'invite', 'open'],
    ['invite', 'invite', 'accept'],
    ['leave', 'public', 'join'],
    ['unknown', 'knock', 'knock'],
    ['knock', 'knock', 'none'],
    ['ban', 'public', 'none'],
    ['leave', 'restricted', 'none'],
    ['leave', 'invite', 'none'],
    ['leave', 'unknown', 'none'],
  ] as const)('maps %s + %s to %s', (membership, rule, action) => {
    expect(roomLinkAction(membership, rule)).toBe(action);
  });
});

describe('RoomLinkService', () => {
  it('projects a joined room locally without contacting the summary endpoint', async () => {
    const room = localRoom({ membership: 'join', joinRule: 'invite' });
    const { service, getRoomSummary } = setup({ rooms: [room] });

    const preview = await firstValueFrom(
      service.preview({ kind: 'room', roomIdOrAlias: room.roomId }),
    );

    expect(preview).toMatchObject({
      roomId: '!local:hs',
      name: 'Local room',
      topic: 'Local topic',
      canonicalAddress: '#local:hs',
      memberCount: 7,
      encrypted: true,
      joinRule: 'invite',
      membership: 'join',
      action: 'open',
    });
    expect(getRoomSummary).not.toHaveBeenCalled();
  });

  it('finds a local invite by alias and maps it to Accept', async () => {
    const room = localRoom({
      membership: 'invite',
      alias: '#invited:hs',
    });
    const { service, getRoomSummary } = setup({ rooms: [room] });

    const preview = await firstValueFrom(
      service.preview({ kind: 'room', roomIdOrAlias: '#invited:hs' }),
    );

    expect(preview).toMatchObject({
      roomId: '!local:hs',
      requestedAddress: '#invited:hs',
      membership: 'invite',
      action: 'accept',
    });
    expect(getRoomSummary).not.toHaveBeenCalled();
  });

  it('resolves an unknown federated room with via hints and maps every field', async () => {
    const { service, getRoomSummary } = setup({});

    const preview = await firstValueFrom(
      service.preview({
        kind: 'room',
        roomIdOrAlias: '!remote:remote',
        via: ['remote.example'],
      }),
    );

    expect(getRoomSummary).toHaveBeenCalledWith('!remote:remote', [
      'remote.example',
    ]);
    expect(preview).toEqual({
      roomId: '!remote:remote',
      requestedAddress: null,
      canonicalAddress: '#remote:remote',
      name: 'Remote room',
      initial: 'R',
      topic: 'Remote topic',
      avatarMxc: 'mxc://remote/avatar',
      memberCount: 42,
      encrypted: true,
      joinRule: 'public',
      membership: 'leave',
      action: 'join',
      isSpace: false,
      via: ['remote.example'],
    });
  });

  it('degrades missing optional remote fields without claiming the requested alias is canonical', async () => {
    const { service } = setup({
      summary: {
        room_id: '!plain:hs',
        num_joined_members: 0,
        world_readable: false,
        guest_can_join: false,
      },
    });

    const preview = await firstValueFrom(
      service.preview({ kind: 'room', roomIdOrAlias: '#maybe:hs' }),
    );

    expect(preview).toMatchObject({
      roomId: '!plain:hs',
      requestedAddress: '#maybe:hs',
      canonicalAddress: null,
      name: '!plain:hs',
      topic: null,
      avatarMxc: null,
      memberCount: 0,
      encrypted: null,
      joinRule: 'unknown',
      membership: 'unknown',
      action: 'none',
    });
  });

  it('keeps join and knock cold and forwards via only on subscription', async () => {
    const { service, joinRoom, knockRoom } = setup({});
    const linkedRoom = preview({
      roomId: '!remote:remote',
      via: ['a.example', 'b.example'],
    });

    const join = service.join(linkedRoom);
    const knock = service.knock(linkedRoom);
    expect(joinRoom).not.toHaveBeenCalled();
    expect(knockRoom).not.toHaveBeenCalled();

    await firstValueFrom(join);
    await firstValueFrom(knock);
    expect(joinRoom).toHaveBeenCalledWith('!remote:remote', {
      viaServers: ['a.example', 'b.example'],
    });
    expect(knockRoom).toHaveBeenCalledWith('!remote:remote', {
      viaServers: ['a.example', 'b.example'],
    });
  });
});

describe('describeRoomLinkPreviewFailure', () => {
  it('distinguishes unknown, forbidden, and retryable server failures', () => {
    expect(
      describeRoomLinkPreviewFailure(
        new MatrixError({ errcode: 'M_NOT_FOUND' }, 404),
      ),
    ).toMatchObject({ title: 'Room not found', retryable: false });
    expect(
      describeRoomLinkPreviewFailure(
        new MatrixError({ errcode: 'M_FORBIDDEN' }, 403),
      ),
    ).toMatchObject({ title: 'Room unavailable', retryable: false });
    expect(
      describeRoomLinkPreviewFailure(
        new MatrixError({ errcode: 'M_UNKNOWN' }, 503),
      ),
    ).toMatchObject({ title: 'Homeserver unavailable', retryable: true });
  });
});
