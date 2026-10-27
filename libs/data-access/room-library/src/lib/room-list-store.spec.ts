import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { finalize, firstValueFrom, tap } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_SESSION,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import {
  FakeRoomListEngine,
  fakeRoom,
} from '../contract/fake-room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';
import { RoomListStore } from './room-list-store';

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

describe('RoomListStore', () => {
  let fake: FakeRoomListEngine;
  let snapshot: ReturnType<typeof signal<SessionSnapshot>>;
  let store: RoomListStore;
  let alice: string;
  let open: number;
  const A = fakeRoom('!a:example.org');
  const B = fakeRoom('!b:example.org');

  const goLive = (...accounts: SessionAccountStatus[]) =>
    snapshot.set({ ...EMPTY_SESSION, accounts });

  beforeEach(() => {
    fake = new FakeRoomListEngine();
    alice = fake.alice;
    open = 0;
    const rooms = fake.rooms.bind(fake);
    fake.rooms = (accountId) =>
      rooms(accountId).pipe(
        tap({ subscribe: () => (open += 1) }),
        finalize(() => (open -= 1)),
      );
    snapshot = signal(EMPTY_SESSION);
    TestBed.configureTestingModule({
      providers: [
        { provide: ROOM_LIST_ENGINE, useValue: fake },
        { provide: SESSION_SNAPSHOT, useValue: snapshot },
      ],
    });
    store = TestBed.inject(RoomListStore);
  });

  it('populates in the same turn the account goes live', () => {
    fake.seed(alice, [A, B]);
    const view = computed(() => store.rooms(alice)());
    expect(view()).toEqual([]);
    expect(store.liveAccountIds()).toEqual([]);

    goLive(account(alice));

    expect(view()).toEqual([A, B]);
    expect(store.rooms(alice)()).toEqual([A, B]);
    expect(store.liveAccountIds()).toEqual([alice]);
  });

  it('keeps unchanged rows by reference', async () => {
    fake.seed(alice, [A, B]);
    goLive(account(alice));
    const before = store.rooms(alice)();

    fake.seed(alice, [{ ...A }, { ...B }]);
    expect(store.rooms(alice)()).toBe(before);

    await firstValueFrom(fake.setTag(alice, B.roomId, 'favourite', true));
    const after = store.rooms(alice)();
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toEqual({ ...B, favourite: true });
  });

  it('resubscribes on a new generation', () => {
    fake.seed(alice, [A]);
    goLive(account(alice, 1));
    expect(store.rooms(alice)()).toEqual([A]);
    expect(open).toBe(1);

    fake.seed(alice, [A, B]);
    goLive(account(alice, 2));

    expect(store.rooms(alice)()).toEqual([A, B]);
    expect(open).toBe(1);
  });

  it("drops the account's rows when it leaves", () => {
    fake.seed(alice, [A]);
    goLive(account(alice));
    expect(store.room(alice, A.roomId)).toEqual(A);

    goLive();

    expect(store.rooms(alice)()).toEqual([]);
    expect(store.room(alice, A.roomId)).toBeNull();
    expect(store.liveAccountIds()).toEqual([]);
    expect(open).toBe(0);
  });

  it('folds non-reset diffs', async () => {
    fake.seed(alice, [A]);
    goLive(account(alice));
    const view = computed(() =>
      store
        .rooms(alice)()
        .map((r) => r.roomId),
    );
    expect(view()).toEqual([A.roomId]);

    const created = await firstValueFrom(
      fake.createRoom(alice, { name: 'New', topic: null, isPublic: false }),
    );
    const roomId = created.ok ? created.value.roomId : '';
    expect(view()).toEqual([A.roomId, roomId]);

    await firstValueFrom(fake.setMarkedUnread(alice, roomId, true));
    expect(store.room(alice, roomId)?.markedUnread).toBe(true);

    await firstValueFrom(fake.leave(alice, A.roomId));
    expect(view()).toEqual([roomId]);
  });

  it('room() reads synchronously', () => {
    fake.seed(alice, [A, B]);
    goLive(account(alice));

    expect(store.room(alice, B.roomId)).toBe(store.rooms(alice)()[1]);
    expect(store.room(alice, '!missing:example.org')).toBeNull();
    expect(store.room('@nobody:example.org', A.roomId)).toBeNull();
  });

  it('exposes typing and the direct map per account', async () => {
    fake.seed(alice, [A]);
    goLive(account(alice));
    const typing = store.typing(alice);
    const direct = store.directMap(alice);
    expect(typing()).toEqual({});

    fake.setTyping(alice, A.roomId, [{ userId: fake.bob, displayName: 'Bob' }]);
    await firstValueFrom(fake.createDirectMessage(alice, fake.bob));

    expect(typing()[A.roomId]).toEqual([
      { userId: fake.bob, displayName: 'Bob' },
    ]);
    expect(Object.keys(direct())).toEqual([fake.bob]);
  });

  it('returns a stable empty list for an unknown account', () => {
    expect(store.rooms('@nobody:example.org')()).toBe(
      store.rooms('@other:example.org')(),
    );
  });

  it('unsubscribes everything on destroy', () => {
    fake.seed(alice, [A]);
    goLive(account(alice));
    store.rooms(alice)();

    TestBed.resetTestingModule();

    expect(open).toBe(0);
  });
});
