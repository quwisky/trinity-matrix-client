import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SESSION,
  SESSION_ENGINE,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import { EngineRequestError } from '@trinity/util/matrix';
import {
  FakeRoomListEngine,
  fakeRoom,
} from '../contract/fake-room-list-engine';
import { InvitesService } from './invites.service';
import type { RoomInfo } from './room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';

const OWNER = '@owner:example.org';

function account(accountId: string, generation = 1): SessionAccountStatus {
  return {
    accountId,
    generation,
    syncState: 'syncing',
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

interface InviteOpts {
  name: string;
  space?: boolean;
  inviterId?: string;
  inviterName?: string;
  isDirect?: boolean;
  avatarMxc?: string;
}

/** An invited row as the engine lists it; the adapter has already resolved name and avatar. */
function invited(roomId: string, opts: InviteOpts): RoomInfo {
  return fakeRoom(roomId, {
    membership: 'invite',
    displayName: opts.name,
    isSpace: opts.space ?? false,
    avatarMxc: opts.avatarMxc ?? null,
    inviter: opts.inviterId
      ? {
          userId: opts.inviterId,
          displayName: opts.inviterName ?? opts.inviterId,
          isDirect: opts.isDirect ?? false,
        }
      : null,
  });
}

/** InvitesService over the fake engine, the real RoomListStore and a fake session. */
function setup(
  rooms: readonly RoomInfo[] = [],
  others: Readonly<Record<string, readonly RoomInfo[]>> = {},
) {
  const fake = new FakeRoomListEngine();
  const alice = fake.alice;
  fake.seed(alice, rooms);
  for (const [accountId, own] of Object.entries(others)) {
    fake.seed(accountId, own);
  }
  const session = signal<SessionSnapshot>({
    ...EMPTY_SESSION,
    activeAccountId: alice,
    accounts: [alice, ...Object.keys(others)].map((id) => account(id)),
  });
  TestBed.configureTestingModule({
    providers: [
      { provide: ROOM_LIST_ENGINE, useValue: fake },
      { provide: SESSION_SNAPSHOT, useValue: session },
      {
        provide: SESSION_ENGINE,
        useFactory: () => ({ session: () => toObservable(session) }),
      },
    ],
  });
  return { svc: TestBed.inject(InvitesService), fake, session, alice };
}

describe('InvitesService', () => {
  it('projects only invite-membership rooms, sorted by name', () => {
    const { svc } = setup([
      invited('!b:hs', {
        name: 'Beta',
        inviterId: '@al:hs',
        inviterName: 'Al',
      }),
      invited('!a:hs', { name: 'Alpha' }),
      fakeRoom('!j:hs', { displayName: 'Joined' }),
    ]);

    expect(svc.pendingInvites().map((i) => i.roomId)).toEqual([
      '!a:hs',
      '!b:hs',
    ]);
    expect(svc.pendingInvites()[1]).toMatchObject({
      name: 'Beta',
      initial: 'B',
      inviterId: '@al:hs',
      inviterName: 'Al',
    });
  });

  it('marks space and direct invites and falls back when no inviter is known', () => {
    const { svc } = setup([
      invited('!s:hs', { name: 'A Space', space: true }),
      invited('!d:hs', {
        name: 'DM',
        isDirect: true,
        inviterId: '@bob:hs',
        inviterName: 'Bob',
      }),
    ]);

    const byId = Object.fromEntries(
      svc.pendingInvites().map((i) => [i.roomId, i]),
    );
    expect(byId['!s:hs']).toMatchObject({
      isSpace: true,
      inviterName: 'Someone',
      inviterId: '',
      isDirect: false,
    });
    expect(byId['!d:hs']).toMatchObject({ isDirect: true, inviterName: 'Bob' });
  });

  // Which invite shows the inviter's face is the adapter's call (its toRoomInfo table); the
  // invite row carries the avatar the room list resolved.
  it("shows the room list's avatar, the inviter's on a DM invite", () => {
    const { svc } = setup([
      invited('!d:hs', {
        name: 'DM',
        isDirect: true,
        inviterId: '@bob:hs',
        avatarMxc: 'mxc://hs/bob',
      }),
      invited('!g:hs', { name: 'Group', inviterId: '@bob:hs' }),
    ]);

    const byId = Object.fromEntries(
      svc.pendingInvites().map((i) => [i.roomId, i]),
    );
    expect(byId['!d:hs'].avatarMxc).toBe('mxc://hs/bob');
    expect(byId['!g:hs'].avatarMxc).toBeNull();
  });

  it('acceptInvite joins the room', async () => {
    const { svc, fake, alice } = setup([invited('!r:hs', { name: 'R' })]);
    const join = vi.spyOn(fake, 'join');

    await firstValueFrom(svc.acceptInvite('!r:hs'));

    expect(join).toHaveBeenCalledWith(alice, '!r:hs', []);
    expect(svc.pendingInvites()).toEqual([]);
  });

  it('declineInvite leaves the room', async () => {
    const { svc, fake, alice } = setup([invited('!r:hs', { name: 'R' })]);
    const leave = vi.spyOn(fake, 'leave');

    await firstValueFrom(svc.declineInvite('!r:hs'));

    expect(leave).toHaveBeenCalledWith(alice, '!r:hs');
    expect(svc.pendingInvites()).toEqual([]);
  });

  it('surfaces a homeserver failure to the subscriber', async () => {
    const { svc, fake } = setup([invited('!r:hs', { name: 'R' })]);

    fake.failNext('request-failed');
    await expect(
      firstValueFrom(svc.acceptInvite('!r:hs')),
    ).rejects.toBeInstanceOf(EngineRequestError);
    fake.failNext('account-not-live');
    await expect(firstValueFrom(svc.declineInvite('!r:hs'))).rejects.toThrow(
      'Not signed in.',
    );
  });

  it('refreshes live when membership changes', () => {
    const { svc, fake } = setup([invited('!a:hs', { name: 'Alpha' })]);
    expect(svc.pendingInvites().map((i) => i.roomId)).toEqual(['!a:hs']);

    // The invite is accepted elsewhere → membership flips → it drops out.
    fake.acceptInvite('!a:hs');

    expect(svc.pendingInvites()).toEqual([]);
  });

  it('acknowledges its lifetime at once and holds it', () => {
    const { svc } = setup();
    const events: unknown[] = [];

    const lifetime = svc.runProjection().subscribe({
      next: (event) => events.push(event),
    });

    expect(events).toEqual([undefined]);
    expect(lifetime.closed).toBe(false);
    lifetime.unsubscribe();
  });

  it('clears when the account leaves', () => {
    const { svc, session } = setup([invited('!a:hs', { name: 'Alpha' })]);
    expect(svc.pendingInvites().length).toBe(1);

    session.update((s) => ({ ...s, activeAccountId: null, accounts: [] }));

    expect(svc.pendingInvites()).toEqual([]);
  });

  it('follows a re-login instead of freezing', () => {
    const { svc, fake, session, alice } = setup([
      invited('!a:hs', { name: 'Alpha' }),
    ]);
    expect(svc.pendingInvites().map((i) => i.roomId)).toEqual(['!a:hs']);

    session.update((s) => ({ ...s, accounts: [] }));
    fake.seed(alice, [invited('!b:hs', { name: 'Bravo' })]);
    session.update((s) => ({ ...s, accounts: [account(alice, 2)] }));

    expect(svc.pendingInvites().map((i) => i.roomId)).toEqual(['!b:hs']);
  });

  it('re-projects onto the newly-active account when the active account switches', () => {
    const { svc, session } = setup([invited('!a:hs', { name: 'A invite' })], {
      [OWNER]: [invited('!b:hs', { name: 'B invite' })],
    });
    expect(svc.pendingInvites().map((i) => i.roomId)).toEqual(['!a:hs']);

    session.update((s) => ({ ...s, activeAccountId: OWNER }));

    expect(svc.pendingInvites().map((i) => i.roomId)).toEqual(['!b:hs']);
    expect(svc.pendingInvites()[0].accountId).toBe(OWNER);
  });
});

// A mixed-account sidebar lists invites for accounts other than the active one, so
// answering one must join/leave as the invited account — joining as the active account
// would either fail or join the wrong user to the room.
describe('InvitesService per-account answers', () => {
  function setupOwned() {
    const owned = setup([invited('!i:hs', { name: 'Mine' })], {
      [OWNER]: [invited('!i:hs', { name: 'Theirs' })],
    });
    return {
      ...owned,
      join: vi.spyOn(owned.fake, 'join'),
      leave: vi.spyOn(owned.fake, 'leave'),
    };
  }

  it('accepts on the invited account, not the active one', async () => {
    const { svc, join, alice } = setupOwned();

    await firstValueFrom(svc.acceptInvite('!i:hs', OWNER));

    expect(join).toHaveBeenCalledWith(OWNER, '!i:hs', []);
    expect(join).not.toHaveBeenCalledWith(alice, '!i:hs', []);
  });

  it('declines on the invited account', async () => {
    const { svc, leave, alice } = setupOwned();

    await firstValueFrom(svc.declineInvite('!i:hs', OWNER));

    expect(leave).toHaveBeenCalledWith(OWNER, '!i:hs');
    expect(leave).not.toHaveBeenCalledWith(alice, '!i:hs');
  });

  it('still uses the active account when none is named', async () => {
    const { svc, join, alice } = setupOwned();

    await firstValueFrom(svc.acceptInvite('!i:hs'));

    expect(join).toHaveBeenCalledWith(alice, '!i:hs', []);
  });

  it('errors rather than falling back when the invited account has no client', async () => {
    const { svc, join } = setupOwned();

    await expect(
      firstValueFrom(svc.acceptInvite('!i:hs', '@gone:hs')),
    ).rejects.toThrow('Not signed in.');
    await expect(
      firstValueFrom(svc.declineInvite('!i:hs', '@gone:hs')),
    ).rejects.toThrow('Not signed in.');
    expect(join).not.toHaveBeenCalled();
  });
});

describe('InvitesService answering an invite that may have moved on', () => {
  function owning(row: RoomInfo | null) {
    const owned = setup(row ? [row] : []);
    return { ...owned, leave: vi.spyOn(owned.fake, 'leave') };
  }

  it('declines an invite that is still pending', async () => {
    const { svc, leave, alice } = owning(invited('!r:hs', { name: 'R' }));

    await expect(
      firstValueFrom(svc.declineIfInvited('!r:hs', alice)),
    ).resolves.toBe('declined');
    expect(leave).toHaveBeenCalledExactlyOnceWith(alice, '!r:hs');
  });

  it('treats an invite already declined elsewhere as declined, without leaving again', async () => {
    const { svc, leave, alice } = owning(null);

    await expect(
      firstValueFrom(svc.declineIfInvited('!r:hs', alice)),
    ).resolves.toBe('declined');
    expect(leave).not.toHaveBeenCalled();
  });

  it('never leaves a room this account joined in the meantime', async () => {
    const { svc, leave, alice } = owning(fakeRoom('!r:hs'));

    await expect(
      firstValueFrom(svc.declineIfInvited('!r:hs', alice)),
    ).resolves.toBe('joined');
    expect(leave).not.toHaveBeenCalled();
  });

  it('re-reads the membership when subscribed, not when called', async () => {
    const { svc, fake, leave, alice } = owning(invited('!r:hs', { name: 'R' }));
    const decline = svc.declineIfInvited('!r:hs', alice);

    fake.acceptInvite('!r:hs');

    await expect(firstValueFrom(decline)).resolves.toBe('joined');
    expect(leave).not.toHaveBeenCalled();
  });

  it('refuses an account that is not live', async () => {
    const { svc } = owning(invited('!r:hs', { name: 'R' }));

    await expect(
      firstValueFrom(svc.declineIfInvited('!r:hs', '@gone:hs')),
    ).rejects.toThrow('Not signed in.');
  });

  it('says when the invite stops pending, and lets go of its watch', () => {
    const { svc, fake, alice } = owning(invited('!r:hs', { name: 'R' }));
    const settled = vi.fn();
    const watch = svc.inviteSettled('!r:hs', alice).subscribe(settled);

    TestBed.tick();
    expect(settled).not.toHaveBeenCalled();
    fake.acceptInvite('!r:hs');
    TestBed.tick();

    expect(settled).toHaveBeenCalledOnce();
    expect(watch.closed).toBe(true);
  });

  it('stays quiet for an account that is not live', () => {
    const { svc, session, alice } = owning(invited('!r:hs', { name: 'R' }));
    const settled = vi.fn();
    const watch = svc.inviteSettled('!r:hs', alice).subscribe(settled);

    session.update((s) => ({ ...s, accounts: [] }));
    TestBed.tick();

    expect(settled).not.toHaveBeenCalled();
    watch.unsubscribe();
  });
});
