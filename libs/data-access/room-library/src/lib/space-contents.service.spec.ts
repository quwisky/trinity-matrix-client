import { signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import {
  EMPTY_SESSION,
  SESSION_ENGINE,
  SESSION_SNAPSHOT,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import { type EngineResult, engineFail, engineOk } from '@trinity/util/matrix';
import { defer, firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  FakeRoomListEngine,
  fakeRoom,
} from '../contract/fake-room-list-engine';
import type { HierarchyEntry } from './room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';
import { RoomLibraryService } from './room-library.service';
import { ROOM_LIBRARY_GOVERNANCE_POLICY } from './room-library-governance-policy';
import { SpaceChildrenService } from './space-children.service';
import {
  SpaceContentsService,
  type SpaceContentsSnapshot,
} from './space-contents.service';
import { SpacesService } from './spaces.service';

const ALICE = '@alice:example.org';
const TARGET = { accountId: ALICE, spaceId: '!parent:hs' } as const;

function entry(
  roomId: string,
  patch: Partial<HierarchyEntry> = {},
): HierarchyEntry {
  return {
    roomId,
    name: null,
    canonicalAlias: null,
    topic: null,
    avatarMxc: null,
    joinedMemberCount: 0,
    joinRule: null,
    isSpace: false,
    childrenState: [],
    ...patch,
  };
}

const HIERARCHY: readonly HierarchyEntry[] = [
  entry(TARGET.spaceId, { name: 'Design', isSpace: true }),
  entry('!child:remote', { name: 'Public child', joinedMemberCount: 4 }),
  entry('!nested:hs', { name: 'Nested', isSpace: true, joinedMemberCount: 2 }),
];

type HierarchyResult = EngineResult<readonly HierarchyEntry[]>;

function setup(
  options: { allowed?: boolean; hierarchy?: HierarchyResult[] } = {},
) {
  const fake = new FakeRoomListEngine();
  fake.seed(ALICE, [
    fakeRoom(TARGET.spaceId, { displayName: 'Design', isSpace: true }),
    fakeRoom('!candidate:hs', { displayName: 'Candidate' }),
    fakeRoom('!nested:hs', { displayName: 'Nested', isSpace: true }),
  ]);
  const link = (
    childId: string,
    via: string[],
    order: string,
    suggested = false,
  ): void =>
    void fake
      .setSpaceChild(ALICE, TARGET.spaceId, childId, { via, order, suggested })
      .subscribe();
  link('!child:remote', ['remote'], 'a', true);
  link('!nested:hs', ['hs'], 'b');
  // Each answer is used once; the last one repeats.
  const answers = [...(options.hierarchy ?? [engineOk(HIERARCHY)])];
  const spaceHierarchy = vi
    .spyOn(fake, 'spaceHierarchy')
    .mockImplementation(() =>
      defer(() =>
        of(
          answers.length > 1
            ? (answers.shift() as HierarchyResult)
            : answers[0],
        ),
      ),
    );
  const session = signal<SessionSnapshot>({
    ...EMPTY_SESSION,
    activeAccountId: ALICE,
    accounts: [
      {
        accountId: ALICE,
        deviceId: 'DEVICE',
        generation: 1,
        syncState: 'syncing',
        serverSynced: true,
        roomsPrepared: true,
        waitingCount: 0,
        cryptoStoreEncrypted: true,
      },
    ],
  });
  // Signal-backed like the application's policy, which tracks power levels.
  const allowed = signal(options.allowed !== false);
  const authorize = vi.fn(() =>
    allowed()
      ? ({ kind: 'allowed' } as const)
      : ({ kind: 'rejected', reason: 'You need permission.' } as const),
  );
  const createRoomFor = vi.fn(() => of('!created-room:hs'));
  const createSpace = vi.fn(() => of('!created-space:hs'));
  const addExistingRoom = vi.fn(() => of(undefined));
  const removeExistingRoom = vi.fn(() => of(undefined));
  const setSuggested = vi.fn(() => of({ expectedLinks: [] }));
  const moveChildBefore = vi.fn(() => of({ expectedLinks: [] }));
  TestBed.configureTestingModule({
    providers: [
      SpaceContentsService,
      { provide: ROOM_LIST_ENGINE, useValue: fake },
      { provide: SESSION_SNAPSHOT, useValue: session },
      {
        provide: SESSION_ENGINE,
        useFactory: () => ({ session: () => toObservable(session) }),
      },
      MockProvider(RoomLibraryService, { createRoomFor }),
      MockProvider(SpacesService, { createSpace }),
      MockProvider(SpaceChildrenService, {
        addExistingRoom,
        removeExistingRoom,
        setSuggested,
        moveChildBefore,
      }),
      { provide: ROOM_LIBRARY_GOVERNANCE_POLICY, useValue: { authorize } },
    ],
  });
  return {
    service: TestBed.inject(SpaceContentsService),
    fake,
    link,
    session,
    spaceHierarchy,
    authorize,
    allowed,
    createRoomFor,
    createSpace,
    addExistingRoom,
    removeExistingRoom,
    setSuggested,
    moveChildBefore,
  };
}

describe('SpaceContentsService', () => {
  it('projects Room and Space children from the opening Account hierarchy', async () => {
    const { service, spaceHierarchy } = setup();

    const snapshot = await firstValueFrom(service.observe(TARGET));

    expect(spaceHierarchy).toHaveBeenCalledWith(ALICE, TARGET.spaceId, {
      maxPages: null,
    });
    expect(snapshot.items).toMatchObject([
      {
        id: '!child:remote',
        name: 'Public child',
        kind: 'room',
        joined: false,
        suggested: true,
        order: 'a',
      },
      { id: '!nested:hs', name: 'Nested', kind: 'space', joined: true },
    ]);
    expect(snapshot.candidates.map(({ id }) => id)).toEqual(['!candidate:hs']);
  });

  // Page following and the repeated-token guard are covered by the js-sdk adapter spec.
  it('asks the engine for every hierarchy page (maxPages: null)', async () => {
    const { service, spaceHierarchy } = setup({
      hierarchy: [engineOk([HIERARCHY[0], HIERARCHY[1]])],
    });

    const snapshot = await firstValueFrom(service.observe(TARGET));

    expect(spaceHierarchy).toHaveBeenCalledWith(ALICE, TARGET.spaceId, {
      maxPages: null,
    });
    expect(snapshot.items.map(({ id }) => id)).toEqual(['!child:remote']);
  });

  it('keeps readable hierarchy while hiding management after permission loss', async () => {
    const { service } = setup({ allowed: false });

    const snapshot = await firstValueFrom(service.observe(TARGET));

    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.canManage).toBe(false);
    expect(snapshot.managementUnavailableReason).toBe('You need permission.');
  });

  it('reports hierarchy failure without inventing an empty authoritative list', async () => {
    vi.useFakeTimers();
    try {
      const { service } = setup({
        hierarchy: [
          engineFail({
            kind: 'server',
            code: 'request-failed',
            diagnostic: { kind: 'server', httpStatus: 503 },
          }),
        ],
      });
      const snapshots: SpaceContentsSnapshot[] = [];
      const subscription = service
        .observe(TARGET)
        .subscribe((snapshot) => snapshots.push(snapshot));
      await vi.advanceTimersByTimeAsync(10_000);

      const snapshot = snapshots.at(-1);
      expect(snapshot?.availability).toBe('available');
      expect(snapshot?.hierarchyError).toBe(
        'The homeserver is unavailable. Try again.',
      );
      expect(snapshot?.items).toEqual([]);
      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the generic copy for a failure the engine cannot classify', async () => {
    // A repeated page token reaches here as an unclassified request failure.
    const { service } = setup({
      hierarchy: [
        engineFail({
          kind: 'unexpected',
          code: 'request-failed',
          diagnostic: { kind: 'unexpected' },
        }),
      ],
    });

    const snapshot = await firstValueFrom(service.observe(TARGET));

    expect(snapshot.hierarchyError).toBe('Something went wrong. Try again.');
  });

  it('coalesces a burst of invalidations into a bounded number of hierarchy reads', async () => {
    vi.useFakeTimers();
    try {
      const { service, spaceHierarchy, link } = setup();
      const subscription = service.observe(TARGET).subscribe();
      await vi.advanceTimersByTimeAsync(0);

      // One sync batch can announce many Rooms at once. Synapse allows each user a burst
      // of 10 hierarchy reads at 5/s, so one read per event trips 429 within a batch.
      for (let index = 0; index < 20; index += 1) {
        link('!candidate:hs', ['hs'], `c${index}`);
      }
      await vi.advanceTimersByTimeAsync(1_000);

      expect(spaceHierarchy.mock.calls.length).toBeLessThanOrEqual(3);
      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('throttles refreshes to 250 ms', async () => {
    vi.useFakeTimers();
    try {
      const { service, spaceHierarchy, fake } = setup();
      const subscription = service.observe(TARGET).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      expect(spaceHierarchy).toHaveBeenCalledTimes(1);

      // A room the account joins changes the store's rows.
      fake.seed(ALICE, [
        fakeRoom(TARGET.spaceId, { displayName: 'Design', isSpace: true }),
        fakeRoom('!candidate:hs', { displayName: 'Candidate' }),
        fakeRoom('!nested:hs', { displayName: 'Nested', isSpace: true }),
        fakeRoom('!joined:hs', { displayName: 'Joined' }),
      ]);
      await vi.advanceTimersByTimeAsync(249);
      expect(spaceHierarchy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(spaceHierarchy).toHaveBeenCalledTimes(2);
      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not refresh for a row change the snapshot does not show', async () => {
    vi.useFakeTimers();
    try {
      const { service, spaceHierarchy, fake } = setup();
      const subscription = service.observe(TARGET).subscribe();
      await vi.advanceTimersByTimeAsync(1_000);

      fake.seed(ALICE, [
        fakeRoom(TARGET.spaceId, { displayName: 'Design', isSpace: true }),
        fakeRoom('!candidate:hs', {
          displayName: 'Candidate',
          notificationCount: 3,
        }),
        fakeRoom('!nested:hs', { displayName: 'Nested', isSpace: true }),
      ]);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(spaceHierarchy).toHaveBeenCalledTimes(1);
      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes management when the Account loses power in the space', async () => {
    vi.useFakeTimers();
    try {
      const { service, allowed } = setup();
      const snapshots: SpaceContentsSnapshot[] = [];
      const subscription = service
        .observe(TARGET)
        .subscribe((snapshot) => snapshots.push(snapshot));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(snapshots.at(-1)?.canManage).toBe(true);

      allowed.set(false);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(snapshots.at(-1)).toMatchObject({
        canManage: false,
        managementUnavailableReason: 'You need permission.',
      });
      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops watching rows and permissions once unsubscribed', async () => {
    vi.useFakeTimers();
    try {
      const { service, fake, allowed, authorize, spaceHierarchy } = setup();
      const subscription = service.observe(TARGET).subscribe();
      await vi.advanceTimersByTimeAsync(1_000);
      subscription.unsubscribe();
      const reads = authorize.mock.calls.length;

      allowed.set(false);
      fake.seed(ALICE, [
        fakeRoom(TARGET.spaceId, { displayName: 'Design', isSpace: true }),
        fakeRoom('!renamed:hs', { displayName: 'Renamed' }),
      ]);
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(authorize).toHaveBeenCalledTimes(reads);
      expect(spaceHierarchy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a timed-out hierarchy read', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const { service, spaceHierarchy } = setup();
      spaceHierarchy.mockImplementation(() =>
        defer(() =>
          of(
            reads++ === 0
              ? engineFail({
                  kind: 'timeout',
                  code: 'request-failed',
                  diagnostic: { kind: 'timeout' },
                })
              : engineOk(HIERARCHY),
          ),
        ),
      );
      const snapshots: SpaceContentsSnapshot[] = [];
      const subscription = service
        .observe(TARGET)
        .subscribe((snapshot) => snapshots.push(snapshot));

      await vi.advanceTimersByTimeAsync(2_000);

      expect(reads).toBe(2);
      expect(snapshots.at(-1)).toMatchObject({ hierarchyError: null });
      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a rate-limited hierarchy read instead of stranding the error', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const { service, spaceHierarchy } = setup();
      spaceHierarchy.mockImplementation(() =>
        defer(() =>
          of(
            reads++ === 0
              ? engineFail({
                  kind: 'rate-limit',
                  code: 'request-failed',
                  diagnostic: { kind: 'rate-limit', httpStatus: 429 },
                })
              : engineOk(HIERARCHY),
          ),
        ),
      );
      const snapshots: SpaceContentsSnapshot[] = [];
      const subscription = service
        .observe(TARGET)
        .subscribe((snapshot) => snapshots.push(snapshot));

      await vi.advanceTimersByTimeAsync(2_000);

      expect(reads).toBe(2);
      expect(snapshots.at(-1)).toMatchObject({ hierarchyError: null });
      expect(snapshots.at(-1)?.items).toHaveLength(2);
      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the Account unavailable once its session generation changes', async () => {
    const { service, session } = setup();
    const snapshots: SpaceContentsSnapshot[] = [];
    const subscription = service
      .observe(TARGET)
      .subscribe((snapshot) => snapshots.push(snapshot));
    await vi.waitFor(() => expect(snapshots).toHaveLength(1));

    session.set(EMPTY_SESSION);
    TestBed.tick();

    expect(snapshots.at(-1)?.availability).toBe('account-unavailable');
    subscription.unsubscribe();
  });

  it('reads a space the Account has not joined as unavailable without a request', async () => {
    const { service, spaceHierarchy } = setup();

    const snapshot = await firstValueFrom(
      service.read({ accountId: ALICE, spaceId: '!candidate:hs' }),
    );

    expect(snapshot.availability).toBe('space-unavailable');
    expect(spaceHierarchy).not.toHaveBeenCalled();
  });

  it('creates and links on the exact Account with parent-only policy', async () => {
    const { service, createRoomFor, addExistingRoom } = setup();

    const result = await firstValueFrom(
      service.create(TARGET, 'room', '  New room  '),
    );

    expect(createRoomFor).toHaveBeenCalledWith(TARGET.accountId, {
      name: 'New room',
    });
    expect(addExistingRoom).toHaveBeenCalledWith(
      TARGET.accountId,
      TARGET.spaceId,
      '!created-room:hs',
    );
    expect(result).toEqual({
      kind: 'linked',
      item: { id: '!created-room:hs', name: 'New room', kind: 'room' },
    });
  });

  it('preserves a created item when linking fails so retry does not create again', async () => {
    const { service, createSpace, addExistingRoom } = setup();
    addExistingRoom.mockReturnValueOnce(
      throwError(() => new Error('link rejected')),
    );

    const result = await firstValueFrom(
      service.create(TARGET, 'space', 'Nested'),
    );
    if (result.kind !== 'created-unlinked')
      throw new Error('expected recovery');
    await firstValueFrom(service.link(TARGET, result.item.id));

    expect(result.reason).toBe('link rejected');
    expect(result.item.id).toBe('!created-space:hs');
    expect(createSpace).toHaveBeenCalledTimes(1);
    expect(addExistingRoom).toHaveBeenCalledTimes(2);
  });

  it('unlinks through the exact parent without any membership command', async () => {
    const { service, removeExistingRoom } = setup();

    await firstValueFrom(service.unlink(TARGET, '!child:remote'));

    expect(removeExistingRoom).toHaveBeenCalledWith(
      TARGET.accountId,
      TARGET.spaceId,
      '!child:remote',
    );
  });

  it('curates shared state through the exact target', async () => {
    const { service, setSuggested, moveChildBefore } = setup();

    await firstValueFrom(service.setSuggested(TARGET, '!child:remote', true));
    await firstValueFrom(
      service.moveChildBefore(TARGET, '!nested:hs', '!child:remote'),
    );

    expect(setSuggested).toHaveBeenCalledWith(
      TARGET.accountId,
      TARGET.spaceId,
      '!child:remote',
      true,
    );
    expect(moveChildBefore).toHaveBeenCalledWith(
      TARGET.accountId,
      TARGET.spaceId,
      '!nested:hs',
      '!child:remote',
    );
  });
});
