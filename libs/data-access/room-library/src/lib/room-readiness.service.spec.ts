import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SESSION,
  SESSION_ENGINE,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionSnapshot,
  type SessionSyncState,
} from '@trinity/data-access/matrix-client';
import {
  FakeRoomListEngine,
  fakeRoom,
} from '../contract/fake-room-list-engine';
import type { RoomMembership } from './room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';
import {
  ROOM_READINESS_TIMEOUT_MS,
  RoomReadinessError,
  RoomReadinessService,
} from './room-readiness.service';

afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

function account(
  accountId: string,
  syncState: SessionSyncState = 'syncing',
): SessionAccountStatus {
  return {
    accountId,
    generation: 1,
    syncState,
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

describe('RoomReadinessService', () => {
  /** The owner's room list, holding `!r:hs` with `initial` membership, or not at all. */
  function setup(initial: 'none' | RoomMembership = 'none') {
    const fake = new FakeRoomListEngine();
    const owner = fake.alice;
    const stored = (membership: RoomMembership) =>
      fakeRoom('!r:hs', { membership });
    fake.seed(owner, initial === 'none' ? [] : [stored(initial)]);
    const session = signal<SessionSnapshot>({
      ...EMPTY_SESSION,
      activeAccountId: owner,
      accounts: [account(owner)],
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
    return {
      service: TestBed.inject(RoomReadinessService),
      owner,
      session,
      /** `/sync` publishes the joined Room, new or already stored. */
      syncJoin: () => fake.seed(owner, [stored('join')]),
      stopSync: () =>
        session.update((s) => ({
          ...s,
          accounts: [account(owner, 'stopped')],
        })),
    };
  }

  /** Subscribes and tracks the outcome, with effects flushed. */
  function watch(service: RoomReadinessService, accountId: string) {
    const outcome: { resolved: boolean; error: unknown } = {
      resolved: false,
      error: null,
    };
    const subscription = service.waitForRoom(accountId, '!r:hs').subscribe({
      complete: () => (outcome.resolved = true),
      error: (error: unknown) => (outcome.error = error),
    });
    TestBed.tick();
    return { outcome, subscription };
  }

  it('is cold and resolves when the exact Account publishes the Room', () => {
    const { service, owner, session, syncJoin } = setup();
    session.update((s) => ({ ...s, accounts: [] }));
    const readiness = service.waitForRoom(owner, '!r:hs');
    session.update((s) => ({ ...s, accounts: [account(owner)] }));

    let resolved = false;
    const subscription = readiness.subscribe({
      complete: () => (resolved = true),
    });
    TestBed.tick();
    expect(resolved).toBe(false);
    syncJoin();
    TestBed.tick();

    expect(resolved).toBe(true);
    expect(subscription.closed).toBe(true);
  });

  it('resolves immediately when the Room is already joined', async () => {
    const { service, owner } = setup('join');

    await expect(
      firstValueFrom(service.waitForRoom(owner, '!r:hs')),
    ).resolves.toBeUndefined();
  });

  // Re-joining a left Room, or accepting an invitation, keeps the earlier membership until
  // `/sync` brings the join; Workspace only keeps a space that is joined.
  it.each(['invite', 'knock'] as const)(
    'waits for the join to sync when the Room is still listed as %s',
    (membership) => {
      const { service, owner, syncJoin } = setup(membership);
      const { outcome, subscription } = watch(service, owner);

      expect(outcome.resolved).toBe(false);
      syncJoin();
      TestBed.tick();

      expect(outcome.resolved).toBe(true);
      expect(subscription.closed).toBe(true);
    },
  );

  it('fails closed when the exact Account is not live', async () => {
    const { service } = setup();

    await expect(
      firstValueFrom(service.waitForRoom('@gone:hs', '!r:hs')),
    ).rejects.toMatchObject({
      name: 'RoomReadinessError',
      failure: 'account-unavailable',
    });
  });

  it('fails with typed metadata and tears down when sync stops', () => {
    const { service, owner, stopSync } = setup();
    const { outcome, subscription } = watch(service, owner);

    stopSync();
    TestBed.tick();

    expect(outcome.error).toEqual(new RoomReadinessError('sync-stopped'));
    expect(subscription.closed).toBe(true);
  });

  it('readiness rejects when the account is removed', () => {
    const { service, owner, session } = setup();
    const { outcome, subscription } = watch(service, owner);

    session.update((s) => ({ ...s, activeAccountId: null, accounts: [] }));
    TestBed.tick();

    expect(outcome.error).toEqual(new RoomReadinessError('sync-stopped'));
    expect(subscription.closed).toBe(true);
  });

  it('times out with typed metadata and tears down when the Room never arrives', async () => {
    vi.useFakeTimers();
    const { service, owner } = setup();
    const { outcome, subscription } = watch(service, owner);

    await vi.advanceTimersByTimeAsync(ROOM_READINESS_TIMEOUT_MS);

    expect(outcome.error).toMatchObject({
      name: 'RoomReadinessError',
      failure: 'timed-out',
    });
    expect(subscription.closed).toBe(true);
  });
});
