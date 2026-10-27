import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { MockProvider } from 'ng-mocks';
import { NEVER, Subject, concat, firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SESSION,
  SESSION_ENGINE,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import { PrivacySettingsService } from '@trinity/platform-native';
import {
  EngineRequestError,
  engineOk,
  type EngineResult,
} from '@trinity/util/matrix';
import {
  FakeRoomListEngine,
  fakeRoom,
} from '../contract/fake-room-list-engine';
import { InviteBlockedError, RoomLibraryService } from './room-library.service';
import { ROOM_LIBRARY_GOVERNANCE_POLICY } from './room-library-governance-policy';
import type { RoomInfo } from './room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';

const OTHER = '@other:example.org';

function account(accountId: string): SessionAccountStatus {
  return {
    accountId,
    generation: 1,
    syncState: 'syncing',
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

interface Setup {
  /** The active account's rooms. */
  rooms?: readonly RoomInfo[];
  /** Further live accounts and their rooms. */
  others?: Readonly<Record<string, readonly RoomInfo[]>>;
  /** The active account's `m.direct` map. */
  direct?: Readonly<Record<string, readonly string[]>>;
  sendReadReceipts?: boolean;
}

/** RoomLibraryService over the fake engine, the real RoomListStore and a fake session. */
function setup(options: Setup = {}) {
  const fake = new FakeRoomListEngine();
  const alice = fake.alice;
  fake.seed(alice, options.rooms ?? []);
  for (const [accountId, rooms] of Object.entries(options.others ?? {})) {
    fake.seed(accountId, rooms);
  }
  const { direct } = options;
  if (direct) {
    const directMap = fake.directMap.bind(fake);
    fake.directMap = (accountId) =>
      accountId === alice ? concat(of(direct), NEVER) : directMap(accountId);
  }
  const session = signal<SessionSnapshot>({
    ...EMPTY_SESSION,
    activeAccountId: alice,
    accounts: [alice, ...Object.keys(options.others ?? {})].map(account),
  });
  TestBed.configureTestingModule({
    providers: [
      { provide: ROOM_LIST_ENGINE, useValue: fake },
      { provide: SESSION_SNAPSHOT, useValue: session },
      {
        provide: SESSION_ENGINE,
        useFactory: () => ({ session: () => toObservable(session) }),
      },
      {
        provide: ROOM_LIBRARY_GOVERNANCE_POLICY,
        useValue: { authorize: vi.fn(() => ({ kind: 'allowed' as const })) },
      },
      MockProvider(PrivacySettingsService, {
        sendReadReceipts: signal(options.sendReadReceipts ?? true).asReadonly(),
      }),
    ],
  });
  return { svc: TestBed.inject(RoomLibraryService), fake, session, alice };
}

/** A command reply the test releases by hand, for state while a write is in flight. */
function held(): Subject<EngineResult<null>> {
  return new Subject<EngineResult<null>>();
}

const ok = engineOk(null);

describe('RoomLibraryService', () => {
  it('excludes spaces and non-joined rooms from the channel list', () => {
    const { svc } = setup({
      rooms: [
        fakeRoom('!s:hs', { isSpace: true }),
        fakeRoom('!a:hs'),
        fakeRoom('!i:hs', { membership: 'invite' }),
        fakeRoom('!k:hs', { membership: 'knock' }),
      ],
    });

    // Spaces live in the rail (SpacesService); invites and knocks are not channels.
    expect(svc.rooms().map((r) => r.id)).toEqual(['!a:hs']);
  });

  it('builds each row from the room list of the active account', () => {
    const { svc, alice } = setup({
      rooms: [
        fakeRoom('!dm:hs', {
          displayName: '#Bob',
          directUserId: '@bob:hs',
          avatarMxc: 'mxc://hs/bob',
          topic: 'chat',
          joinedMemberCount: 2,
          encryption: 'encrypted',
          notificationCount: 2,
          highlightCount: 1,
          recencyStamp: 20,
          latestMessage: { text: 'hi', mark: 'unencrypted' },
        }),
        fakeRoom('!plain:hs', { encryption: 'unknown', recencyStamp: 10 }),
      ],
    });

    const [dm, plain] = svc.rooms();
    expect(dm).toEqual({
      id: '!dm:hs',
      accountId: alice,
      accountIds: [alice],
      name: '#Bob',
      initial: 'B',
      avatarMxc: 'mxc://hs/bob',
      topic: 'chat',
      memberCount: 2,
      encrypted: true,
      unreadCount: 2,
      highlightCount: 1,
      hasUnread: true,
      markedUnread: false,
      lastMessage: 'hi',
      lastMessageMark: 'unencrypted',
      activityTs: 20,
      favourite: false,
      lowPriority: false,
      directUserId: '@bob:hs',
    });
    // No direct user, no preview, and an unanswered encryption state read as unencrypted.
    expect(plain).toMatchObject({
      encrypted: false,
      lastMessage: '',
      lastMessageMark: null,
      hasUnread: false,
    });
    expect(plain.directUserId).toBeUndefined();
  });

  describe('per-sync identity (#1292)', () => {
    const rows = [
      fakeRoom('!a:hs', { displayName: 'A' }),
      fakeRoom('!b:hs', { displayName: 'B' }),
    ];
    const byId = (svc: RoomLibraryService, id: string) =>
      svc.rooms().find((r) => r.id === id);

    it('keeps the same list when a sync changes no room', () => {
      const { svc, fake, alice } = setup({ rooms: rows });
      const before = svc.rooms();

      fake.seed(
        alice,
        rows.map((row) => ({ ...row })),
      );

      // Every sidebar row and every computed over the list would otherwise redo its work.
      expect(svc.rooms()).toBe(before);
    });

    it('replaces only the summary of the room a sync changed', () => {
      const { svc, fake, alice } = setup({ rooms: rows });
      const a = byId(svc, '!a:hs');
      const b = byId(svc, '!b:hs');

      fake.seed(alice, [{ ...rows[0], notificationCount: 2 }, { ...rows[1] }]);

      expect(byId(svc, '!a:hs')).not.toBe(a);
      expect(byId(svc, '!a:hs')?.unreadCount).toBe(2);
      // The untouched room keeps its object, so its OnPush row skips the update.
      expect(byId(svc, '!b:hs')).toBe(b);
    });
  });

  it('orders rooms by recent activity and maps unread counts', () => {
    const { svc } = setup({
      rooms: [
        fakeRoom('!old:hs', { displayName: 'old', recencyStamp: 100 }),
        fakeRoom('!new:hs', {
          displayName: 'new',
          recencyStamp: 300,
          notificationCount: 3,
          highlightCount: 1,
        }),
        fakeRoom('!mid:hs', { displayName: 'mid', recencyStamp: 200 }),
      ],
    });

    expect(svc.rooms().map((r) => r.id)).toEqual([
      '!new:hs',
      '!mid:hs',
      '!old:hs',
    ]);
    const [newest, mid] = svc.rooms();
    expect(newest).toMatchObject({
      unreadCount: 3,
      highlightCount: 1,
      hasUnread: true,
    });
    expect(mid.hasUnread).toBe(false);
    // totalUnread is the app-wide sum of every room's unread count.
    expect(svc.totalUnread()).toBe(3);
  });

  it('recomputes totalUnread when the room list changes', () => {
    const { svc, fake, alice } = setup({
      rooms: [fakeRoom('!a:hs', { notificationCount: 2 })],
    });
    expect(svc.totalUnread()).toBe(2);

    fake.seed(alice, [
      fakeRoom('!a:hs', { notificationCount: 2 }),
      fakeRoom('!b:hs', { notificationCount: 5 }),
    ]);

    expect(svc.totalUnread()).toBe(7);
  });

  it('floats a favourite room above a more recently active non-favourite one', () => {
    const { svc } = setup({
      rooms: [
        // Most recently active, but not favourited.
        fakeRoom('!new:hs', { displayName: 'zulu', recencyStamp: 500 }),
        // Older, but favourited — favourite-first beats activityTs.
        fakeRoom('!fav:hs', {
          displayName: 'alpha',
          recencyStamp: 100,
          favourite: true,
        }),
        fakeRoom('!old:hs', { displayName: 'bravo', recencyStamp: 50 }),
      ],
    });
    expect(svc.rooms().map((r) => r.id)).toEqual([
      '!fav:hs',
      '!new:hs',
      '!old:hs',
    ]);
  });

  it('falls back to name when two favourite rooms tie on activity', () => {
    const { svc } = setup({
      rooms: [
        fakeRoom('!z:hs', { displayName: 'zulu', favourite: true }),
        fakeRoom('!a:hs', { displayName: 'alpha', favourite: true }),
      ],
    });
    expect(svc.rooms().map((r) => r.id)).toEqual(['!a:hs', '!z:hs']);
  });

  it('follows the active account when it switches', () => {
    const { svc, fake, session } = setup({
      rooms: [fakeRoom('!a:hs')],
      others: { [OTHER]: [fakeRoom('!b:hs')] },
    });
    fake.setTyping(OTHER, '!b:hs', [{ userId: '@bob:hs', displayName: 'Bob' }]);
    expect(svc.rooms().map((r) => r.id)).toEqual(['!a:hs']);
    expect(svc.typingByRoom()).toEqual({});

    session.update((s) => ({ ...s, activeAccountId: OTHER }));

    expect(svc.rooms().map((r) => r.id)).toEqual(['!b:hs']);
    expect(svc.rooms()[0].accountId).toBe(OTHER);
    expect(svc.typingByRoom()).toEqual({ '!b:hs': ['Bob'] });
  });

  it('is empty, and refuses to act, with no account signed in', async () => {
    const { svc, session } = setup({ rooms: [fakeRoom('!a:hs')] });
    session.set(EMPTY_SESSION);

    expect(svc.rooms()).toEqual([]);
    expect(svc.directRoomIds().size).toBe(0);
    await expect(firstValueFrom(svc.leave('!a:hs'))).rejects.toThrow(
      'Not signed in.',
    );
    await expect(
      firstValueFrom(svc.createRoom({ name: 'general' })),
    ).rejects.toThrow('Not signed in.');
    await expect(
      firstValueFrom(svc.resolveRoomId('#general:hs')),
    ).rejects.toThrow('Not signed in.');
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
});

describe('RoomLibraryService marked unread', () => {
  it('setMarkedUnread shows the overlay until the stream confirms', async () => {
    const { svc, fake, alice } = setup({ rooms: [fakeRoom('!r:hs')] });
    const reply = held();
    vi.spyOn(fake, 'setMarkedUnread').mockReturnValue(reply);

    const done = firstValueFrom(svc.setMarkedUnread('!r:hs', true));

    // Shown before the server confirms: the write has no local echo.
    expect(svc.rooms()[0]).toMatchObject({
      markedUnread: true,
      hasUnread: true,
    });
    reply.next(ok);
    reply.complete();
    await done;
    expect(svc.rooms()[0].markedUnread).toBe(true); // still the overlay

    // The stream confirms the flag: the server owns it again.
    fake.seed(alice, [fakeRoom('!r:hs', { markedUnread: true })]);
    expect(svc.rooms()[0].markedUnread).toBe(true);

    // Another device clears it. With the overlay dropped, the server wins.
    fake.seed(alice, [fakeRoom('!r:hs')]);
    expect(svc.rooms()[0].markedUnread).toBe(false);
  });

  it('writes the flag on the owning account', async () => {
    const { svc, fake } = setup({
      rooms: [fakeRoom('!r:hs')],
      others: { [OTHER]: [fakeRoom('!r:hs')] },
    });
    const write = vi.spyOn(fake, 'setMarkedUnread');

    await firstValueFrom(svc.setMarkedUnread('!r:hs', true, OTHER));

    expect(write).toHaveBeenCalledWith(OTHER, '!r:hs', true);
  });

  it('puts the row back when the write is rejected', async () => {
    const { svc, fake } = setup({ rooms: [fakeRoom('!r:hs')] });
    fake.failNext('request-failed');

    await expect(
      firstValueFrom(svc.setMarkedUnread('!r:hs', true)),
    ).rejects.toBeInstanceOf(EngineRequestError);

    expect(svc.rooms()[0].markedUnread).toBe(false);
  });

  it('does not erase a room’s real unread count while a write is in flight', () => {
    // Un-flagging a room that genuinely has unread messages must leave it unread —
    // the overlay speaks only for the flag, not for the notification count.
    const { svc, fake } = setup({
      rooms: [fakeRoom('!r:hs', { notificationCount: 3, markedUnread: true })],
    });
    vi.spyOn(fake, 'setMarkedUnread').mockReturnValue(held());

    svc.setMarkedUnread('!r:hs', false).subscribe();

    expect(svc.rooms()[0]).toMatchObject({
      markedUnread: false,
      unreadCount: 3,
      hasUnread: true,
    });
  });

  it('keeps two rooms’ pending writes apart', () => {
    const { svc, fake } = setup({
      rooms: [fakeRoom('!a:hs'), fakeRoom('!b:hs')],
    });
    vi.spyOn(fake, 'setMarkedUnread').mockImplementation(() => held());

    svc.setMarkedUnread('!a:hs', true).subscribe();
    svc.setMarkedUnread('!b:hs', true).subscribe();

    const byId = new Map(svc.rooms().map((r) => [r.id, r] as const));
    expect(byId.get('!a:hs')?.markedUnread).toBe(true);
    expect(byId.get('!b:hs')?.markedUnread).toBe(true);
  });

  it('refuses to flag when the owning account is not live', async () => {
    // Reporting success for a write that never happened would leave the sidebar
    // showing a flag the account does not hold.
    const { svc } = setup({ rooms: [fakeRoom('!r:hs')] });

    await expect(
      firstValueFrom(svc.setMarkedUnread('!r:hs', true, '@nobody:hs')),
    ).rejects.toThrow('Not signed in.');
    expect(svc.rooms()[0].markedUnread).toBe(false);
  });

  it('sweeps every account and writes only where the flag is set', async () => {
    // A merged mixed-account row can be flagged on either side; clearing only the
    // active account would leave it flagged with no way for the user to fix it.
    const { svc, fake } = setup({
      rooms: [fakeRoom('!r:hs')],
      others: { [OTHER]: [fakeRoom('!r:hs', { markedUnread: true })] },
    });
    const write = vi.spyOn(fake, 'setMarkedUnread');

    await firstValueFrom(svc.clearMarkedUnread('!r:hs'));

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(OTHER, '!r:hs', false);
  });

  it('clears cold', async () => {
    const { svc, fake } = setup({
      rooms: [fakeRoom('!r:hs', { markedUnread: true })],
    });
    const write = vi.spyOn(fake, 'setMarkedUnread');

    const command = svc.clearMarkedUnread('!r:hs');
    expect(write).not.toHaveBeenCalled();
    await firstValueFrom(command);

    expect(write).toHaveBeenCalledWith(fake.alice, '!r:hs', false);
  });

  it('spends no write clearing a room that is not flagged, or not held', async () => {
    // clearMarkedUnread runs on every room open, and a linked room can be open before
    // sync delivers it.
    const { svc, fake } = setup({ rooms: [fakeRoom('!r:hs')] });
    const write = vi.spyOn(fake, 'setMarkedUnread');

    await firstValueFrom(svc.clearMarkedUnread('!r:hs'));
    await expect(
      firstValueFrom(svc.clearMarkedUnread('!pending:hs')),
    ).resolves.toBeUndefined();

    expect(write).not.toHaveBeenCalled();
  });

  it('surfaces clear failures to the subscriber', async () => {
    const { svc, fake } = setup({
      rooms: [fakeRoom('!r:hs', { markedUnread: true })],
    });
    fake.failNext('request-failed');

    await expect(
      firstValueFrom(svc.clearMarkedUnread('!r:hs')),
    ).rejects.toBeInstanceOf(EngineRequestError);
  });
});

describe('RoomLibraryService markRead', () => {
  it('acks publicly by default, privately when read receipts are turned off', async () => {
    for (const [sendReadReceipts, receipts] of [
      [true, 'public'],
      [false, 'private'],
    ] as const) {
      TestBed.resetTestingModule();
      const { svc, fake, alice } = setup({
        rooms: [fakeRoom('!r:hs')],
        sendReadReceipts,
      });
      const markRead = vi.spyOn(fake, 'markRead');

      await firstValueFrom(svc.markRead('!r:hs'));

      expect(markRead).toHaveBeenCalledWith(alice, '!r:hs', receipts);
    }
  });

  it('drops the flag at once when a flagged room is marked read from its menu', () => {
    // Otherwise the two controls contradict each other: the row would be acked and
    // still flagged until the clear came back from /sync.
    const { svc, fake } = setup({
      rooms: [fakeRoom('!r:hs', { markedUnread: true })],
    });
    vi.spyOn(fake, 'markRead').mockReturnValue(held());

    svc.markRead('!r:hs').subscribe();

    expect(svc.rooms()[0]).toMatchObject({
      markedUnread: false,
      hasUnread: false,
    });
  });

  it('puts the flag back when marking read fails', async () => {
    const { svc, fake } = setup({
      rooms: [fakeRoom('!r:hs', { markedUnread: true })],
    });
    fake.failNext('request-failed');

    await expect(firstValueFrom(svc.markRead('!r:hs'))).rejects.toBeInstanceOf(
      EngineRequestError,
    );

    expect(svc.rooms()[0].markedUnread).toBe(true);
  });
});

describe('RoomLibraryService organisation', () => {
  it('writes and clears the favourite and low-priority tags', async () => {
    const { svc, fake, alice } = setup({ rooms: [fakeRoom('!a:hs')] });
    const setTag = vi.spyOn(fake, 'setTag');

    const command = svc.setFavourite('!a:hs', true);
    expect(setTag).not.toHaveBeenCalled();
    await firstValueFrom(command);
    expect(setTag).toHaveBeenLastCalledWith(alice, '!a:hs', 'favourite', true);
    expect(svc.rooms()[0].favourite).toBe(true);

    await firstValueFrom(svc.setFavourite('!a:hs', false));
    expect(setTag).toHaveBeenLastCalledWith(alice, '!a:hs', 'favourite', false);
    expect(svc.rooms()[0].favourite).toBe(false);

    await firstValueFrom(svc.setLowPriority('!a:hs', true));
    expect(setTag).toHaveBeenLastCalledWith(
      alice,
      '!a:hs',
      'lowPriority',
      true,
    );
    expect(svc.rooms()[0].lowPriority).toBe(true);

    await firstValueFrom(svc.setLowPriority('!a:hs', false));
    expect(svc.rooms()[0].lowPriority).toBe(false);
  });

  it('re-sorts on a tag change from another device', () => {
    const { svc, fake, alice } = setup({
      rooms: [
        fakeRoom('!a:hs', { recencyStamp: 2 }),
        fakeRoom('!b:hs', { recencyStamp: 1 }),
      ],
    });
    expect(svc.rooms().map((r) => r.id)).toEqual(['!a:hs', '!b:hs']);

    fake.seed(alice, [
      fakeRoom('!a:hs', { recencyStamp: 2 }),
      fakeRoom('!b:hs', { recencyStamp: 1, favourite: true }),
    ]);

    expect(svc.rooms().map((r) => r.id)).toEqual(['!b:hs', '!a:hs']);
  });

  it('reads organisation tags from the exact joined Account', () => {
    const { svc, alice } = setup({
      rooms: [fakeRoom('!i:hs', { membership: 'invite', favourite: true })],
      others: {
        [OTHER]: [fakeRoom('!r:hs', { favourite: true, lowPriority: true })],
      },
    });

    expect(svc.organisationFor(OTHER, '!r:hs')).toEqual({
      favourite: true,
      lowPriority: true,
    });
    expect(svc.organisationFor(alice, '!r:hs')).toBeNull();
    expect(svc.organisationFor(alice, '!i:hs')).toBeNull(); // not joined
    expect(svc.organisationFor('@gone:hs', '!r:hs')).toBeNull();
  });
});

// In the mixed-account view a sidebar row can belong to a signed-in account that ISN'T
// active. Every mutating action therefore takes an optional owning-account id and must act
// on THAT account — running it on the active one makes the wrong account leave a room.
describe('RoomLibraryService per-account actions', () => {
  const both = () =>
    setup({
      rooms: [fakeRoom('!r:hs')],
      others: { [OTHER]: [fakeRoom('!r:hs')] },
    });

  it('leaves on the owning account, or the active one when no owner is given', async () => {
    const { svc, fake, alice } = both();
    const leave = vi.spyOn(fake, 'leave');

    const command = svc.leave('!r:hs', OTHER);
    expect(leave).not.toHaveBeenCalled(); // cold — nothing until subscribed
    await firstValueFrom(command);
    expect(leave).toHaveBeenLastCalledWith(OTHER, '!r:hs');
    expect(svc.rooms().map((r) => r.id)).toEqual(['!r:hs']); // alice still holds it

    await firstValueFrom(svc.leave('!r:hs'));
    expect(leave).toHaveBeenLastCalledWith(alice, '!r:hs');
    expect(svc.rooms()).toEqual([]);
  });

  it('favourites and acks on the owning account', async () => {
    const { svc, fake } = both();
    const setTag = vi.spyOn(fake, 'setTag');
    const markRead = vi.spyOn(fake, 'markRead');

    await firstValueFrom(svc.setFavourite('!r:hs', true, OTHER));
    await firstValueFrom(svc.markRead('!r:hs', OTHER));

    expect(setTag).toHaveBeenCalledWith(OTHER, '!r:hs', 'favourite', true);
    expect(markRead).toHaveBeenCalledWith(OTHER, '!r:hs', 'public');
  });

  it('surfaces a homeserver failure to the subscriber', async () => {
    const { svc, fake } = both();
    fake.failNext('request-failed');

    await expect(firstValueFrom(svc.leave('!r:hs'))).rejects.toBeInstanceOf(
      EngineRequestError,
    );
  });

  // A destructive action must fail loudly rather than fall through to the active account.
  it('errors rather than falling back when the owning account is not live', async () => {
    const { svc, fake } = both();
    const leave = vi.spyOn(fake, 'leave');
    const setTag = vi.spyOn(fake, 'setTag');

    for (const command of [
      svc.leave('!r:hs', '@gone:hs'),
      svc.markRead('!r:hs', '@gone:hs'),
      svc.setFavourite('!r:hs', true, '@gone:hs'),
    ]) {
      await expect(firstValueFrom(command)).rejects.toThrow('Not signed in.');
    }
    expect(leave).not.toHaveBeenCalled();
    expect(setTag).not.toHaveBeenCalled();
  });

  it('selectionAvailability answers for a non-active live account', () => {
    const { svc } = setup({
      others: { [OTHER]: [fakeRoom('!r:hs')] },
    });

    expect(svc.selectionAvailability(OTHER, '!r:hs')).toBe('available');
    expect(svc.selectionAvailability(OTHER, '!missing:hs')).toBe('unconfirmed');
    expect(svc.selectionAvailability('@gone:hs', '!r:hs')).toBe('unavailable');
    expect(svc.selectionAvailability(OTHER, '#room:hs')).toBe('unavailable');
  });
});

describe('RoomLibraryService writes', () => {
  it('createRoom creates on the active account and resolves its id', async () => {
    const { svc, fake, alice } = setup();
    const createRoom = vi.spyOn(fake, 'createRoom');

    const roomId = await firstValueFrom(svc.createRoom({ name: 'general' }));

    expect(createRoom).toHaveBeenCalledWith(alice, {
      name: 'general',
      topic: null,
      isPublic: false,
    });
    expect(svc.rooms().map((r) => r.id)).toEqual([roomId]);
  });

  it('createRoomFor creates on the named account, and refuses one that is not live', async () => {
    const { svc, fake } = setup({ others: { [OTHER]: [] } });
    const createRoom = vi.spyOn(fake, 'createRoom');

    await firstValueFrom(
      svc.createRoomFor(OTHER, { name: 'n', topic: 't', isPublic: true }),
    );
    expect(createRoom).toHaveBeenCalledWith(OTHER, {
      name: 'n',
      topic: 't',
      isPublic: true,
    });

    await expect(
      firstValueFrom(svc.createRoomFor('@gone:hs', { name: 'n' })),
    ).rejects.toThrow('Account unavailable.');
  });

  it('resolveRoomId passes a room id through and looks an alias up', async () => {
    const { svc, fake } = setup();
    const resolveAlias = vi.spyOn(fake, 'resolveAlias');
    const alias = fake.publishAlias('!aliased:hs', 'general');

    expect(await firstValueFrom(svc.resolveRoomId('!r:hs'))).toBe('!r:hs');
    expect(resolveAlias).not.toHaveBeenCalled();
    expect(await firstValueFrom(svc.resolveRoomId(alias))).toBe('!aliased:hs');
  });

  it('createDirectMessage opens a DM, and rejects an invalid user id without creating', async () => {
    const { svc, fake } = setup();
    const createDirectMessage = vi.spyOn(fake, 'createDirectMessage');

    await expect(
      firstValueFrom(svc.createDirectMessage('not-a-mxid')),
    ).rejects.toThrow('Invalid user id: not-a-mxid');
    expect(createDirectMessage).not.toHaveBeenCalled();

    const roomId = await firstValueFrom(svc.createDirectMessage(fake.bob));
    expect(svc.rooms().find((r) => r.id === roomId)?.directUserId).toBe(
      fake.bob,
    );
  });

  it('inviteUser invites on the active account, or the exact account of a key', async () => {
    const { svc, fake, alice } = setup({
      rooms: [fakeRoom('!r:hs')],
      others: { [OTHER]: [fakeRoom('!space:hs', { isSpace: true })] },
    });
    const invite = vi.spyOn(fake, 'invite');

    await firstValueFrom(svc.inviteUser('!r:hs', fake.bob));
    await firstValueFrom(
      svc.inviteUser({ accountId: OTHER, roomId: '!space:hs' }, fake.bob),
    );

    expect(invite.mock.calls).toEqual([
      [alice, '!r:hs', fake.bob],
      [OTHER, '!space:hs', fake.bob],
    ]);
  });

  it('maps invite-blocked to InviteBlockedError', async () => {
    const { svc, fake } = setup({ rooms: [fakeRoom('!r:hs')] });
    fake.failNext('invite-blocked');

    await expect(
      firstValueFrom(svc.inviteUser('!r:hs', fake.bob)),
    ).rejects.toEqual(new InviteBlockedError(fake.bob));
  });

  it('inviteUser carries other failures as the engine describes them', async () => {
    const { svc, fake } = setup({ rooms: [fakeRoom('!r:hs')] });
    fake.failNext('request-failed');

    const error: unknown = await firstValueFrom(
      svc.inviteUser('!r:hs', fake.bob),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EngineRequestError);
    expect((error as EngineRequestError).failure.code).toBe('request-failed');
  });

  it('inviteUser rejects an invalid user id without calling invite', async () => {
    const { svc, fake } = setup({ rooms: [fakeRoom('!r:hs')] });
    const invite = vi.spyOn(fake, 'invite');

    await expect(
      firstValueFrom(svc.inviteUser('!r:hs', '@bob')),
    ).rejects.toThrow('Invalid user id: @bob');
    expect(invite).not.toHaveBeenCalled();
  });

  describe('inviteHistory', () => {
    it.each([
      ['shared', 'shared'],
      ['world_readable', 'shared'],
      ['invited', 'from-invite'],
      ['joined', 'from-join'],
    ] as const)(
      'maps an encrypted room with %s visibility to %s',
      (historyVisibility, expected) => {
        const { svc } = setup({
          rooms: [
            fakeRoom('!r:hs', { encryption: 'encrypted', historyVisibility }),
          ],
        });

        expect(svc.inviteHistory('!r:hs')).toBe(expected);
      },
    );

    it('is null for an unencrypted or unknown room', () => {
      const { svc } = setup({
        rooms: [
          fakeRoom('!plain:hs', { encryption: 'unencrypted' }),
          fakeRoom('!unknown:hs', { encryption: 'unknown' }),
        ],
      });

      expect(svc.inviteHistory('!plain:hs')).toBeNull();
      expect(svc.inviteHistory('!unknown:hs')).toBeNull();
      expect(svc.inviteHistory('!missing:hs')).toBeNull();
    });

    it('reads the exact account of a governance key', () => {
      const { svc } = setup({
        others: {
          [OTHER]: [
            fakeRoom('!r:hs', {
              encryption: 'encrypted',
              historyVisibility: 'joined',
            }),
          ],
        },
      });

      expect(svc.inviteHistory({ accountId: OTHER, roomId: '!r:hs' })).toBe(
        'from-join',
      );
      expect(svc.inviteHistory('!r:hs')).toBeNull(); // the active account lacks it
    });
  });
});

describe('RoomLibraryService directRoomIds', () => {
  it('flattens every DM room id from m.direct', () => {
    const { svc } = setup({
      direct: { '@bob:hs': ['!dm1:hs'], '@eve:hs': ['!dm2:hs', '!dm3:hs'] },
    });

    expect([...svc.directRoomIds()].sort()).toEqual([
      '!dm1:hs',
      '!dm2:hs',
      '!dm3:hs',
    ]);
  });

  it('yields an empty set when m.direct is empty', () => {
    expect(setup({ direct: {} }).svc.directRoomIds().size).toBe(0);
  });

  it('keeps left rooms in directRoomIds', async () => {
    const { svc, fake } = setup();
    const roomId = await firstValueFrom(svc.createDirectMessage(fake.bob));

    await firstValueFrom(svc.leave(roomId));

    expect(svc.rooms()).toEqual([]);
    expect(svc.directRoomIds().has(roomId)).toBe(true);
  });
});

describe('RoomLibraryService typing, per room', () => {
  const bob = { userId: '@bob:hs', displayName: 'Bob' };
  const carol = { userId: '@carol:hs', displayName: 'Carol' };

  it('names who is typing, excluding the local user', () => {
    const { svc, fake, alice } = setup({ rooms: [fakeRoom('!a:hs')] });

    fake.setTyping(alice, '!a:hs', [
      bob,
      { userId: alice, displayName: 'Alice' },
    ]);

    // Self must never appear: "You are typing" on your own room is the failure.
    expect(svc.typingByRoom()).toEqual({ '!a:hs': ['Bob'] });
  });

  it('excludes every signed-in account, not just the active one', () => {
    // A room both accounts are joined to renders as ONE row, so filtering only the active
    // mxid let the user's own other account announce itself on their own room.
    const { svc, fake, alice } = setup({
      rooms: [fakeRoom('!a:hs')],
      others: { [OTHER]: [fakeRoom('!a:hs')] },
    });

    fake.setTyping(alice, '!a:hs', [
      { userId: OTHER, displayName: 'Other Me' },
    ]);
    expect(svc.typingByRoom()['!a:hs']).toBeUndefined();

    // …and a genuine stranger still comes through, so the filter is not just off.
    fake.setTyping(alice, '!a:hs', [
      { userId: OTHER, displayName: 'Other Me' },
      bob,
    ]);
    expect(svc.typingByRoom()['!a:hs']).toEqual(['Bob']);
  });

  it('keys each room separately and drops a room that goes quiet', () => {
    const { svc, fake, alice } = setup({
      rooms: [fakeRoom('!a:hs'), fakeRoom('!b:hs')],
    });

    fake.setTyping(alice, '!a:hs', [bob]);
    fake.setTyping(alice, '!b:hs', [carol]);
    expect(svc.typingByRoom()).toEqual({
      '!a:hs': ['Bob'],
      '!b:hs': ['Carol'],
    });

    fake.setTyping(alice, '!a:hs', []);
    expect(svc.typingByRoom()).toEqual({ '!b:hs': ['Carol'] });
  });

  it('keeps the same record while the names it shows are unchanged', () => {
    const { svc, fake, alice } = setup({
      rooms: [fakeRoom('!a:hs'), fakeRoom('!b:hs')],
    });

    // Positive control FIRST, so the identity check below is not vacuous.
    fake.setTyping(alice, '!a:hs', [bob]);
    const first = svc.typingByRoom();
    expect(first['!a:hs']).toEqual(['Bob']);

    // The engine's set changed, but only by the local user: nothing to show differs.
    fake.setTyping(alice, '!a:hs', [bob, { userId: alice, displayName: 'Me' }]);
    expect(svc.typingByRoom()).toBe(first);

    // …and it still CAN change, or the assertion above is satisfied by a dead writer.
    fake.setTyping(alice, '!b:hs', [carol]);
    expect(svc.typingByRoom()).not.toBe(first);
  });

  it('clears when the account leaves', () => {
    const { svc, fake, alice, session } = setup({ rooms: [fakeRoom('!a:hs')] });
    fake.setTyping(alice, '!a:hs', [bob]);
    expect(svc.typingByRoom()).toEqual({ '!a:hs': ['Bob'] });

    session.update((s) => ({ ...s, accounts: [] }));

    expect(svc.typingByRoom()).toEqual({});
  });
});
