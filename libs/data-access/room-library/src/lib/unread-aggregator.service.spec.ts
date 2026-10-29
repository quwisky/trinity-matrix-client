import { signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
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
import type { RoomInfo } from './room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';
import { UnreadAggregatorService } from './unread-aggregator.service';

let roomSeq = 0;

function account(accountId: string, generation = 1): SessionAccountStatus {
  return {
    accountId,
    deviceId: 'DEVICE',
    generation,
    syncState: 'syncing',
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

/** A joined room with `unread` notifications; `patch` overrides any other field. */
function room(unread: number, patch: Partial<RoomInfo> = {}): RoomInfo {
  return fakeRoom(patch.roomId ?? `!room${++roomSeq}:hs`, {
    displayName: 'Room',
    notificationCount: unread,
    ...patch,
  });
}

/** UnreadAggregatorService over the fake engine, the real RoomListStore and a fake session. */
function harness() {
  const fake = new FakeRoomListEngine();
  const session = signal<SessionSnapshot>({ ...EMPTY_SESSION, accounts: [] });
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
  const svc = TestBed.inject(UnreadAggregatorService);
  /** Makes exactly these accounts live, at generation 1 unless given. */
  const live = (...accounts: (string | SessionAccountStatus)[]): void =>
    session.update((s) => ({
      ...s,
      accounts: accounts.map((a) => (typeof a === 'string' ? account(a) : a)),
    }));
  return { svc, fake, live };
}

describe('UnreadAggregatorService', () => {
  it('sums unread across every signed-in account', () => {
    const { svc, fake, live } = harness();
    fake.seed('@a:hs', [room(3)]);
    fake.seed('@b:hs', [room(2), room(4)]);
    live('@a:hs', '@b:hs');

    expect(svc.totalUnread()).toBe(9);
    expect(svc.unreadByAccount().get('@a:hs')).toBe(3);
    expect(svc.unreadByAccount().get('@b:hs')).toBe(6);
  });

  it('counts only joined, non-space rooms', () => {
    const { svc, fake, live } = harness();
    fake.seed('@a:hs', [
      room(3),
      room(10, { isSpace: true }),
      room(7, { membership: 'invite' }),
    ]);
    live('@a:hs');

    expect(svc.totalUnread()).toBe(3);
  });

  it('recomputes an account total when its room list changes', () => {
    const { svc, fake, live } = harness();
    fake.seed('@a:hs', [room(2, { roomId: '!r:hs' })]);
    live('@a:hs');
    expect(svc.totalUnread()).toBe(2);

    fake.seed('@a:hs', [room(9, { roomId: '!r:hs' })]);

    expect(svc.totalUnread()).toBe(9);
  });

  it('keeps the same totals when a change alters no count', () => {
    const { svc, fake, live } = harness();
    fake.seed('@a:hs', [room(2, { roomId: '!r:hs' })]);
    live('@a:hs');
    const before = svc.unreadByAccount();

    fake.seed('@a:hs', [room(2, { roomId: '!r:hs', topic: 'new topic' })]);

    // Every badge reading the totals would otherwise recompute on every sync (#1292).
    expect(svc.unreadByAccount()).toBe(before);
  });

  it('recomputes when an encrypted message decrypts after its sync', () => {
    // The engine raises an encrypted room's count once the message decrypts, after the sync
    // that carried the ciphertext; the dock badge must not wait for the next sync.
    const { svc, fake, live } = harness();
    fake.seed('@a:hs', [room(0, { roomId: '!r:hs', encryption: 'encrypted' })]);
    live('@a:hs');
    expect(svc.totalUnread()).toBe(0);

    fake.seed('@a:hs', [room(1, { roomId: '!r:hs', encryption: 'encrypted' })]);

    expect(svc.totalUnread()).toBe(1);
  });

  it('settles on the last of a burst of changes within one task', () => {
    const { svc, fake, live } = harness();
    fake.seed('@a:hs', [room(2, { roomId: '!r:hs' })]);
    live('@a:hs');
    expect(svc.totalUnread()).toBe(2);

    fake.seed('@a:hs', [room(5, { roomId: '!r:hs' })]);
    fake.seed('@a:hs', [room(7, { roomId: '!r:hs' })]);
    fake.seed('@a:hs', [room(9, { roomId: '!r:hs' })]);

    expect(svc.totalUnread()).toBe(9);
  });

  it('counts an account added later and drops one signed out', () => {
    const { svc, fake, live } = harness();
    fake.seed('@a:hs', [room(3)]);
    live('@a:hs');
    expect(svc.totalUnread()).toBe(3);

    fake.seed('@b:hs', [room(5)]);
    live('@a:hs', '@b:hs');
    expect(svc.totalUnread()).toBe(8);

    live('@b:hs');

    expect(svc.totalUnread()).toBe(5);
    expect(svc.unreadByAccount().has('@a:hs')).toBe(false);
  });

  it('a restarted account is not double counted', () => {
    // Re-adding or re-authenticating a signed-in account starts a new generation under the
    // same user id; its rooms must replace the old generation's, not add to them.
    const { svc, fake, live } = harness();
    fake.seed('@a:hs', [room(3, { roomId: '!r:hs' })]);
    live('@a:hs');
    expect(svc.totalUnread()).toBe(3);

    live(account('@a:hs', 2));
    expect(svc.totalUnread()).toBe(3);
    expect(svc.unreadRooms()).toHaveLength(1);

    // The new generation's list drives the badge.
    fake.seed('@a:hs', [room(9, { roomId: '!r:hs' })]);

    expect(svc.totalUnread()).toBe(9);
  });

  describe('rooms flagged to come back to', () => {
    it('counts a flagged room even though the server counts it as zero', () => {
      // Without this the flag is visible nowhere but the one sidebar list that happens
      // to show the room: the rail pills and the app-icon badge both sum server counts,
      // which stay at zero because the read receipt never moved.
      const { svc, fake, live } = harness();
      fake.seed('@a:hs', [room(0, { markedUnread: true }), room(0)]);
      live('@a:hs');

      expect(svc.totalUnread()).toBe(1);
    });

    it('does not double-count a flagged room that also has notifications', () => {
      const { svc, fake, live } = harness();
      fake.seed('@a:hs', [room(3, { markedUnread: true })]);
      live('@a:hs');

      expect(svc.totalUnread()).toBe(3);
    });
  });

  it('recomputes when a room’s marked-unread flag changes', () => {
    // Both flag tests above set the flag before the first read. This proves the app-icon
    // badge reacts to a flag set on another device rather than waiting for an unrelated change.
    const { svc, fake, live } = harness();
    fake.seed('@a:hs', [room(0, { roomId: '!r:hs' })]);
    live('@a:hs');
    expect(svc.totalUnread()).toBe(0);

    fake.seed('@a:hs', [room(0, { roomId: '!r:hs', markedUnread: true })]);

    expect(svc.totalUnread()).toBe(1);
  });
});

describe('unread chats', () => {
  it('lists every unread joined chat on every account with what the rail draws', () => {
    const { svc, fake, live } = harness();
    fake.seed('@a:hs', [
      room(2, {
        roomId: '!dm:hs',
        displayName: 'Bob',
        recencyStamp: 20,
        avatarMxc: 'mxc://hs/bob',
        directUserId: '@bob:hs',
      }),
      room(0, { roomId: '!read:hs' }),
    ]);
    fake.seed('@b:hs', [
      room(5, { roomId: '!team:hs', displayName: 'Team', recencyStamp: 30 }),
    ]);
    live('@a:hs', '@b:hs');

    expect(svc.unreadRooms()).toEqual([
      {
        accountId: '@a:hs',
        roomId: '!dm:hs',
        name: 'Bob',
        initial: 'B',
        avatarMxc: 'mxc://hs/bob',
        direct: true,
        unreadCount: 2,
        markedUnread: false,
        activityTs: 20,
      },
      {
        accountId: '@b:hs',
        roomId: '!team:hs',
        name: 'Team',
        initial: 'T',
        avatarMxc: null,
        direct: false,
        unreadCount: 5,
        markedUnread: false,
        activityTs: 30,
      },
    ]);
  });

  it("dates a chat by the engine's recency stamp, which counts thread replies", () => {
    const { svc, fake, live } = harness();
    fake.seed('@a:hs', [room(1, { roomId: '!t:hs', recencyStamp: 90 })]);
    live('@a:hs');

    expect(svc.unreadRooms()[0].activityTs).toBe(90);
  });

  it('applies the app badge rule: no spaces, no invites, a flagged chat with no count stays', () => {
    const { svc, fake, live } = harness();
    fake.seed('@a:hs', [
      room(4, { roomId: '!space:hs', isSpace: true }),
      room(4, { roomId: '!invite:hs', membership: 'invite' }),
      room(0, { roomId: '!flagged:hs', markedUnread: true }),
    ]);
    live('@a:hs');

    expect(
      svc.unreadRooms().map((r) => [r.roomId, r.unreadCount, r.markedUnread]),
    ).toEqual([['!flagged:hs', 0, true]]);
    expect(svc.totalUnread()).toBe(1);
  });

  it('lists a room joined by two accounts once per account', () => {
    const { svc, fake, live } = harness();
    fake.seed('@a:hs', [room(1, { roomId: '!shared:hs' })]);
    fake.seed('@b:hs', [room(3, { roomId: '!shared:hs' })]);
    live('@a:hs', '@b:hs');

    expect(svc.unreadRooms().map((r) => `${r.accountId} ${r.roomId}`)).toEqual([
      '@a:hs !shared:hs',
      '@b:hs !shared:hs',
    ]);
  });

  it('drops a chat once it is read', () => {
    const { svc, fake, live } = harness();
    fake.seed('@a:hs', [room(2, { roomId: '!x:hs' })]);
    live('@a:hs');
    expect(svc.unreadRooms()).toHaveLength(1);

    fake.seed('@a:hs', [room(0, { roomId: '!x:hs' })]);

    expect(svc.unreadRooms()).toEqual([]);
  });

  it('drops a signed-out account’s chats', () => {
    const { svc, fake, live } = harness();
    fake.seed('@a:hs', [room(1)]);
    fake.seed('@b:hs', [room(1)]);
    live('@a:hs', '@b:hs');
    expect(svc.unreadRooms()).toHaveLength(2);

    live('@b:hs');

    expect(svc.unreadRooms().map((r) => r.accountId)).toEqual(['@b:hs']);
  });

  it('keeps the same list object when a change alters no unread chat', () => {
    const { svc, fake, live } = harness();
    const unread = room(2, { roomId: '!x:hs', displayName: 'X' });
    fake.seed('@a:hs', [unread, room(0, { roomId: '!y:hs' })]);
    live('@a:hs');
    const before = svc.unreadRooms();

    fake.seed('@a:hs', [unread, room(0, { roomId: '!y:hs', topic: 'new' })]);

    expect(svc.unreadRooms()).toBe(before);
  });

  it('a restarted account is not double counted in unreadRooms', () => {
    const { svc, fake, live } = harness();
    fake.seed('@a:hs', [room(1, { roomId: '!x:hs' })]);
    live('@a:hs');

    live(account('@a:hs', 2));

    expect(svc.unreadRooms().map((r) => `${r.accountId} ${r.roomId}`)).toEqual([
      '@a:hs !x:hs',
    ]);
  });
});
