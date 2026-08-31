import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  Router,
  convertToParamMap,
  type ParamMap,
} from '@angular/router';
import {
  AccountRuntimeService,
  type AccountSwitchCoordination,
  type AccountSwitchOutcome,
} from '@trinity/data-access/accounts';
import { MediaPipeline } from '@trinity/data-access/media';
import {
  RoomLibraryService,
  RoomReadinessService,
  SpacesService,
} from '@trinity/data-access/room-library';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import {
  BehaviorSubject,
  Observable,
  Subject,
  firstValueFrom,
  map,
  of,
  switchMap,
  tap,
} from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeRoomSegment } from '@trinity/util/matrix';
import { WorkspaceService } from './workspace.service';
import { WorkspaceTransitionWorkflow } from './workspace-transition.workflow';

const ALICE = '@alice:example.org';
const BOB = '@bob:example.org';
const ROOM = '!room:example.org';

interface HarnessOptions {
  readonly accountId?: string;
  readonly routeAccountId?: string;
  readonly routeRoomId?: string;
  readonly routeView?: string;
  readonly routeEventId?: string;
  readonly rooms?: Readonly<Record<string, readonly string[]>>;
  readonly compact?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const activeAccountId = signal<string | null>(options.accountId ?? ALICE);
  const paramMap = new BehaviorSubject<ParamMap>(
    convertToParamMap(
      options.routeRoomId
        ? { roomId: encodeRoomSegment(options.routeRoomId) }
        : {},
    ),
  );
  const queryParamMap = new BehaviorSubject<ParamMap>(
    convertToParamMap({
      ...(options.routeAccountId ? { account: options.routeAccountId } : {}),
      ...(options.routeView ? { view: options.routeView } : {}),
      ...(options.routeEventId ? { event: options.routeEventId } : {}),
    }),
  );
  const clients = new Map(
    Object.entries(
      options.rooms ?? {
        [ALICE]: [ROOM],
        [BOB]: [ROOM],
      },
    ).map(([accountId, roomIds]) => [
      accountId,
      {
        getRoom: (roomId: string) =>
          roomIds.includes(roomId) ? { roomId } : null,
      },
    ]),
  );
  const navigate = vi.fn(
    (commands: readonly string[], extras?: { queryParams?: object }) => {
      const segment = commands[1];
      paramMap.next(convertToParamMap(segment ? { roomId: segment } : {}));
      queryParamMap.next(convertToParamMap(extras?.queryParams ?? {}));
      return Promise.resolve(true);
    },
  );
  const switchActiveAccount = vi.fn<
    (
      accountId: string,
      coordination: AccountSwitchCoordination,
    ) => Observable<AccountSwitchOutcome>
  >((accountId: string, coordination: AccountSwitchCoordination) =>
    coordination.prepare().pipe(
      tap(() => coordination.onCommitStarted?.()),
      tap(() => activeAccountId.set(accountId)),
      switchMap(() =>
        clients.has(accountId)
          ? of({
              kind: 'ready' as const,
              accountId,
              metrics: {
                durationMs: 4,
                projectionDurationMs: 2,
                projectionCount: 3,
              },
            })
          : of({
              kind: 'failed' as const,
              accountId,
              failure: 'account-unavailable' as const,
            }),
      ),
    ),
  );
  const conversations = {
    focus: vi.fn(),
    blur: vi.fn(),
  };
  const media = { releaseAll: vi.fn() };
  const rooms = {
    clearMarkedUnread: vi.fn(() => of(void 0)),
    selectionAvailability: (accountId: string, roomId: string) => {
      const client = clients.get(accountId);
      if (!client) return 'unavailable' as const;
      return client.getRoom(roomId)
        ? ('available' as const)
        : ('unavailable' as const);
    },
  };
  const spaces = { openSpace: vi.fn(() => of(void 0)) };

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: options.compact ?? false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });

  TestBed.configureTestingModule({
    providers: [
      WorkspaceService,
      WorkspaceTransitionWorkflow,
      {
        provide: ActivatedRoute,
        useValue: { paramMap, queryParamMap },
      },
      { provide: Router, useValue: { navigate } },
      {
        provide: AccountRuntimeService,
        useValue: {
          activeAccountId: activeAccountId.asReadonly(),
          switchActiveAccount,
        },
      },
      { provide: ConversationRuntime, useValue: conversations },
      { provide: MediaPipeline, useValue: media },
      { provide: RoomLibraryService, useValue: rooms },
      {
        provide: RoomReadinessService,
        useValue: { waitForRoom: () => of(void 0) },
      },
      { provide: SpacesService, useValue: spaces },
    ],
  });
  const service = TestBed.inject(WorkspaceService);
  TestBed.tick();
  return {
    service,
    activeAccountId,
    paramMap,
    queryParamMap,
    navigate,
    switchActiveAccount,
    conversations,
    media,
    rooms,
    spaces,
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('WorkspaceService', () => {
  it('commits a canonical external Back destination without redundantly navigating', async () => {
    const h = harness({
      routeAccountId: ALICE,
      routeRoomId: ROOM,
      routeView: 'rooms',
    });
    h.navigate.mockClear();
    h.conversations.blur.mockClear();

    h.paramMap.next(convertToParamMap({}));
    h.queryParamMap.next(convertToParamMap({ account: ALICE, view: 'rooms' }));

    await vi.waitFor(() =>
      expect(h.service.view()).toEqual({
        accountId: ALICE,
        scope: { kind: 'rooms' },
        roomId: null,
        pane: 'list',
      }),
    );
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.conversations.blur).toHaveBeenCalled();
  });

  it('opens an inactive notification destination and publishes its event anchor after repair', async () => {
    const h = harness({
      routeAccountId: BOB,
      routeRoomId: ROOM,
      routeEventId: '$notification',
    });

    await vi.waitFor(() =>
      expect(h.service.eventTarget()).toMatchObject({
        eventId: '$notification',
      }),
    );
    expect(h.service.view()).toMatchObject({
      accountId: BOB,
      roomId: ROOM,
      pane: 'conversation',
    });
    expect(h.conversations.focus).toHaveBeenLastCalledWith({
      accountId: BOB,
      roomId: ROOM,
    });
  });

  it('repairs a notification for a missing room and does not publish its event anchor', async () => {
    const h = harness({
      routeAccountId: BOB,
      routeRoomId: '!missing:example.org',
      routeEventId: '$notification',
    });

    await vi.waitFor(() => expect(h.service.view().accountId).toBe(BOB));
    expect(h.service.view()).toMatchObject({ roomId: null, pane: 'list' });
    expect(h.service.eventTarget()).toBeNull();
  });

  it('restores an inactive Account deep link before atomically focusing its Conversation', async () => {
    const h = harness({
      routeAccountId: BOB,
      routeRoomId: ROOM,
    });

    await vi.waitFor(() => {
      expect(h.service.view()).toEqual({
        accountId: BOB,
        scope: { kind: 'recent' },
        roomId: ROOM,
        pane: 'conversation',
      });
    });
    expect(h.switchActiveAccount).toHaveBeenCalledWith(
      BOB,
      expect.objectContaining({
        prepare: expect.any(Function),
        onCommitStarted: expect.any(Function),
      }),
    );
    expect(h.conversations.focus).toHaveBeenLastCalledWith({
      accountId: BOB,
      roomId: ROOM,
    });
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('keeps the view unchanged until a user URL push succeeds', async () => {
    const h = harness({ routeAccountId: ALICE });
    const navigation = new Subject<boolean>();
    h.navigate.mockImplementationOnce(() => firstValueFrom(navigation));
    const destination = {
      accountId: ALICE,
      scope: { kind: 'rooms' },
      roomId: ROOM,
      pane: 'conversation',
    } as const;
    const result = firstValueFrom(
      h.service.open(destination, { source: 'user', history: 'push' }),
    );

    expect(h.service.view()).toEqual({
      accountId: ALICE,
      scope: { kind: 'recent' },
      roomId: null,
      pane: 'list',
    });
    expect(h.navigate).toHaveBeenLastCalledWith(
      ['/rooms', encodeRoomSegment(ROOM)],
      {
        queryParams: { account: ALICE, view: 'rooms' },
        replaceUrl: false,
      },
    );

    navigation.next(true);
    navigation.complete();
    await expect(result).resolves.toMatchObject({
      kind: 'ready',
      repaired: false,
      view: { accountId: ALICE, roomId: ROOM, pane: 'conversation' },
    });
  });

  it('repairs a missing room to the list and replaces malformed history', async () => {
    const h = harness({ routeAccountId: ALICE });
    h.navigate.mockClear();

    await expect(
      firstValueFrom(
        h.service.open(
          {
            accountId: ALICE,
            scope: { kind: 'home' },
            roomId: '!missing:example.org',
            pane: 'conversation',
          },
          { source: 'restore', history: 'replace' },
        ),
      ),
    ).resolves.toMatchObject({
      kind: 'ready',
      repaired: true,
      view: {
        accountId: ALICE,
        scope: { kind: 'home' },
        roomId: null,
        pane: 'list',
      },
    });
    expect(h.navigate).toHaveBeenLastCalledWith(['/rooms'], {
      queryParams: { account: ALICE, view: 'home' },
      replaceUrl: true,
    });
    expect(h.conversations.focus).not.toHaveBeenCalledWith(
      expect.objectContaining({ roomId: '!missing:example.org' }),
    );
  });

  it('exposes narrow derived signals from one read-only view', async () => {
    const h = harness({
      routeAccountId: ALICE,
      compact: true,
      rooms: { [ALICE]: [ROOM, '!space:example.org'] },
    });

    await expect(
      firstValueFrom(
        h.service.open(
          {
            accountId: ALICE,
            scope: { kind: 'space', spaceId: '!space:example.org' },
            roomId: ROOM,
            pane: 'conversation',
          },
          { source: 'user', history: 'push' },
        ),
      ),
    ).resolves.toMatchObject({ kind: 'ready' });
    expect(h.service.activeAccountId()).toBe(ALICE);
    expect(h.service.activeSpaceId()).toBe('!space:example.org');
    expect(h.service.recentView()).toBe(false);
    expect(h.service.roomsView()).toBe(false);
    expect(h.service.activeRoomId()).toBe(ROOM);
    expect(h.service.pane()).toBe('conversation');
    expect(h.service.placement()).toBe('conversation');
  });

  it('is cold and joins an identical destination while rejecting a conflict', async () => {
    const h = harness({ routeAccountId: ALICE });
    const navigation = new Subject<boolean>();
    h.navigate.mockImplementationOnce(() => firstValueFrom(navigation));
    h.navigate.mockClear();
    const destination = {
      accountId: ALICE,
      scope: { kind: 'recent' },
      roomId: ROOM,
      pane: 'conversation',
    } as const;
    const command = h.service.open(destination, {
      source: 'user',
      history: 'push',
    });

    expect(h.navigate).not.toHaveBeenCalled();
    const first = firstValueFrom(command);
    const joined = firstValueFrom(command);
    await expect(
      firstValueFrom(
        h.service.open(
          { ...destination, roomId: null, pane: 'list' },
          { source: 'user', history: 'push' },
        ),
      ),
    ).resolves.toMatchObject({ kind: 'transition-in-progress' });
    expect(h.navigate).toHaveBeenCalledOnce();

    navigation.next(true);
    navigation.complete();
    await expect(first).resolves.toMatchObject({ kind: 'ready' });
    await expect(joined).resolves.toMatchObject({ kind: 'ready' });
  });

  it('preserves only responsive placement outside the canonical destination', () => {
    const h = harness({ routeAccountId: ALICE, compact: false });

    expect(h.service.view().pane).toBe('list');
    expect(h.service.placement()).toBe('split');
  });

  it('keeps the current destination when Account activation fails', async () => {
    const h = harness({ routeAccountId: ALICE });
    const failed = {
      kind: 'failed',
      accountId: '@missing:example.org',
      failure: 'account-unavailable',
    } satisfies AccountSwitchOutcome;
    h.switchActiveAccount.mockReturnValueOnce(of(failed));
    const before = h.service.view();

    await expect(
      firstValueFrom(
        h.service.open(
          {
            accountId: '@missing:example.org',
            scope: { kind: 'recent' },
            roomId: null,
            pane: 'list',
          },
          { source: 'user', history: 'push' },
        ),
      ),
    ).resolves.toEqual({
      kind: 'failed',
      destination: {
        accountId: '@missing:example.org',
        scope: { kind: 'recent' },
        roomId: null,
        pane: 'list',
      },
      failure: 'account-transition-failed',
    });
    expect(h.service.view()).toBe(before);
  });

  it('does not activate another Account when its canonical URL is rejected', async () => {
    const h = harness({
      routeAccountId: ALICE,
      routeRoomId: ROOM,
    });
    h.navigate.mockResolvedValueOnce(false);
    const before = h.service.view();

    await expect(
      firstValueFrom(
        h.service.open(
          {
            accountId: BOB,
            scope: { kind: 'rooms' },
            roomId: ROOM,
            pane: 'conversation',
          },
          { source: 'user', history: 'push' },
        ),
      ),
    ).resolves.toMatchObject({
      kind: 'failed',
      failure: 'navigation-rejected',
    });
    expect(h.activeAccountId()).toBe(ALICE);
    expect(h.service.view()).toBe(before);
    expect(h.conversations.focus).toHaveBeenLastCalledWith({
      accountId: ALICE,
      roomId: ROOM,
    });
  });

  it('captures rollback state when a cold command is subscribed, not created', async () => {
    const h = harness({ routeAccountId: ALICE });
    const delayed = h.service.open(
      {
        accountId: BOB,
        scope: { kind: 'home' },
        roomId: null,
        pane: 'list',
      },
      { source: 'user', history: 'push' },
    );
    await firstValueFrom(
      h.service.open(
        {
          accountId: ALICE,
          scope: { kind: 'rooms' },
          roomId: null,
          pane: 'list',
        },
        { source: 'user', history: 'push' },
      ),
    );
    h.navigate.mockClear();
    const failed = {
      kind: 'failed',
      accountId: BOB,
      failure: 'account-unavailable',
    } satisfies AccountSwitchOutcome;
    h.switchActiveAccount.mockImplementationOnce((_accountId, coordination) =>
      coordination.prepare().pipe(switchMap(() => of(failed))),
    );

    await expect(firstValueFrom(delayed)).resolves.toMatchObject({
      kind: 'failed',
      failure: 'account-transition-failed',
    });
    expect(h.service.view()).toEqual({
      accountId: ALICE,
      scope: { kind: 'rooms' },
      roomId: null,
      pane: 'list',
    });
    expect(h.navigate).toHaveBeenCalledTimes(2);
    await expect(
      firstValueFrom(
        h.service.open(
          {
            accountId: ALICE,
            scope: { kind: 'recent' },
            roomId: null,
            pane: 'list',
          },
          { source: 'user', history: 'push' },
        ),
      ),
    ).resolves.toMatchObject({ kind: 'ready' });
  });

  it('owns Workspace coordination to completion after Account commit starts', async () => {
    const h = harness({ routeAccountId: ALICE });
    const accountOutcome = new Subject<AccountSwitchOutcome>();
    h.switchActiveAccount.mockImplementationOnce((accountId, coordination) =>
      coordination.prepare().pipe(
        tap(() => coordination.onCommitStarted?.()),
        tap(() => h.activeAccountId.set(accountId)),
        switchMap(() => accountOutcome),
      ),
    );
    const subscription = h.service
      .open(
        {
          accountId: BOB,
          scope: { kind: 'rooms' },
          roomId: ROOM,
          pane: 'conversation',
        },
        { source: 'repair', history: 'replace' },
      )
      .subscribe();

    await vi.waitFor(() => expect(h.activeAccountId()).toBe(BOB));
    subscription.unsubscribe();
    accountOutcome.next({
      kind: 'ready',
      accountId: BOB,
      metrics: {
        durationMs: 4,
        projectionDurationMs: 2,
        projectionCount: 3,
      },
    });
    accountOutcome.complete();

    await vi.waitFor(() => {
      expect(h.service.view()).toEqual({
        accountId: BOB,
        scope: { kind: 'rooms' },
        roomId: ROOM,
        pane: 'conversation',
      });
    });
    expect(h.conversations.focus).toHaveBeenLastCalledWith({
      accountId: BOB,
      roomId: ROOM,
    });
  });

  it('cancels during Account adapter preparation and repairs the projected URL', async () => {
    const h = harness({ routeAccountId: ALICE });
    const adapterPreparation = new Subject<void>();
    h.switchActiveAccount.mockImplementationOnce((accountId, coordination) =>
      coordination.prepare().pipe(
        switchMap(() => adapterPreparation),
        tap(() => coordination.onCommitStarted?.()),
        tap(() => h.activeAccountId.set(accountId)),
        map(() => ({
          kind: 'ready' as const,
          accountId,
          metrics: {
            durationMs: 4,
            projectionDurationMs: 2,
            projectionCount: 3,
          },
        })),
      ),
    );
    const subscription = h.service
      .open(
        {
          accountId: BOB,
          scope: { kind: 'rooms' },
          roomId: ROOM,
          pane: 'conversation',
        },
        { source: 'repair', history: 'replace' },
      )
      .subscribe();

    await vi.waitFor(() => expect(h.navigate).toHaveBeenCalledOnce());
    subscription.unsubscribe();
    adapterPreparation.next();
    adapterPreparation.complete();

    await vi.waitFor(() => expect(h.navigate).toHaveBeenCalledTimes(2));
    expect(h.activeAccountId()).toBe(ALICE);
    expect(h.service.view()).toEqual({
      accountId: ALICE,
      scope: { kind: 'recent' },
      roomId: null,
      pane: 'list',
    });
    expect(h.queryParamMap.value.get('account')).toBe(ALICE);
  });

  it('serializes URL repair when cancelled before Router navigation settles', async () => {
    const h = harness({ routeAccountId: ALICE });
    let resolveProjection!: (navigated: boolean) => void;
    let resolveRepair!: (navigated: boolean) => void;
    const projection = new Promise<boolean>((resolve) => {
      resolveProjection = resolve;
    });
    const repair = new Promise<boolean>((resolve) => {
      resolveRepair = resolve;
    });
    h.navigate
      .mockImplementationOnce(() => projection)
      .mockImplementationOnce((commands, extras) => {
        const segment = commands[1];
        h.paramMap.next(convertToParamMap(segment ? { roomId: segment } : {}));
        h.queryParamMap.next(convertToParamMap(extras?.queryParams ?? {}));
        return repair;
      });
    const cancelled = h.service
      .open(
        {
          accountId: BOB,
          scope: { kind: 'rooms' },
          roomId: ROOM,
          pane: 'conversation',
        },
        { source: 'repair', history: 'replace' },
      )
      .subscribe();

    expect(h.navigate).toHaveBeenCalledOnce();
    cancelled.unsubscribe();
    expect(h.navigate).toHaveBeenCalledTimes(2);
    await expect(
      firstValueFrom(
        h.service.open(
          {
            accountId: ALICE,
            scope: { kind: 'rooms' },
            roomId: null,
            pane: 'list',
          },
          { source: 'user', history: 'push' },
        ),
      ),
    ).resolves.toMatchObject({ kind: 'transition-in-progress' });

    resolveProjection(false);
    resolveRepair(true);
    await repair;
    await Promise.resolve();

    await expect(
      firstValueFrom(
        h.service.open(
          {
            accountId: ALICE,
            scope: { kind: 'rooms' },
            roomId: null,
            pane: 'list',
          },
          { source: 'user', history: 'push' },
        ),
      ),
    ).resolves.toMatchObject({ kind: 'ready' });
    expect(h.activeAccountId()).toBe(ALICE);
    expect(h.queryParamMap.value.get('account')).toBe(ALICE);
  });
});
