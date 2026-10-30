import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { NEVER, Subject, finalize, firstValueFrom, tap } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_SESSION,
  SESSION_ENGINE,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import {
  FakeRoomListEngine,
  fakeRoom,
} from '../contract/fake-room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';
import { RoomsInCommonService } from './rooms-in-common.service';

const OTHER_ACCOUNT = '@alt:example.org';

function account(
  accountId: string,
  patch: Partial<SessionAccountStatus> = {},
): SessionAccountStatus {
  return {
    accountId,
    deviceId: 'DEVICE',
    generation: 1,
    syncState: 'syncing',
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
    ...patch,
  };
}

const ids = (list: readonly { id: string }[] | null) =>
  list?.map((room) => room.id) ?? null;

describe('RoomsInCommonService', () => {
  let fake: FakeRoomListEngine;
  let snapshot: ReturnType<typeof signal<SessionSnapshot>>;
  let svc: RoomsInCommonService;
  let me: string;
  let person: string;
  /** Open `roomsInCommon` subscriptions on the engine. */
  let open: number;

  const goLive = (
    accounts: SessionAccountStatus[],
    activeAccountId: string | null = me,
  ) => snapshot.set({ ...EMPTY_SESSION, activeAccountId, accounts });

  /** Seeds `rooms` for the account, each joined by the person too. */
  const shared = (
    accountId: string,
    ...rooms: ReturnType<typeof fakeRoom>[]
  ) => {
    fake.seed(accountId, rooms);
    for (const room of rooms) fake.setJoined(room.roomId, person, true);
  };

  beforeEach(() => {
    fake = new FakeRoomListEngine();
    me = fake.alice;
    person = fake.bob;
    open = 0;
    const roomsInCommon = fake.roomsInCommon.bind(fake);
    fake.roomsInCommon = (accountId, userId) =>
      roomsInCommon(accountId, userId).pipe(
        tap({ subscribe: () => (open += 1) }),
        finalize(() => (open -= 1)),
      );
    snapshot = signal(EMPTY_SESSION);
    TestBed.configureTestingModule({
      providers: [
        { provide: ROOM_LIST_ENGINE, useValue: fake },
        { provide: SESSION_SNAPSHOT, useValue: snapshot },
        { provide: SESSION_ENGINE, useValue: { session: () => NEVER } },
      ],
    });
    svc = TestBed.inject(RoomsInCommonService);
    goLive([account(me)]);
  });

  it('lists joined rooms where the person is also joined, excluding the current room', () => {
    fake.seed(me, [
      fakeRoom('!a', { displayName: 'A' }),
      fakeRoom('!b', { displayName: 'B', joinedMemberCount: 2 }),
      fakeRoom('!c', { displayName: 'C' }),
    ]);
    fake.setJoined('!a', person, true);
    fake.setJoined('!b', person, true);

    expect(svc.roomsInCommon(person, '!a')()).toEqual([
      {
        id: '!b',
        accountId: me,
        name: 'B',
        initial: 'B',
        avatarMxc: null,
        kind: 'room',
        memberCount: 2,
      },
    ]);
  });

  it('leaves out rooms this account has not joined', () => {
    shared(
      me,
      fakeRoom('!a', { membership: 'invite' }),
      fakeRoom('!b', { membership: 'knock' }),
    );

    expect(svc.roomsInCommon(person, '!x')()).toEqual([]);
  });

  it('marks direct rooms and spaces, with their avatars', () => {
    shared(
      me,
      fakeRoom('!dm', {
        displayName: 'Bob',
        directUserId: person,
        avatarMxc: 'mxc://hs/bob',
      }),
      fakeRoom('!space', { displayName: 'Space', isSpace: true }),
      fakeRoom('!room', { displayName: 'Room' }),
    );

    expect(
      svc
        .roomsInCommon(person, '!x')()
        ?.map((room) => [room.id, room.kind, room.avatarMxc]),
    ).toEqual([
      ['!dm', 'direct', 'mxc://hs/bob'],
      ['!room', 'room', null],
      ['!space', 'space', null],
    ]);
  });

  it('updates when the person leaves a shared room', () => {
    shared(me, fakeRoom('!b'));
    const common = svc.roomsInCommon(person, '!a');
    expect(ids(common())).toEqual(['!b']);

    fake.setJoined('!b', person, false);

    expect(common()).toEqual([]);
  });

  it('updates when this account leaves a shared room', async () => {
    shared(me, fakeRoom('!b'));
    const common = svc.roomsInCommon(person, '!a');
    expect(ids(common())).toEqual(['!b']);

    await firstValueFrom(fake.leave(me, '!b'));

    expect(common()).toEqual([]);
  });

  it('follows a room rename', () => {
    shared(me, fakeRoom('!b', { displayName: 'B' }));
    const common = svc.roomsInCommon(person, '!a');
    expect(common()?.[0].name).toBe('B');

    fake.seed(me, [fakeRoom('!b', { displayName: 'Renamed' })]);

    expect(common()?.[0]).toMatchObject({ name: 'Renamed', initial: 'R' });
  });

  it('is null before the rooms are prepared and after an account switch', () => {
    goLive([account(me, { roomsPrepared: false }), account(OTHER_ACCOUNT)]);
    shared(me, fakeRoom('!b'));
    const common = svc.roomsInCommon(person, '!a');

    expect(common()).toBeNull();
    goLive([account(me), account(OTHER_ACCOUNT)]);
    expect(ids(common())).toEqual(['!b']);

    goLive([account(me), account(OTHER_ACCOUNT)], OTHER_ACCOUNT);
    expect(common()).toBeNull();
  });

  it('is null until the engine first answers', () => {
    shared(me, fakeRoom('!b'));
    const answer = new Subject<readonly string[]>();
    fake.roomsInCommon = () => answer;
    const common = svc.roomsInCommon(person, '!a');

    expect(common()).toBeNull();
    answer.next(['!b']);
    expect(ids(common())).toEqual(['!b']);
  });

  it('reads the named account rather than the active one', () => {
    goLive([account(me), account(OTHER_ACCOUNT)]);
    shared(me, fakeRoom('!a'));
    shared(OTHER_ACCOUNT, fakeRoom('!b'));

    expect(
      svc
        .roomsInCommon(person, '!x', OTHER_ACCOUNT)()
        ?.map((room) => [room.id, room.accountId]),
    ).toEqual([['!b', OTHER_ACCOUNT]]);
  });

  it('is null for an account that is not live', () => {
    expect(svc.roomsInCommon(person, '!x', OTHER_ACCOUNT)()).toBeNull();
    goLive([], null);
    expect(svc.roomsInCommon(person, '!x')()).toBeNull();
    expect(open).toBe(0);
  });

  it('orders by name, case-insensitively', () => {
    shared(
      me,
      fakeRoom('!c', { displayName: 'charlie' }),
      fakeRoom('!a', { displayName: 'Alpha' }),
      fakeRoom('!b', { displayName: 'bravo' }),
    );

    expect(ids(svc.roomsInCommon(person, '!x')())).toEqual(['!a', '!b', '!c']);
  });

  it('caches the signal per user, excluded room and account', () => {
    goLive([account(me), account(OTHER_ACCOUNT)]);

    expect(svc.roomsInCommon(person, '!a')).toBe(
      svc.roomsInCommon(person, '!a'),
    );
    expect(svc.roomsInCommon(person, '!a')).not.toBe(
      svc.roomsInCommon(person, '!a', OTHER_ACCOUNT),
    );
    expect(open).toBe(2);
  });

  it('ticks accountIds and opens a fresh view when an account restarts', () => {
    const before = svc.roomsInCommon(person, '!a');
    const accountIds = svc.accountIds();
    TestBed.tick();
    expect(open).toBe(1);

    goLive([account(me, { syncState: 'catchup' })]);
    TestBed.tick();
    expect(svc.accountIds()).toBe(accountIds);
    expect(svc.roomsInCommon(person, '!a')).toBe(before);

    goLive([account(me, { generation: 2 })]);
    expect(svc.accountIds()).not.toBe(accountIds);
    expect(svc.accountIds()).toEqual([me]);
    expect(svc.roomsInCommon(person, '!a')).not.toBe(before);
    TestBed.tick();

    expect(open).toBe(1);
  });

  it('releases the views of an account that leaves', () => {
    goLive([account(me), account(OTHER_ACCOUNT)]);
    svc.roomsInCommon(person, '!a', OTHER_ACCOUNT);
    svc.roomsInCommon(person, '!a');
    TestBed.tick();
    expect(open).toBe(2);

    goLive([account(me)]);
    TestBed.tick();

    expect(open).toBe(1);
  });

  it('evicts the oldest views beyond the cap', () => {
    const oldest = svc.roomsInCommon('@u0:hs', '!x');
    for (let i = 1; i <= 20; i++) svc.roomsInCommon(`@u${i}:hs`, '!x');

    expect(open).toBe(20);
    expect(svc.roomsInCommon('@u0:hs', '!x')).not.toBe(oldest);
  });
});
