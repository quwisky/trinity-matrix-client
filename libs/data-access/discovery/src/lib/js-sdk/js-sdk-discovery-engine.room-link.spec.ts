import { Injector } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { MatrixError } from 'matrix-js-sdk';
import { JsSdkDiscoveryEngine } from './js-sdk-discovery-engine';

const ME = '@me:hs';

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
  stateEncrypted?: boolean;
}) {
  return {
    roomId: options.id ?? '!local:hs',
    name: 'Local room',
    getMyMembership: () => options.membership ?? 'join',
    getCanonicalAlias: () => options.alias ?? '#local:hs',
    getAltAliases: () => options.altAliases ?? [],
    getMxcAvatarUrl: () => 'mxc://hs/local',
    getJoinedMemberCount: () => 7,
    hasEncryptionStateEvent: () => options.stateEncrypted ?? true,
    isSpaceRoom: () => false,
    getLiveTimeline: () => ({
      getState: () => state(options.joinRule),
    }),
  };
}

function setup(options: {
  rooms?: ReturnType<typeof localRoom>[];
  summary?: Record<string, unknown>;
  stableError?: unknown;
  alias?: { room_id: string; servers: string[] };
  storeEncrypted?: boolean;
  storeFails?: boolean;
}) {
  const rooms = options.rooms ?? [];
  const summary =
    options.summary ??
    ({
      room_id: '!remote:remote',
      name: 'Remote room',
      topic: 'Remote topic',
      avatar_url: 'mxc://remote/avatar',
      num_joined_members: 42,
      join_rule: 'public',
      membership: 'leave',
      canonical_alias: '#remote:remote',
      encryption: 'm.megolm.v1.aes-sha2',
      world_readable: false,
      guest_can_join: false,
    } satisfies Record<string, unknown>);
  const authedRequest = options.stableError
    ? vi.fn().mockRejectedValue(options.stableError)
    : vi.fn().mockResolvedValue(summary);
  const getRoomSummary = vi.fn().mockResolvedValue(summary);
  const getRoomIdForAlias = vi.fn().mockResolvedValue(
    options.alias ?? {
      room_id: String(summary['room_id'] ?? '!remote:remote'),
      servers: ['remote'],
    },
  );
  const joinRoom = vi.fn().mockResolvedValue({ roomId: '!remote:remote' });
  const knockRoom = vi.fn().mockResolvedValue({ room_id: '!remote:remote' });
  const client = {
    getUserId: () => ME,
    getRoom: (id: string) => rooms.find((room) => room.roomId === id) ?? null,
    getRooms: () => rooms,
    getRoomIdForAlias,
    getRoomSummary,
    http: { authedRequest },
    getCrypto: () => ({
      isEncryptionEnabledInRoom: () =>
        options.storeFails
          ? Promise.reject(new Error('store unavailable'))
          : Promise.resolve(options.storeEncrypted ?? false),
    }),
    joinRoom,
    knockRoom,
  };
  const clientFor = vi.fn((accountId: string) =>
    accountId === ME ? (client as never) : null,
  );
  const engine = Injector.create({
    providers: [
      { provide: JS_SDK_CLIENTS, useValue: { clientFor } },
      JsSdkDiscoveryEngine,
    ],
  }).get(JsSdkDiscoveryEngine);
  const preview = async (roomIdOrAlias: string, via: string[] = []) => {
    const result = await firstValueFrom(
      engine.previewRoom(ME, roomIdOrAlias, via),
    );
    if (!result.ok) throw new Error(result.failure.code);
    return result.value;
  };
  return {
    engine,
    preview,
    getRoomSummary,
    getRoomIdForAlias,
    authedRequest,
    joinRoom,
    knockRoom,
    clientFor,
  };
}

