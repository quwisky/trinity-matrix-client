import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RoomEvent, type MatrixClient } from 'matrix-js-sdk';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { InvitesService } from './invites.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

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
  /** The inviter's own avatar, which stands in for a DM invite's missing room avatar. */
  inviterAvatarMxc?: string;
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
    // Modelled honestly: an invite's stripped state holds just the inviter's and our own
    // membership however large the room really is, so the SDK offers the inviter as the
    // stand-in for EVERY invite — group room and space included. Only `is_direct` can
    // tell them apart, which is what this lets the specs below prove.
    getAvatarFallbackMember: () =>
      opts.inviterAvatarMxc
        ? { getMxcAvatarUrl: () => opts.inviterAvatarMxc }
        : undefined,
    getMember: (id: string) => members[id] ?? null,
  };
}

/**
 * The fakes here implement only the slice of MatrixClient InvitesService touches, so the
 * widening cast lives at this one visible seam rather than implicitly at every stub site.
 */
const asClient = (fake: object): MatrixClient =>
  fake as unknown as MatrixClient;

const activeUserId = signal<string | null>(null);

function setup(rooms: ReturnType<typeof fakeRoom>[]) {
  activeUserId.set(null);
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
        // Writable, so a test can drive an account switch — the projection re-wires off
        // this signal, and a read-only one would make that untestable.
        activeUserId: activeUserId.asReadonly(),
      }),
    ],
  });
  const matrix = TestBed.inject(MatrixClientService);
  // `isInitialized` and `instance` are getters on the real service; stub the
  // mocked members so the service reads our fake client.
  ngMocks.stubMember(matrix, 'isInitialized', true);
  ngMocks.stubMember(matrix, 'instance', asClient(client));
  const svc = TestBed.inject(InvitesService);
  svc.connect();
  return { svc, client, matrix };
}

function handlerFor(client: { on: Mock }, event: string) {
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

  it("shows the inviter's avatar on a DM invite, and only on a DM invite", () => {
    // The DM row already names the inviter, which proves their member event — and so
    // their avatar_url — is in the stripped state we read; it was simply ignored.
    //
    // All three invites below offer the same stand-in member, because that is what the
    // SDK does with stripped state. Letting it decide would put the inviter's face on
    // the group room and the space as their icon, which is worse than the initial it
    // replaced: it claims a room looks like a person.
    const { svc } = setup([
      fakeRoom(
        {
          roomId: '!d:hs',
          name: 'DM',
          isDirect: true,
          inviterId: '@bob:hs',
          inviterName: 'Bob',
          inviterAvatarMxc: 'mxc://hs/bob',
        },
        '@me:hs',
      ),
      fakeRoom(
        {
          roomId: '!g:hs',
          name: 'Group',
          inviterId: '@bob:hs',
          inviterAvatarMxc: 'mxc://hs/bob',
        },
        '@me:hs',
      ),
      fakeRoom(
        {
          roomId: '!s:hs',
          name: 'Space',
          space: true,
          inviterId: '@bob:hs',
          inviterAvatarMxc: 'mxc://hs/bob',
        },
        '@me:hs',
      ),
    ]);

    const byId = Object.fromEntries(
      svc.pendingInvites().map((i) => [i.roomId, i]),
    );
    expect(byId['!d:hs'].avatarMxc).toBe('mxc://hs/bob');
    expect(byId['!g:hs'].avatarMxc).toBeNull();
    expect(byId['!s:hs'].avatarMxc).toBeNull();
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
    ngMocks.stubMember(matrix, 'instance', asClient(clientB));
    svc.connect();

    expect(svc.pendingInvites().map((i) => i.roomId)).toEqual(['!b:hs']);
    expect(clientA.off).toHaveBeenCalled();
    expect(clientB.on).toHaveBeenCalled();
  });

  it('re-projects onto the newly-active account when the active account switches', () => {
    const { svc, client, matrix } = setup([
      fakeRoom({ roomId: '!a:hs', name: 'A invite' }, '@me:hs'),
    ]);
    activeUserId.set('@a:hs');
    TestBed.inject(ApplicationRef).tick(); // effect's first run: still A
    expect(svc.pendingInvites().map((i) => i.roomId)).toEqual(['!a:hs']);
    client.off.mockClear();

    const clientB = {
      getUserId: () => '@b:hs',
      getRooms: () => [
        fakeRoom({ roomId: '!b:hs', name: 'B invite' }, '@b:hs'),
      ],
      joinRoom: vi.fn().mockResolvedValue({}),
      leave: vi.fn().mockResolvedValue({}),
      on: vi.fn(),
      off: vi.fn(),
    };
    ngMocks.stubMember(matrix, 'instance', asClient(clientB));
    activeUserId.set('@b:hs');
    TestBed.inject(ApplicationRef).tick();

    expect(client.off).toHaveBeenCalled(); // detached from A
    expect(clientB.on).toHaveBeenCalled(); // attached to B
    expect(svc.pendingInvites().map((i) => i.roomId)).toEqual(['!b:hs']);
  });
});

// A mixed-account sidebar lists invites for accounts other than the active one, so
// answering one must join/leave as the invited account — joining as the active account
// would either fail or join the wrong user to the room.
describe('InvitesService per-account answers', () => {
  function setupOwned() {
    const activeClient = {
      getUserId: () => '@me:hs',
      getRooms: () => [],
      joinRoom: vi.fn().mockResolvedValue({}),
      leave: vi.fn().mockResolvedValue({}),
      on: vi.fn(),
      off: vi.fn(),
    };
    const ownerClient = {
      getUserId: () => '@owner:hs',
      getRooms: () => [],
      joinRoom: vi.fn().mockResolvedValue({}),
      leave: vi.fn().mockResolvedValue({}),
      on: vi.fn(),
      off: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [
        InvitesService,
        MockProvider(MatrixClientService, {
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          clientFor: vi.fn((id: string) =>
            id === '@owner:hs' ? (ownerClient as never) : null,
          ),
        }),
      ],
    });
    const matrix = TestBed.inject(MatrixClientService);
    ngMocks.stubMember(matrix, 'isInitialized', true);
    ngMocks.stubMember(matrix, 'instance', asClient(activeClient));
    return { svc: TestBed.inject(InvitesService), activeClient, ownerClient };
  }

  it('accepts on the invited account, not the active one', async () => {
    const { svc, activeClient, ownerClient } = setupOwned();

    await firstValueFrom(svc.acceptInvite('!i:hs', '@owner:hs'));

    expect(ownerClient.joinRoom).toHaveBeenCalledWith('!i:hs');
    expect(activeClient.joinRoom).not.toHaveBeenCalled();
  });

  it('declines on the invited account', async () => {
    const { svc, activeClient, ownerClient } = setupOwned();

    await firstValueFrom(svc.declineInvite('!i:hs', '@owner:hs'));

    expect(ownerClient.leave).toHaveBeenCalledWith('!i:hs');
    expect(activeClient.leave).not.toHaveBeenCalled();
  });

  it('still uses the active account when none is named', async () => {
    const { svc, activeClient } = setupOwned();

    await firstValueFrom(svc.acceptInvite('!i:hs'));

    expect(activeClient.joinRoom).toHaveBeenCalledWith('!i:hs');
  });

  it('errors rather than falling back when the invited account has no client', async () => {
    const { svc, activeClient } = setupOwned();

    await expect(
      firstValueFrom(svc.acceptInvite('!i:hs', '@gone:hs')),
    ).rejects.toThrow('Not signed in.');
    expect(activeClient.joinRoom).not.toHaveBeenCalled();
  });
});
