import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RoomEvent } from 'matrix-js-sdk';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { InvitesService } from './invites.service';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

interface RoomOpts {
  roomId: string;
  name: string;
  membership?: string;
  space?: boolean;
  /** The user id that invited us (becomes the member event's sender). */
  inviterId?: string;
  /** Display name of the inviter, resolved via getMember(inviterId). */
  inviterName?: string;
  /** `is_direct` on our own member (invite) event. */
  isDirect?: boolean;
}

// Minimal fakes shaped like the bits of matrix-js-sdk that InvitesService reads.
function fakeRoom(opts: RoomOpts, myUserId: string) {
  const members: Record<string, unknown> = {};
  if (opts.inviterId) {
    members[opts.inviterId] = { name: opts.inviterName ?? opts.inviterId };
  }
  // Our own member, carrying the invite event: its sender is the inviter and its
  // content carries `is_direct`.
  members[myUserId] = {
    name: myUserId,
    events: {
      member: {
        getSender: () => opts.inviterId ?? '',
        getContent: () => ({ is_direct: opts.isDirect ?? false }),
      },
    },
  };
  return {
    roomId: opts.roomId,
    name: opts.name,
    isSpaceRoom: () => opts.space ?? false,
    getMyMembership: () => opts.membership ?? 'invite',
    getMxcAvatarUrl: () => null,
    getMember: (id: string) => members[id] ?? null,
  };
}

function setup(rooms: ReturnType<typeof fakeRoom>[]) {
  const client = {
    getUserId: () => '@me:hs',
    getRooms: () => rooms,
    joinRoom: vi.fn().mockResolvedValue({}),
    leave: vi.fn().mockResolvedValue({}),
    on: vi.fn(),
    off: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      InvitesService,
      MockProvider(MatrixClientService, {
        activeUserId: signal<string | null>(null).asReadonly(),
      }),
    ],
  });
  const matrix = TestBed.inject(MatrixClientService);
  // `isInitialized` and `instance` are getters on the real service; stub the
  // mocked members so the service reads our fake client.
  ngMocks.stubMember(matrix, 'isInitialized', true);
  ngMocks.stubMember(matrix, 'instance', client);
  const svc = TestBed.inject(InvitesService);
  svc.connect();
  return { svc, client, matrix };
}

function handlerFor(client: { on: ReturnType<typeof vi.fn> }, event: string) {
  const call = client.on.mock.calls.find(([e]) => e === event);
  return call?.[1] as ((...args: unknown[]) => void) | undefined;
}

describe('InvitesService', () => {
  it('projects only invite-membership rooms, sorted by name', () => {
    const { svc } = setup([
      fakeRoom(
        {
          roomId: '!b:hs',
          name: 'Beta',
          inviterId: '@al:hs',
          inviterName: 'Al',
        },
        '@me:hs',
      ),
      fakeRoom({ roomId: '!a:hs', name: 'Alpha' }, '@me:hs'),
      fakeRoom(
        { roomId: '!j:hs', name: 'Joined', membership: 'join' },
        '@me:hs',
      ),
    ]);

    expect(svc.pendingInvites().map((i) => i.roomId)).toEqual([
      '!a:hs',
      '!b:hs',
    ]);
    expect(svc.pendingInvites()[1]).toMatchObject({
      name: 'Beta',
      initial: 'B',
      inviterName: 'Al',
    });
  });

  it('marks space and direct invites and falls back when no inviter is known', () => {
    const { svc } = setup([
      fakeRoom({ roomId: '!s:hs', name: 'A Space', space: true }, '@me:hs'),
      fakeRoom(
        {
          roomId: '!d:hs',
          name: 'DM',
          isDirect: true,
          inviterId: '@bob:hs',
          inviterName: 'Bob',
        },
        '@me:hs',
      ),
    ]);

    const byId = Object.fromEntries(
      svc.pendingInvites().map((i) => [i.roomId, i]),
    );
    expect(byId['!s:hs']).toMatchObject({
      isSpace: true,
      inviterName: 'Someone',
    });
    expect(byId['!d:hs']).toMatchObject({ isDirect: true, inviterName: 'Bob' });
  });

  it('acceptInvite joins the room', async () => {
    const { svc, client } = setup([]);

    await firstValueFrom(svc.acceptInvite('!r:hs'));

    expect(client.joinRoom).toHaveBeenCalledWith('!r:hs');
  });

  it('declineInvite leaves the room', async () => {
    const { svc, client } = setup([]);

    await firstValueFrom(svc.declineInvite('!r:hs'));

    expect(client.leave).toHaveBeenCalledWith('!r:hs');
  });

  it('refreshes live when membership changes (RoomEvent.MyMembership)', async () => {
    const rooms = [fakeRoom({ roomId: '!a:hs', name: 'Alpha' }, '@me:hs')];
    const { svc, client } = setup(rooms);
    expect(svc.pendingInvites().map((i) => i.roomId)).toEqual(['!a:hs']);

    // The invite is accepted elsewhere → membership flips → it drops out.
    rooms[0] = fakeRoom(
      { roomId: '!a:hs', name: 'Alpha', membership: 'join' },
      '@me:hs',
    );
    handlerFor(client, RoomEvent.MyMembership)?.();
    await Promise.resolve(); // the refresh is coalesced into a microtask

    expect(svc.pendingInvites()).toEqual([]);
  });

  it('detaches listeners and clears the model on disconnect', () => {
    const { svc, client } = setup([
      fakeRoom({ roomId: '!a:hs', name: 'Alpha' }, '@me:hs'),
    ]);
    expect(svc.pendingInvites().length).toBe(1);

    svc.disconnect();

    expect(client.off).toHaveBeenCalled();
    expect(svc.pendingInvites()).toEqual([]);
  });

  it('rewires onto a new client after re-login instead of freezing', () => {
    const {
      svc,
      client: clientA,
      matrix,
    } = setup([fakeRoom({ roomId: '!a:hs', name: 'Alpha' }, '@me:hs')]);
    expect(svc.pendingInvites().map((i) => i.roomId)).toEqual(['!a:hs']);

    const clientB = {
      getUserId: () => '@me:hs',
      getRooms: () => [fakeRoom({ roomId: '!b:hs', name: 'Bravo' }, '@me:hs')],
      joinRoom: vi.fn(),
      leave: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
    ngMocks.stubMember(matrix, 'instance', clientB);
    svc.connect();

    expect(svc.pendingInvites().map((i) => i.roomId)).toEqual(['!b:hs']);
    expect(clientA.off).toHaveBeenCalled();
    expect(clientB.on).toHaveBeenCalled();
  });
});