describe('JsSdkDiscoveryEngine room links', () => {
  it('projects a joined room locally without contacting the summary endpoint', async () => {
    const room = localRoom({ membership: 'join', joinRule: 'invite' });
    const { preview, getRoomSummary, authedRequest } = setup({
      rooms: [room],
    });

    await expect(preview(room.roomId, ['given'])).resolves.toEqual({
      roomId: '!local:hs',
      canonicalAddress: '#local:hs',
      name: 'Local room',
      topic: 'Local topic',
      avatarMxc: 'mxc://hs/local',
      memberCount: 7,
      encrypted: true,
      joinRule: 'invite',
      membership: 'join',
      isSpace: false,
      via: ['given'],
      restrictedEligible: false,
    });
    expect(getRoomSummary).not.toHaveBeenCalled();
    expect(authedRequest).not.toHaveBeenCalled();
  });

  it('says a joined room is encrypted when only its crypto store knows it', async () => {
    const room = localRoom({ membership: 'join', stateEncrypted: false });
    const { preview } = setup({ rooms: [room], storeEncrypted: true });

    expect((await preview(room.roomId)).encrypted).toBe(true);
  });

  it('says a joined room is encrypted when its crypto store fails to answer', async () => {
    const room = localRoom({ membership: 'join', stateEncrypted: false });
    const { preview } = setup({ rooms: [room], storeFails: true });

    expect((await preview(room.roomId)).encrypted).toBe(true);
  });

  it('says a joined room is not encrypted when its state and crypto store agree', async () => {
    const room = localRoom({ membership: 'join', stateEncrypted: false });
    const { preview } = setup({ rooms: [room] });

    expect((await preview(room.roomId)).encrypted).toBe(false);
  });

  it('reads an invited room’s encryption from its state', async () => {
    const room = localRoom({ membership: 'invite', stateEncrypted: false });
    const { preview } = setup({ rooms: [room], storeEncrypted: true });

    expect((await preview(room.roomId)).encrypted).toBe(false);
  });

  it('finds a local invite by alternative alias', async () => {
    const room = localRoom({
      membership: 'invite',
      alias: '#invited:hs',
      altAliases: ['#alt:hs'],
    });
    const { preview, getRoomSummary, authedRequest } = setup({
      rooms: [room],
    });

    await expect(preview('#alt:hs')).resolves.toMatchObject({
      roomId: '!local:hs',
      membership: 'invite',
    });
    expect(getRoomSummary).not.toHaveBeenCalled();
    expect(authedRequest).not.toHaveBeenCalled();
  });

  it('resolves an unknown federated room with via hints and maps every field', async () => {
    const { preview, getRoomSummary, authedRequest } = setup({});

    const value = await preview('!remote:remote', ['remote.example']);

    expect(authedRequest).toHaveBeenCalledWith(
      'GET',
      '/room_summary/!remote%3Aremote',
      { via: ['remote.example'] },
      undefined,
      { prefix: '/_matrix/client/v1' },
    );
    expect(getRoomSummary).not.toHaveBeenCalled();
    expect(value).toEqual({
      roomId: '!remote:remote',
      canonicalAddress: '#remote:remote',
      name: 'Remote room',
      topic: 'Remote topic',
      avatarMxc: 'mxc://remote/avatar',
      memberCount: 42,
      encrypted: true,
      joinRule: 'public',
      membership: 'leave',
      isSpace: false,
      via: ['remote.example'],
      restrictedEligible: false,
    });
  });

  it('degrades missing optional remote fields without claiming the requested alias is canonical', async () => {
    const { preview } = setup({
      summary: {
        room_id: '!plain:hs',
        num_joined_members: 0,
        world_readable: false,
        guest_can_join: false,
      },
    });

    await expect(preview('#maybe:hs')).resolves.toMatchObject({
      roomId: '!plain:hs',
      canonicalAddress: null,
      name: '!plain:hs',
      topic: null,
      avatarMxc: null,
      memberCount: 0,
      encrypted: null,
      joinRule: 'public',
      membership: 'unknown',
    });
  });

  it('takes local membership and encryption for a room it has left', async () => {
    const room = localRoom({ membership: 'leave', stateEncrypted: true });
    const { preview } = setup({
      rooms: [room],
      summary: { room_id: '!local:hs', membership: 'join' },
    });

    await expect(preview(room.roomId)).resolves.toMatchObject({
      canonicalAddress: '#local:hs',
      membership: 'leave',
      encrypted: true,
    });
  });

  it('falls back to the legacy SDK summary only when stable v1 is unrecognized', async () => {
    const { preview, getRoomSummary } = setup({
      stableError: new MatrixError({ errcode: 'M_UNRECOGNIZED' }, 404),
    });

    await preview('!remote:remote', ['remote.example']);

    expect(getRoomSummary).toHaveBeenCalledWith('!remote:remote', [
      'remote.example',
    ]);
  });

  it('fails as request-failed with the status when the summary is refused', async () => {
    const { engine, getRoomSummary } = setup({
      stableError: new MatrixError({ errcode: 'M_NOT_FOUND' }, 404),
    });

    const result = await firstValueFrom(engine.previewRoom(ME, '!gone:hs', []));

    expect(getRoomSummary).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'request-failed', diagnostic: { httpStatus: 404 } },
    });
  });

  it('resolves aliases and carries only valid directory servers', async () => {
    const { preview, getRoomIdForAlias, authedRequest } = setup({
      alias: {
        room_id: '!resolved:remote',
        servers: ['remote.example', 'bad/path', 'hint.example'],
      },
      summary: {
        room_id: '!resolved:remote',
        name: 'Resolved alias',
        num_joined_members: 3,
      },
    });

    const value = await preview('#linked:remote', ['link.example']);

    expect(getRoomIdForAlias).toHaveBeenCalledWith('#linked:remote');
    expect(authedRequest).toHaveBeenCalledWith(
      'GET',
      '/room_summary/!resolved%3Aremote',
      { via: ['link.example', 'remote.example', 'hint.example'] },
      undefined,
      { prefix: '/_matrix/client/v1' },
    );
    expect(value).toMatchObject({
      roomId: '!resolved:remote',
      via: ['link.example', 'remote.example', 'hint.example'],
      joinRule: 'public',
    });
  });

  it('is restricted-eligible only through a joined allowed room', async () => {
    const allowed = localRoom({ id: '!space:hs', membership: 'join' });
    const summary = {
      room_id: '!restricted:hs',
      join_rule: 'restricted',
      allowed_room_ids: ['!space:hs'],
    };

    await expect(
      setup({ rooms: [allowed], summary }).preview('!restricted:hs'),
    ).resolves.toMatchObject({
      joinRule: 'restricted',
      restrictedEligible: true,
    });
    await expect(
      setup({ summary }).preview('!restricted:hs'),
    ).resolves.toMatchObject({ restrictedEligible: false });
  });

  it('keeps join and knock cold and forwards via and reason only on subscription', async () => {
    const { engine, joinRoom, knockRoom, clientFor } = setup({});
    const via = ['a.example', 'b.example'];

    const join = engine.joinRoom(ME, '!remote:remote', via);
    const knock = engine.knockRoom(ME, '!remote:remote', via, 'Hello');
    expect(clientFor).not.toHaveBeenCalled();

    await expect(firstValueFrom(join)).resolves.toEqual({
      ok: true,
      value: { roomId: '!remote:remote' },
    });
    await expect(firstValueFrom(knock)).resolves.toEqual({
      ok: true,
      value: { roomId: '!remote:remote' },
    });
    expect(joinRoom).toHaveBeenCalledWith('!remote:remote', {
      viaServers: via,
    });
    expect(knockRoom).toHaveBeenCalledWith('!remote:remote', {
      viaServers: via,
      reason: 'Hello',
    });
  });

  it('passes no options to join or knock without via or reason', async () => {
    const { engine, joinRoom, knockRoom } = setup({});

    await firstValueFrom(engine.joinRoom(ME, '#a:hs', []));
    await firstValueFrom(engine.knockRoom(ME, '#a:hs', [], null));

    expect(joinRoom).toHaveBeenCalledWith('#a:hs', undefined);
    expect(knockRoom).toHaveBeenCalledWith('#a:hs', undefined);
  });
});
