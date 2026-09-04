import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { convertToParamMap, type ParamMap } from '@angular/router';
import {
  AccountRuntimeService,
  type AccountSwitchCoordination,
  type AccountSwitchOutcome,
} from '@trinity/data-access/accounts';
import { MediaPipeline } from '@trinity/data-access/media';
import {
  InvitesService,
  RoomLibraryService,
  RoomReadinessService,
  SpacesService,
} from '@trinity/data-access/room-library';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import {
  BehaviorSubject,
  Observable,
  Subject,
  combineLatest,
  defer,
  finalize,
  firstValueFrom,
  from,
  map,
  of,
  switchMap,
  tap,
} from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeRoomSegment } from '@trinity/util/matrix';
import { WorkspaceNavigationService } from './workspace-navigation.service';
import { WorkspaceTransitionWorkflow } from './workspace-transition.workflow';
import { WorkspaceVisitHistoryService } from './workspace-visit-history.service';
import { WorkspaceLocationAdapter } from './workspace-location.adapter';
import { parseWorkspaceUrl, workspaceUrlOf } from './workspace-url';

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
  const locationMode = new BehaviorSubject<'workspace' | 'outside'>(
    'workspace',
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
    (
      commands: readonly string[],
      extras?: { queryParams?: object; replaceUrl?: boolean },
    ) => {
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
    createDirectMessage: vi.fn(() => of('!dm:example.org')),
    selectionAvailability: (accountId: string, roomId: string) => {
      const client = clients.get(accountId);
      if (!client) return 'unavailable' as const;
      return client.getRoom(roomId)
        ? ('available' as const)
        : ('unavailable' as const);
    },
  };
  const spaces = { openSpace: vi.fn(() => of(void 0)) };
  const waitForRoom = vi.fn(() => of(void 0));
  const acceptInvite = vi.fn(() => of(void 0));
  let locationWrites = 0;
  const currentLocation = () =>
    locationMode.value === 'outside'
      ? ({ kind: 'outside' } as const)
      : ({
          kind: 'workspace' as const,
          parsed: parseWorkspaceUrl(
            paramMap.value,
            queryParamMap.value,
            activeAccountId(),
          ),
        } as const);
  const location = {
    get projecting() {
      return locationWrites > 0;
    },
    current: currentLocation,
    changes: () =>
      combineLatest([paramMap, queryParamMap, locationMode]).pipe(
        map(currentLocation),
      ),
    project: (
      destination: Parameters<typeof workspaceUrlOf>[0],
      projectionOptions: {
        readonly history: 'push' | 'replace';
        readonly eventId?: string | null;
      },
    ) =>
      defer(() => {
        locationWrites += 1;
        const projection = workspaceUrlOf(
          destination,
          projectionOptions.eventId,
        );
        return from(
          navigate([...projection.commands], {
            queryParams: { ...projection.queryParams },
            replaceUrl: projectionOptions.history === 'replace',
          }),
        ).pipe(finalize(() => (locationWrites -= 1)));
      }),
  };

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
      WorkspaceNavigationService,
      WorkspaceTransitionWorkflow,
      {
        provide: WorkspaceLocationAdapter,
        useValue: location,
      },
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
        useValue: { waitForRoom },
      },
      { provide: InvitesService, useValue: { acceptInvite } },
      { provide: SpacesService, useValue: spaces },
    ],
  });
  const service = TestBed.inject(WorkspaceNavigationService);
  TestBed.tick();
  return {
    service,
    activeAccountId,
    paramMap,
    queryParamMap,
    locationMode,
    navigate,
    switchActiveAccount,
    conversations,
    media,
    rooms,
    spaces,
    waitForRoom,
    acceptInvite,
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('WorkspaceNavigationService', () => {
  it('canonicalizes a bare route even when its destination matches the active Workspace', async () => {
    const h = harness();

    await vi.waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith(['/rooms'], {
        queryParams: { account: ALICE },
        replaceUrl: true,
      }),
    );
    expect(h.service.view()).toEqual({
      accountId: ALICE,
      scope: { kind: 'recent' },
      roomId: null,
      pane: 'list',
    });
    expect(h.conversations.focus).not.toHaveBeenCalled();
    expect(h.conversations.blur).not.toHaveBeenCalled();
    expect(h.media.releaseAll).not.toHaveBeenCalled();
  });

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

  it('releases projections outside Workspace and restores them on return', async () => {
    const h = harness({ routeAccountId: ALICE, routeRoomId: ROOM });
    h.navigate.mockClear();
    h.conversations.focus.mockClear();
    h.conversations.blur.mockClear();
    h.media.releaseAll.mockClear();

    h.locationMode.next('outside');

    await vi.waitFor(() => expect(h.conversations.blur).toHaveBeenCalledOnce());
    expect(h.media.releaseAll).toHaveBeenCalledOnce();

    h.conversations.focus.mockClear();
    h.locationMode.next('workspace');

    await vi.waitFor(() =>
      expect(h.conversations.focus).toHaveBeenCalledWith({
        accountId: ALICE,
        roomId: ROOM,
      }),
    );
    expect(h.navigate).not.toHaveBeenCalled();
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
    const result = firstValueFrom(
      h.service.navigate({
        kind: 'room',
        accountId: ALICE,
        roomId: ROOM,
        scope: { kind: 'rooms' },
        origin: 'room-list',
      }),
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
      change: 'committed',
    });
    expect(h.service.view()).toMatchObject({
      accountId: ALICE,
      roomId: ROOM,
      pane: 'conversation',
    });
  });

  it('treats selecting the exact active destination as a successful no-op', async () => {
    const h = harness({ routeAccountId: ALICE, routeRoomId: ROOM });
    h.navigate.mockClear();
    h.navigate.mockResolvedValueOnce(false);
    h.conversations.focus.mockClear();
    h.conversations.blur.mockClear();
    h.media.releaseAll.mockClear();

    await expect(
      firstValueFrom(
        h.service.navigate({
          kind: 'room',
          accountId: ALICE,
          roomId: ROOM,
          origin: 'room-list',
        }),
      ),
    ).resolves.toEqual({ kind: 'ready', change: 'unchanged' });
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.conversations.focus).not.toHaveBeenCalled();
    expect(h.conversations.blur).not.toHaveBeenCalled();
    expect(h.media.releaseAll).not.toHaveBeenCalled();
  });

  describe('semantic Room navigation', () => {
    it('resolves an exact Room intent without exposing destination or history policy', async () => {
      const h = harness({ routeAccountId: ALICE });
      h.navigate.mockClear();

      await expect(
        firstValueFrom(
          h.service.navigate({
            kind: 'room',
            accountId: BOB,
            roomId: ROOM,
            origin: 'room-list',
          }),
        ),
      ).resolves.toMatchObject({
        kind: 'ready',
        change: 'committed',
      });
      expect(h.service.view()).toEqual({
        accountId: BOB,
        scope: { kind: 'recent' },
        roomId: ROOM,
        pane: 'conversation',
      });
      expect(h.navigate).toHaveBeenLastCalledWith(
        ['/rooms', encodeRoomSegment(ROOM)],
        {
          queryParams: { account: BOB },
          replaceUrl: false,
        },
      );
    });

    it('keeps exact-current selection unchanged but opens a retained compact Room', async () => {
      const h = harness({
        routeAccountId: ALICE,
        routeRoomId: ROOM,
        compact: true,
      });
      const intent = {
        kind: 'room',
        accountId: ALICE,
        roomId: ROOM,
        origin: 'room-list',
      } as const;
      h.navigate.mockClear();
      h.conversations.focus.mockClear();
      h.conversations.blur.mockClear();
      h.media.releaseAll.mockClear();

      await expect(
        firstValueFrom(h.service.navigate(intent)),
      ).resolves.toMatchObject({
        kind: 'ready',
        change: 'unchanged',
      });
      expect(h.navigate).not.toHaveBeenCalled();
      expect(h.conversations.focus).not.toHaveBeenCalled();
      expect(h.conversations.blur).not.toHaveBeenCalled();
      expect(h.media.releaseAll).not.toHaveBeenCalled();

      await firstValueFrom(
        h.service.navigate({ kind: 'list', origin: 'compact-close' }),
      );
      h.navigate.mockClear();
      h.conversations.focus.mockClear();

      await expect(
        firstValueFrom(h.service.navigate(intent)),
      ).resolves.toMatchObject({
        kind: 'ready',
        change: 'committed',
      });
      expect(h.service.view()).toMatchObject({
        roomId: ROOM,
        pane: 'conversation',
      });
      expect(h.navigate).toHaveBeenCalledOnce();
      expect(h.conversations.focus).toHaveBeenCalledWith({
        accountId: ALICE,
        roomId: ROOM,
      });
    });

    it('is cold, joins an identical intent, and types conflicts', async () => {
      const h = harness({ routeAccountId: ALICE });
      const navigation = new Subject<boolean>();
      h.navigate.mockImplementationOnce(() => firstValueFrom(navigation));
      h.navigate.mockClear();
      const intent = {
        kind: 'room',
        accountId: ALICE,
        roomId: ROOM,
        origin: 'room-list',
      } as const;
      const command = h.service.navigate(intent);

      expect(h.navigate).not.toHaveBeenCalled();
      const first = firstValueFrom(command);
      const joined = firstValueFrom(command);
      await expect(
        firstValueFrom(h.service.navigate({ ...intent, accountId: BOB })),
      ).resolves.toEqual({
        kind: 'unavailable',
        reason: 'transition-in-progress',
      });
      expect(h.navigate).toHaveBeenCalledOnce();

      navigation.next(true);
      navigation.complete();
      await expect(first).resolves.toMatchObject({ kind: 'ready' });
      await expect(joined).resolves.toMatchObject({ kind: 'ready' });
    });

    it('does not join matching destinations with different history policy', async () => {
      const h = harness({ routeAccountId: ALICE, routeRoomId: ROOM });
      const navigation = new Subject<boolean>();
      h.navigate.mockImplementationOnce(() => firstValueFrom(navigation));
      h.navigate.mockClear();

      const close = firstValueFrom(
        h.service.navigate({ kind: 'list', origin: 'compact-close' }),
      );
      await expect(
        firstValueFrom(
          h.service.navigate({ kind: 'list', origin: 'workspace-back' }),
        ),
      ).resolves.toEqual({
        kind: 'unavailable',
        reason: 'transition-in-progress',
      });

      navigation.next(true);
      navigation.complete();
      await expect(close).resolves.toMatchObject({ kind: 'ready' });
    });

    it('returns a typed failure when a different Room location is rejected', async () => {
      const h = harness({ routeAccountId: ALICE });
      h.navigate.mockResolvedValueOnce(false);

      await expect(
        firstValueFrom(
          h.service.navigate({
            kind: 'room',
            accountId: ALICE,
            roomId: ROOM,
            origin: 'room-list',
          }),
        ),
      ).resolves.toMatchObject({
        kind: 'unavailable',
        reason: 'navigation-rejected',
      });
      expect(h.service.view()).toMatchObject({ roomId: null, pane: 'list' });
    });

    it('derives Account and scope destinations inside Workspace', async () => {
      const spaceId = '!space:example.org';
      const h = harness({
        routeAccountId: ALICE,
        rooms: { [ALICE]: [ROOM], [BOB]: [ROOM, spaceId] },
      });
      h.navigate.mockClear();

      await expect(
        firstValueFrom(
          h.service.navigate({
            kind: 'account',
            accountId: BOB,
          }),
        ),
      ).resolves.toMatchObject({ kind: 'ready', change: 'committed' });
      expect(h.service.view()).toEqual({
        accountId: BOB,
        scope: { kind: 'home' },
        roomId: null,
        pane: 'list',
      });

      await expect(
        firstValueFrom(
          h.service.navigate({
            kind: 'scope',
            accountId: BOB,
            scope: { kind: 'space', spaceId },
          }),
        ),
      ).resolves.toMatchObject({ kind: 'ready', change: 'committed' });
      expect(h.service.view()).toEqual({
        accountId: BOB,
        scope: { kind: 'space', spaceId },
        roomId: null,
        pane: 'list',
      });
      expect(h.navigate).toHaveBeenLastCalledWith(['/rooms'], {
        queryParams: { account: BOB, space: encodeRoomSegment(spaceId) },
        replaceUrl: false,
      });
    });

    it('derives invitation scope when the cold command is subscribed', async () => {
      const h = harness({
        routeAccountId: ALICE,
        rooms: { [ALICE]: [ROOM], [BOB]: [ROOM] },
      });
      const invitation = h.service.navigate({
        kind: 'room',
        accountId: ALICE,
        roomId: ROOM,
        origin: 'room-invitation',
      });

      await firstValueFrom(
        h.service.navigate({
          kind: 'scope',
          accountId: ALICE,
          scope: { kind: 'rooms' },
        }),
      );
      await firstValueFrom(invitation);

      expect(h.service.view()).toMatchObject({
        accountId: ALICE,
        scope: { kind: 'rooms' },
        roomId: ROOM,
      });
    });

    it('derives compact close, Workspace Back, and Room-removal history', async () => {
      const h = harness({ routeAccountId: ALICE, routeRoomId: ROOM });
      h.navigate.mockClear();

      await firstValueFrom(
        h.service.navigate({ kind: 'list', origin: 'compact-close' }),
      );
      expect(h.service.view()).toMatchObject({
        roomId: ROOM,
        pane: 'list',
      });
      expect(h.navigate).toHaveBeenLastCalledWith(
        ['/rooms', encodeRoomSegment(ROOM)],
        {
          queryParams: { account: ALICE, pane: 'list' },
          replaceUrl: false,
        },
      );

      await firstValueFrom(
        h.service.navigate({
          kind: 'room',
          accountId: ALICE,
          roomId: ROOM,
          origin: 'room-list',
        }),
      );
      await firstValueFrom(
        h.service.navigate({ kind: 'list', origin: 'workspace-back' }),
      );
      expect(h.navigate).toHaveBeenLastCalledWith(
        ['/rooms', encodeRoomSegment(ROOM)],
        {
          queryParams: { account: ALICE, pane: 'list' },
          replaceUrl: true,
        },
      );

      await firstValueFrom(
        h.service.navigate({ kind: 'list', origin: 'room-removed' }),
      );
      expect(h.service.view()).toMatchObject({ roomId: null, pane: 'list' });
      expect(h.navigate).toHaveBeenLastCalledWith(['/rooms'], {
        queryParams: { account: ALICE },
        replaceUrl: true,
      });
    });

    it('preserves Room-hop MRU policy while recording shortcut navigation', async () => {
      const secondRoom = '!second:example.org';
      const h = harness({
        routeAccountId: ALICE,
        rooms: { [ALICE]: [ROOM, secondRoom], [BOB]: [ROOM] },
      });
      const mru = TestBed.inject(WorkspaceVisitHistoryService);

      await firstValueFrom(
        h.service.navigate({
          kind: 'room',
          accountId: ALICE,
          roomId: ROOM,
          origin: 'room-hop',
        }),
      );
      expect(mru.visited()).toEqual([]);

      await firstValueFrom(
        h.service.navigate({
          kind: 'room',
          accountId: ALICE,
          roomId: secondRoom,
          origin: 'shortcut',
        }),
      );
      expect(mru.visited()).toEqual([{ accountId: ALICE, roomId: secondRoom }]);
    });

    it('resolves visit-history commands behind the semantic interface', async () => {
      const secondRoom = '!second:example.org';
      const h = harness({
        routeAccountId: ALICE,
        rooms: { [ALICE]: [ROOM, secondRoom] },
      });

      await firstValueFrom(
        h.service.navigate({
          kind: 'room',
          accountId: ALICE,
          roomId: ROOM,
          origin: 'shortcut',
        }),
      );
      await firstValueFrom(
        h.service.navigate({
          kind: 'room',
          accountId: ALICE,
          roomId: secondRoom,
          origin: 'shortcut',
        }),
      );

      await expect(
        firstValueFrom(
          h.service.navigate({
            kind: 'history',
            action: 'jump',
            position: 1,
            availableRooms: [
              { accountId: ALICE, roomId: ROOM },
              { accountId: ALICE, roomId: secondRoom },
            ],
          }),
        ),
      ).resolves.toEqual({ kind: 'ready', change: 'committed' });
      expect(h.service.view()).toMatchObject({
        accountId: ALICE,
        roomId: ROOM,
      });
    });

    it('opens exact Conversation and Space search results', async () => {
      const spaceId = '!space:example.org';
      const h = harness({
        routeAccountId: ALICE,
        rooms: { [ALICE]: [ROOM], [BOB]: [ROOM, spaceId] },
      });

      await expect(
        firstValueFrom(
          h.service.navigate({
            kind: 'conversation',
            accountId: BOB,
            roomId: ROOM,
          }),
        ),
      ).resolves.toMatchObject({ kind: 'ready', change: 'committed' });
      expect(h.service.view()).toMatchObject({
        accountId: BOB,
        roomId: ROOM,
      });

      await firstValueFrom(
        h.service.navigate({
          kind: 'space',
          accountId: BOB,
          spaceId,
        }),
      );
      expect(h.service.view()).toMatchObject({
        accountId: BOB,
        scope: { kind: 'space', spaceId },
      });
    });

    it('prepares an exact Account before creating and opening a direct Conversation', async () => {
      const dm = '!dm:example.org';
      const h = harness({
        routeAccountId: ALICE,
        rooms: { [ALICE]: [ROOM], [BOB]: [ROOM, dm] },
      });
      h.navigate.mockClear();

      await expect(
        firstValueFrom(
          h.service.navigate({
            kind: 'person',
            accountId: BOB,
            userId: '@person:example.org',
          }),
        ),
      ).resolves.toMatchObject({ kind: 'ready', change: 'committed' });

      expect(h.rooms.createDirectMessage).toHaveBeenCalledWith(
        '@person:example.org',
      );
      expect(h.waitForRoom).toHaveBeenCalledWith(BOB, dm);
      expect(h.service.view()).toEqual({
        accountId: BOB,
        scope: { kind: 'home' },
        roomId: dm,
        pane: 'conversation',
      });
      expect(h.navigate).toHaveBeenNthCalledWith(1, ['/rooms'], {
        queryParams: { account: BOB, view: 'home' },
        replaceUrl: true,
      });
      expect(h.navigate).toHaveBeenNthCalledWith(
        2,
        ['/rooms', encodeRoomSegment(dm)],
        {
          queryParams: { account: BOB, view: 'home' },
          replaceUrl: false,
        },
      );
    });

    it('joins an invitation before opening its exact Account destination', async () => {
      const invitedSpace = '!invited-space:example.org';
      const h = harness({
        routeAccountId: ALICE,
        rooms: { [ALICE]: [ROOM], [BOB]: [ROOM, invitedSpace] },
      });

      await firstValueFrom(
        h.service.navigate({
          kind: 'invitation',
          accountId: BOB,
          roomId: invitedSpace,
          target: 'space',
        }),
      );

      expect(h.acceptInvite).toHaveBeenCalledWith(invitedSpace, BOB);
      expect(h.waitForRoom).toHaveBeenCalledWith(BOB, invitedSpace);
      expect(h.service.view()).toMatchObject({
        accountId: BOB,
        scope: { kind: 'space', spaceId: invitedSpace },
      });
    });

    it('projects and republishes a same-Room notification event target', async () => {
      const h = harness({ routeAccountId: ALICE, routeRoomId: ROOM });
      h.navigate.mockClear();
      h.conversations.focus.mockClear();

      await firstValueFrom(
        h.service.navigate({
          kind: 'notification',
          accountId: ALICE,
          roomId: ROOM,
          eventId: '$event',
        }),
      );
      const firstTarget = h.service.eventTarget();
      expect(firstTarget).toEqual({ eventId: '$event' });
      expect(h.navigate).toHaveBeenCalledWith(
        ['/rooms', encodeRoomSegment(ROOM)],
        {
          queryParams: { account: ALICE, event: '$event' },
          replaceUrl: false,
        },
      );

      h.navigate.mockClear();
      await firstValueFrom(
        h.service.navigate({
          kind: 'notification',
          accountId: ALICE,
          roomId: ROOM,
          eventId: '$event',
        }),
      );
      expect(h.service.eventTarget()).toEqual({ eventId: '$event' });
      expect(h.service.eventTarget()).not.toBe(firstTarget);
      expect(h.navigate).not.toHaveBeenCalled();
      expect(h.conversations.focus).not.toHaveBeenCalled();
    });

    it('repairs an unavailable notification through normal Workspace policy', async () => {
      const h = harness({ routeAccountId: ALICE });
      h.navigate.mockClear();

      await expect(
        firstValueFrom(
          h.service.navigate({
            kind: 'notification',
            accountId: BOB,
            roomId: '!missing:example.org',
            eventId: '$event',
          }),
        ),
      ).resolves.toMatchObject({ kind: 'ready', change: 'committed' });
      expect(h.service.view()).toMatchObject({
        accountId: BOB,
        roomId: null,
        pane: 'list',
      });
      expect(h.service.eventTarget()).toBeNull();
      expect(h.navigate).toHaveBeenLastCalledWith(['/rooms'], {
        queryParams: { account: BOB },
        replaceUrl: true,
      });
    });
  });

  it('transitions when selecting a different pane for the active Room', async () => {
    const h = harness({ routeAccountId: ALICE, routeRoomId: ROOM });
    h.navigate.mockClear();

    await expect(
      firstValueFrom(
        h.service.navigate({ kind: 'list', origin: 'compact-close' }),
      ),
    ).resolves.toMatchObject({
      kind: 'ready',
      change: 'committed',
    });
    expect(h.service.view()).toMatchObject({
      accountId: ALICE,
      roomId: ROOM,
      pane: 'list',
    });
    expect(h.navigate).toHaveBeenCalledOnce();
  });

  it('repairs a missing room to the list and replaces malformed history', async () => {
    const h = harness({ routeAccountId: ALICE });
    h.navigate.mockClear();

    await expect(
      firstValueFrom(
        h.service.navigate({
          kind: 'restoration',
          accountId: ALICE,
          scope: { kind: 'home' },
          roomId: '!missing:example.org',
          pane: 'conversation',
          canonical: false,
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'ready',
      change: 'committed',
    });
    expect(h.service.view()).toEqual({
      accountId: ALICE,
      scope: { kind: 'home' },
      roomId: null,
      pane: 'list',
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
        h.service.navigate({
          kind: 'room',
          accountId: ALICE,
          roomId: ROOM,
          scope: { kind: 'space', spaceId: '!space:example.org' },
          origin: 'room-action',
        }),
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
    const command = h.service.navigate({
      kind: 'room',
      accountId: ALICE,
      roomId: ROOM,
      origin: 'room-list',
    });

    expect(h.navigate).not.toHaveBeenCalled();
    const first = firstValueFrom(command);
    const joined = firstValueFrom(command);
    await expect(
      firstValueFrom(
        h.service.navigate({ kind: 'list', origin: 'compact-close' }),
      ),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'transition-in-progress',
    });
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
        h.service.navigate({
          kind: 'account',
          accountId: '@missing:example.org',
        }),
      ),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'account-transition-failed',
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
        h.service.navigate({
          kind: 'room',
          accountId: BOB,
          roomId: ROOM,
          scope: { kind: 'rooms' },
          origin: 'room-list',
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'navigation-rejected',
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
    const delayed = h.service.navigate({ kind: 'account', accountId: BOB });
    await firstValueFrom(
      h.service.navigate({
        kind: 'scope',
        accountId: ALICE,
        scope: { kind: 'rooms' },
      }),
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
      kind: 'unavailable',
      reason: 'account-transition-failed',
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
        h.service.navigate({
          kind: 'scope',
          accountId: ALICE,
          scope: { kind: 'recent' },
        }),
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
      .navigate({
        kind: 'restoration',
        accountId: BOB,
        scope: { kind: 'rooms' },
        roomId: ROOM,
        pane: 'conversation',
        canonical: false,
      })
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
      .navigate({
        kind: 'restoration',
        accountId: BOB,
        scope: { kind: 'rooms' },
        roomId: ROOM,
        pane: 'conversation',
        canonical: false,
      })
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
      .navigate({
        kind: 'restoration',
        accountId: BOB,
        scope: { kind: 'rooms' },
        roomId: ROOM,
        pane: 'conversation',
        canonical: false,
      })
      .subscribe();

    expect(h.navigate).toHaveBeenCalledOnce();
    cancelled.unsubscribe();
    expect(h.navigate).toHaveBeenCalledTimes(2);
    await expect(
      firstValueFrom(
        h.service.navigate({
          kind: 'scope',
          accountId: ALICE,
          scope: { kind: 'rooms' },
        }),
      ),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'transition-in-progress',
    });

    resolveProjection(false);
    resolveRepair(true);
    await repair;
    await Promise.resolve();

    await expect(
      firstValueFrom(
        h.service.navigate({
          kind: 'scope',
          accountId: ALICE,
          scope: { kind: 'rooms' },
        }),
      ),
    ).resolves.toMatchObject({ kind: 'ready' });
    expect(h.activeAccountId()).toBe(ALICE);
    expect(h.queryParamMap.value.get('account')).toBe(ALICE);
  });
});
