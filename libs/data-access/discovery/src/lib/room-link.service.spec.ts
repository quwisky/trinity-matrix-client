import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { MatrixError } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { FakeDiscoveryEngine } from '../contract/fake-discovery-engine';
import { DISCOVERY_ENGINE, type RoomLinkPreviewData } from './discovery-engine';
import {
  describeRoomLinkPreviewFailure,
  roomLinkAction,
  RoomLinkService,
  type RoomLinkPreview,
} from './room-link.service';

const ME = '@me:hs';

function data(
  overrides: Partial<RoomLinkPreviewData> = {},
): RoomLinkPreviewData {
  return {
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
    via: [],
    restrictedEligible: false,
    ...overrides,
  };
}

function setup(previews: RoomLinkPreviewData[] = [data()]) {
  const engine = new FakeDiscoveryEngine();
  engine.accounts.add(ME);
  engine.previews.push(...previews);
  const active = signal<string | null>(ME);
  TestBed.configureTestingModule({
    providers: [
      RoomLinkService,
      { provide: DISCOVERY_ENGINE, useValue: engine },
      { provide: SessionStateService, useValue: { activeAccountId: active } },
    ],
  });
  return { service: TestBed.inject(RoomLinkService), engine, active };
}

function preview(overrides: Partial<RoomLinkPreview> = {}): RoomLinkPreview {
  return {
    accountId: '@me:hs',
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
    ['unknown', 'knock_restricted', 'knock'],
    ['knock', 'knock', 'none'],
    ['ban', 'public', 'none'],
    ['leave', 'restricted', 'none'],
    ['leave', 'invite', 'none'],
    ['leave', 'unknown', 'none'],
  ] as const)('maps %s + %s to %s', (membership, rule, action) => {
    expect(roomLinkAction(membership, rule)).toBe(action);
  });

  it('offers Join for restricted rules only when an allowed-room membership qualifies', () => {
    expect(roomLinkAction('leave', 'restricted', false)).toBe('none');
    expect(roomLinkAction('leave', 'restricted', true)).toBe('join');
    expect(roomLinkAction('leave', 'knock_restricted', false)).toBe('knock');
    expect(roomLinkAction('leave', 'knock_restricted', true)).toBe('join');
  });
});

describe('RoomLinkService', () => {
  it('builds the preview from the engine with the active account', async () => {
    const { service, engine } = setup();

    const result = await firstValueFrom(
      service.preview({
        kind: 'room',
        roomIdOrAlias: '!remote:remote',
        via: ['remote.example'],
      }),
    );

    expect(engine.calls).toEqual([`previewRoom:${ME}:!remote:remote`]);
    expect(result).toEqual({
      accountId: ME,
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
    } satisfies RoomLinkPreview);
  });

  it('keeps the requested alias and the resolved via', async () => {
    const { service } = setup();

    await expect(
      firstValueFrom(
        service.preview({ kind: 'room', roomIdOrAlias: '#remote:remote' }),
      ),
    ).resolves.toMatchObject({
      requestedAddress: '#remote:remote',
      via: ['remote'],
    });
  });

  it('offers actions from membership, join rule and restricted eligibility', async () => {
    const { service } = setup([
      data({ roomId: '!in:hs', membership: 'join', joinRule: 'invite' }),
      data({ roomId: '!invited:hs', membership: 'invite' }),
      data({
        roomId: '!r:hs',
        joinRule: 'restricted',
        restrictedEligible: true,
      }),
      data({ roomId: '!k:hs', joinRule: 'knock_restricted' }),
    ]);
    const action = async (roomIdOrAlias: string) =>
      (await firstValueFrom(service.preview({ kind: 'room', roomIdOrAlias })))
        .action;

    expect(await action('!in:hs')).toBe('open');
    expect(await action('!invited:hs')).toBe('accept');
    expect(await action('!r:hs')).toBe('join');
    expect(await action('!k:hs')).toBe('knock');
  });

  it('previews with the named account rather than the active one', async () => {
    const { service, engine, active } = setup();
    active.set('@other:hs');

    await expect(
      firstValueFrom(
        service.preview({ kind: 'room', roomIdOrAlias: '!remote:remote' }, ME),
      ),
    ).resolves.toMatchObject({ accountId: ME });
    expect(engine.calls).toEqual([`previewRoom:${ME}:!remote:remote`]);
  });

  it('fails as not signed in without an active account', async () => {
    const { service, active } = setup();
    active.set(null);

    await expect(
      firstValueFrom(
        service.preview({ kind: 'room', roomIdOrAlias: '!remote:remote' }),
      ),
    ).rejects.toThrow('Not signed in.');
  });

  it('maps an engine failure to the room-specific copy', async () => {
    const { service } = setup([]);

    const error = await firstValueFrom(
      service.preview({ kind: 'room', roomIdOrAlias: '!gone:hs' }),
    ).catch((e: unknown) => e);

    expect(describeRoomLinkPreviewFailure(error)).toMatchObject({
      title: 'Room not found',
      retryable: false,
    });
  });

  it('keeps join and knock cold and forwards via only on subscription', async () => {
    const { service, engine } = setup([
      data({ roomId: '!remote:remote', joinRule: 'knock' }),
    ]);
    engine.rooms.push({
      roomId: '!remote:remote',
      name: 'Remote room',
      topic: null,
      alias: null,
      avatarMxc: null,
      memberCount: 1,
      isSpace: false,
    });
    const linkedRoom = preview({
      roomId: '!remote:remote',
      via: ['a.example', 'b.example'],
    });

    const join = service.join(linkedRoom);
    const knock = service.knock(linkedRoom);
    expect(engine.calls).toEqual([]);

    await expect(firstValueFrom(join)).resolves.toBe('!remote:remote');
    await expect(firstValueFrom(knock)).resolves.toBeUndefined();
    expect(engine.calls).toEqual([
      `joinRoom:${ME}:!remote:remote:a.example,b.example`,
      `knockRoom:${ME}:!remote:remote:a.example,b.example:`,
    ]);
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
