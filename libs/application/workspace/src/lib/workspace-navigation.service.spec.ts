import { signal, type WritableSignal } from '@angular/core';
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
  SelectedRoomLibraryService,
  SpacesService,
} from '@trinity/data-access/room-library';
import {
  CONVERSATION_ATTENTION,
  ConversationRuntime,
} from '@trinity/data-access/timeline';
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
import type { WorkspaceNavigationScope } from './workspace-navigation.models';
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
  readonly routeSpaceId?: string;
  readonly routeEventId?: string;
  readonly rooms?: Readonly<Record<string, readonly string[]>>;
  readonly compact?: boolean;
  /** The mixed view: its selected Accounts, and the Spaces any of them has joined. */
  readonly mixed?: {
    readonly accountIds: readonly string[];
    readonly spaceIds: readonly string[];
  };
  /** Conversations' attention port (App lock); absent means only the Workspace decides. */
  readonly attentive?: WritableSignal<boolean>;
  /** Accounts whose client has synced with its homeserver; every live one unless named. */
  readonly synced?: readonly string[];
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
      ...(options.routeSpaceId
        ? { space: encodeRoomSegment(options.routeSpaceId) }
        : {}),
      ...(options.routeEventId ? { event: options.routeEventId } : {}),
    }),
  );
  const locationMode = new BehaviorSubject<'workspace' | 'outside'>(
    'workspace',
  );
  // What each live client holds, Rooms and Spaces alike; a test changes it as a sync would.
  const held = signal<Readonly<Record<string, readonly string[]>>>(
    options.rooms ?? {
      [ALICE]: [ROOM],
      [BOB]: [ROOM],
    },
  );
  const clients = new Map(
    Object.keys(held()).map((accountId) => [
      accountId,
      {
        getRoom: (roomId: string) =>
          held()[accountId]?.includes(roomId) ? { roomId } : null,
      },
    ]),
  );
  const synced = signal<ReadonlySet<string>>(
    new Set(options.synced ?? clients.keys()),
  );
  const mixed = signal(options.mixed ?? null);
  const leaving = signal<ReadonlySet<string>>(new Set());
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
      if (!client || !roomId.startsWith('!')) return 'unavailable' as const;
      return client.getRoom(roomId)
        ? ('available' as const)
        : ('unconfirmed' as const);
    },
  };
  // SelectedRoomLibraryService's rule: held by the Account, or listed in its mixed view; else
  // unconfirmed until the Account has synced (the others count as having loaded their cache).
  const selectedRooms = {
    spaceAvailability: (accountId: string, spaceId: string) => {
      if (!clients.has(accountId) || !spaceId.startsWith('!')) {
        return 'unavailable' as const;
      }
      const view = mixed();
      const shown =
        view && view.accountIds.includes(accountId)
          ? view.accountIds
          : [accountId];
      if (
        rooms.selectionAvailability(accountId, spaceId) === 'available' ||
        (shown.length > 1 && !!view?.spaceIds.includes(spaceId))
      ) {
        return 'available' as const;
      }
      return synced().has(accountId)
        ? ('unavailable' as const)
        : ('unconfirmed' as const);
    },
  };
  const spaces = {
    openSpace: vi.fn((_spaceId: string | null): Observable<void> => of(void 0)),
    isLeaving: (accountId: string, spaceId: string) =>
      leaving().has(`${accountId} ${spaceId}`),
  };
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
  const listBelow = signal(false);
  // A Router navigation Workspace did not start, such as one to Settings, still resolving.
  const routerNavigating = signal(false);
  const projections: {
    readonly history: 'push' | 'replace' | 'back';
    readonly overList?: boolean;
    readonly background?: boolean;
  }[] = [];
  const popHistory = vi.fn();
  const location = {
    listBelow: listBelow.asReadonly(),
    navigating: routerNavigating.asReadonly(),
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
        readonly history: 'push' | 'replace' | 'back';
        readonly overList?: boolean;
        readonly eventId?: string | null;
        readonly background?: boolean;
      },
    ) =>
      defer(() => {
        projections.push({
          history: projectionOptions.history,
          overList: projectionOptions.overList,
          ...(projectionOptions.background ? { background: true } : {}),
        });
        if (projectionOptions.history === 'back') {
          popHistory();
          return of(true);
        }
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
      { provide: SelectedRoomLibraryService, useValue: selectedRooms },
      {
        provide: RoomReadinessService,
        useValue: { waitForRoom },
      },
      { provide: InvitesService, useValue: { acceptInvite } },
      { provide: SpacesService, useValue: spaces },
      ...(options.attentive
        ? [
            {
              provide: CONVERSATION_ATTENTION,
              useValue: { attentive: options.attentive.asReadonly() },
            },
          ]
        : []),
    ],
  });
  const service = TestBed.inject(WorkspaceNavigationService);
  TestBed.tick();
  return {
    service,
    listBelow,
    projections,
    popHistory,
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
    held,
    synced,
    mixed,
    leaving,
    routerNavigating,
  };
}

/** Let effects, Router promises and Workspace commits settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** The client of `accountId` no longer holds `roomId`, as after a sync dropping it. */
function drop(
  h: ReturnType<typeof harness>,
  accountId: string,
  roomId: string,
): void {
  h.held.update((held) => ({
    ...held,
    [accountId]: (held[accountId] ?? []).filter((id) => id !== roomId),
  }));
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

  it('keeps a notification for a room the live Account has not synced yet', async () => {
    const h = harness({
      routeAccountId: BOB,
      routeRoomId: '!missing:example.org',
      routeEventId: '$notification',
    });

    await vi.waitFor(() => expect(h.service.view().accountId).toBe(BOB));
    expect(h.service.view()).toMatchObject({
      roomId: '!missing:example.org',
      pane: 'conversation',
    });
    // The anchor must survive for a room the client has yet to hold: the list jumps to it
    // once the room loads.
    expect(h.service.eventTarget()).toMatchObject({ eventId: '$notification' });
  });

  it('repairs a room alias segment to the list', async () => {
    const h = harness({
      routeAccountId: ALICE,
      routeRoomId: '#alias:example.org',
    });

    await vi.waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith(['/rooms'], {
        queryParams: { account: ALICE },
        replaceUrl: true,
      }),
    );
    expect(h.service.view()).toMatchObject({ roomId: null, pane: 'list' });
  });

  it('repairs a room on an Account whose client is not live to the list', async () => {
    const h = harness({
      routeAccountId: ALICE,
      rooms: { [ALICE]: [ROOM] },
    });
    h.navigate.mockClear();

    await firstValueFrom(
      h.service.navigate({
        kind: 'restoration',
        accountId: ALICE,
        scope: { kind: 'recent' },
        roomId: ROOM,
        pane: 'conversation',
        canonical: false,
      }),
    );
    h.activeAccountId.set(BOB);
    h.navigate.mockClear();
    await firstValueFrom(
      h.service.navigate({
        kind: 'restoration',
        accountId: BOB,
        scope: { kind: 'recent' },
        roomId: ROOM,
        pane: 'conversation',
        canonical: false,
      }),
    );
    expect(h.service.view()).toMatchObject({ roomId: null, pane: 'list' });
    expect(h.navigate).toHaveBeenLastCalledWith(['/rooms'], {
      queryParams: { account: BOB },
      replaceUrl: true,
    });
  });

  it('clears a restored room’s marked-unread flag as it opens', async () => {
    const h = harness({ routeAccountId: ALICE, routeRoomId: ROOM });

    await vi.waitFor(() =>
      expect(h.rooms.clearMarkedUnread).toHaveBeenCalledExactlyOnceWith(ROOM),
    );
  });

  it('keeps a restored room’s marked-unread flag behind App lock until unlock', async () => {
    const attentive = signal(false);
    const h = harness({ routeAccountId: ALICE, routeRoomId: ROOM, attentive });
    await vi.waitFor(() =>
      expect(h.conversations.focus).toHaveBeenCalledWith({
        accountId: ALICE,
        roomId: ROOM,
      }),
    );
    TestBed.tick();
    expect(h.rooms.clearMarkedUnread).not.toHaveBeenCalled();

    attentive.set(true);
    TestBed.tick();
    expect(h.rooms.clearMarkedUnread).toHaveBeenCalledExactlyOnceWith(ROOM);
  });

  it('does not clear the flag of a room left before unlock', async () => {
    const attentive = signal(false);
    const h = harness({ routeAccountId: ALICE, routeRoomId: ROOM, attentive });
    await vi.waitFor(() => expect(h.conversations.focus).toHaveBeenCalled());

    h.paramMap.next(convertToParamMap({}));
    h.queryParamMap.next(convertToParamMap({ account: ALICE }));
    await vi.waitFor(() =>
      expect(h.service.view()).toMatchObject({ roomId: null }),
    );
    attentive.set(true);
    TestBed.tick();

    expect(h.rooms.clearMarkedUnread).not.toHaveBeenCalled();
  });

  it('seeds a cold start naming an unconfirmed room on the active Account', async () => {
    const h = harness({
      routeAccountId: ALICE,
      routeRoomId: '!pending:example.org',
    });

    expect(h.service.view()).toMatchObject({
      accountId: ALICE,
      roomId: '!pending:example.org',
    });
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

    describe('in the mixed view', () => {
      const SPACE = '!space:example.org';
      // ALICE holds the space; BOB holds only the room the space lists.
      const mixed = { accountIds: [ALICE, BOB], spaceIds: [SPACE] };
      const rooms = { [ALICE]: [SPACE], [BOB]: [ROOM] };

      it('keeps a space another selected Account holds when opening its room as BOB (#1369)', async () => {
        const h = harness({ routeAccountId: ALICE, rooms, mixed });
        await firstValueFrom(
          h.service.navigate({
            kind: 'scope',
            accountId: ALICE,
            scope: { kind: 'space', spaceId: SPACE },
          }),
        );

        await expect(
          firstValueFrom(
            h.service.navigate({
              kind: 'room',
              accountId: BOB,
              roomId: ROOM,
              origin: 'room-list',
            }),
          ),
        ).resolves.toMatchObject({ kind: 'ready', change: 'committed' });
        expect(h.switchActiveAccount).toHaveBeenCalledWith(
          BOB,
          expect.anything(),
        );
        expect(h.service.view()).toEqual({
          accountId: BOB,
          scope: { kind: 'space', spaceId: SPACE },
          roomId: ROOM,
          pane: 'conversation',
        });
        expect(h.navigate).toHaveBeenLastCalledWith(
          ['/rooms', encodeRoomSegment(ROOM)],
          {
            queryParams: { account: BOB, space: encodeRoomSegment(SPACE) },
            replaceUrl: false,
          },
        );
      });

      it('restores that space and room on BOB while ALICE still holds the space', async () => {
        const h = harness({
          accountId: BOB,
          routeAccountId: BOB,
          routeSpaceId: SPACE,
          routeRoomId: ROOM,
          rooms,
          mixed,
        });

        await vi.waitFor(() =>
          expect(h.conversations.focus).toHaveBeenCalled(),
        );
        expect(h.service.view()).toEqual({
          accountId: BOB,
          scope: { kind: 'space', spaceId: SPACE },
          roomId: ROOM,
          pane: 'conversation',
        });
      });

      it('repairs the space to Recent, keeping the room, once no selected Account holds it', async () => {
        const h = harness({
          accountId: BOB,
          routeAccountId: BOB,
          routeSpaceId: SPACE,
          routeRoomId: ROOM,
          rooms,
          mixed: { accountIds: [BOB], spaceIds: [] },
        });

        await vi.waitFor(() =>
          expect(h.service.view()).toEqual({
            accountId: BOB,
            scope: { kind: 'recent' },
            roomId: ROOM,
            pane: 'conversation',
          }),
        );
      });

      it('returns BOB to Recent with his room once the Account holding the space is unticked (#1402)', async () => {
        const h = harness({
          accountId: BOB,
          routeAccountId: BOB,
          routeSpaceId: SPACE,
          routeRoomId: ROOM,
          rooms,
          mixed,
        });
        await vi.waitFor(() =>
          expect(h.service.view().scope).toEqual({
            kind: 'space',
            spaceId: SPACE,
          }),
        );
        h.navigate.mockClear();

        h.mixed.set({ accountIds: [BOB], spaceIds: [] });

        await vi.waitFor(() => {
          TestBed.tick();
          expect(h.service.view()).toEqual({
            accountId: BOB,
            scope: { kind: 'recent' },
            roomId: ROOM,
            pane: 'conversation',
          });
        });
        expect(h.navigate).toHaveBeenCalledExactlyOnceWith(
          ['/rooms', encodeRoomSegment(ROOM)],
          { queryParams: { account: BOB }, replaceUrl: true },
        );
      });
    });

    // SpacesService.openSpace can wait for the Account to join the space; that wait is a
    // lifetime, owned by the committed view rather than finishing on its own.
    it('holds the open space for the committed view only: a new view, leaving Workspace and teardown end it', async () => {
      const SPACE = '!space:example.org';
      const h = harness({
        routeAccountId: ALICE,
        rooms: { [ALICE]: [ROOM, SPACE], [BOB]: [ROOM] },
      });
      await settle();
      const lifetimes: { spaceId: string | null; ended: boolean }[] = [];
      h.spaces.openSpace.mockImplementation(
        (spaceId) =>
          new Observable<void>(() => {
            const lifetime = { spaceId, ended: false };
            lifetimes.push(lifetime);
            return () => (lifetime.ended = true);
          }),
      );
      const open = (scope: WorkspaceNavigationScope) =>
        firstValueFrom(
          h.service.navigate({ kind: 'scope', accountId: ALICE, scope }),
        );

      await open({ kind: 'space', spaceId: SPACE });
      expect(lifetimes).toEqual([{ spaceId: SPACE, ended: false }]);

      await open({ kind: 'recent' });
      expect(lifetimes[0].ended).toBe(true);
      await open({ kind: 'space', spaceId: SPACE });
      expect(lifetimes.at(-1)).toEqual({ spaceId: SPACE, ended: false });

      h.locationMode.next('outside');
      await settle();
      expect(lifetimes.at(-1)?.ended).toBe(true);

      h.locationMode.next('workspace');
      await settle();
      expect(lifetimes.at(-1)).toEqual({ spaceId: SPACE, ended: false });

      TestBed.resetTestingModule();
      expect(lifetimes.every((lifetime) => lifetime.ended)).toBe(true);
    });

    describe('a space its Account has not synced yet (#1401)', () => {
      const SPACE = '!space:example.org';
      const restored = {
        routeAccountId: ALICE,
        routeSpaceId: SPACE,
        routeRoomId: ROOM,
        rooms: { [ALICE]: [ROOM], [BOB]: [ROOM] },
        synced: [BOB],
      } as const;
      const inSpace = {
        accountId: ALICE,
        scope: { kind: 'space', spaceId: SPACE },
        roomId: ROOM,
        pane: 'conversation',
      } as const;

      it('seeds a cold start naming an unconfirmed space', () => {
        const h = harness(restored);

        expect(h.service.view()).toEqual(inSpace);
      });

      it('keeps a restored space its Account has not confirmed, with its room, writing no URL', async () => {
        const h = harness(restored);

        await vi.waitFor(() =>
          expect(h.conversations.focus).toHaveBeenCalledWith({
            accountId: ALICE,
            roomId: ROOM,
          }),
        );
        await settle();
        expect(h.service.view()).toEqual(inSpace);
        expect(h.navigate).not.toHaveBeenCalled();
        expect(h.spaces.openSpace).toHaveBeenLastCalledWith(SPACE);
      });

      it('keeps it once the Account syncs and holds it', async () => {
        const h = harness(restored);
        await settle();

        h.held.update((held) => ({ ...held, [ALICE]: [ROOM, SPACE] }));
        h.synced.set(new Set([ALICE, BOB]));
        await settle();

        expect(h.service.view()).toEqual(inSpace);
        expect(h.navigate).not.toHaveBeenCalled();
      });

      it('falls back to Recent once synced without it, keeping the room, replacing history, recording no visit', async () => {
        const h = harness(restored);
        await settle();
        const record = vi.spyOn(
          TestBed.inject(WorkspaceVisitHistoryService),
          'record',
        );

        h.synced.set(new Set([ALICE, BOB]));

        await vi.waitFor(() => {
          TestBed.tick();
          expect(h.service.view()).toEqual({
            ...inSpace,
            scope: { kind: 'recent' },
          });
        });
        expect(h.navigate).toHaveBeenCalledExactlyOnceWith(
          ['/rooms', encodeRoomSegment(ROOM)],
          { queryParams: { account: ALICE }, replaceUrl: true },
        );
        expect(record).not.toHaveBeenCalled();
        expect(h.conversations.focus).toHaveBeenLastCalledWith({
          accountId: ALICE,
          roomId: ROOM,
        });
      });
    });

    describe('a selected space that disappears (#1402)', () => {
      const SPACE = '!space:example.org';
      const OTHER = '!other:example.org';
      const rooms = { [ALICE]: [ROOM, OTHER, SPACE], [BOB]: [ROOM] };

      async function openInSpace(h: ReturnType<typeof harness>) {
        await firstValueFrom(
          h.service.navigate({
            kind: 'room',
            accountId: ALICE,
            roomId: ROOM,
            scope: { kind: 'space', spaceId: SPACE },
            origin: 'room-action',
          }),
        );
        await settle();
        h.navigate.mockClear();
      }

      it('returns the rail to Recent and keeps the open room, replacing history', async () => {
        const h = harness({ routeAccountId: ALICE, rooms });
        await openInSpace(h);

        drop(h, ALICE, SPACE);

        await vi.waitFor(() => {
          TestBed.tick();
          expect(h.service.view()).toEqual({
            accountId: ALICE,
            scope: { kind: 'recent' },
            roomId: ROOM,
            pane: 'conversation',
          });
        });
        expect(h.navigate).toHaveBeenCalledExactlyOnceWith(
          ['/rooms', encodeRoomSegment(ROOM)],
          { queryParams: { account: ALICE }, replaceUrl: true },
        );
      });

      // The person did not make this navigation, so it must not move their focus.
      it('projects its repair as a background navigation, unlike a navigation the person made', async () => {
        const h = harness({ routeAccountId: ALICE, rooms });
        await openInSpace(h);
        expect(h.projections.at(-1)).toEqual({
          history: 'push',
          overList: false,
        });

        drop(h, ALICE, SPACE);

        await vi.waitFor(() => {
          TestBed.tick();
          expect(h.service.view().scope).toEqual({ kind: 'recent' });
        });
        expect(h.projections.at(-1)).toEqual({
          history: 'replace',
          overList: false,
          background: true,
        });
      });

      it('does not repair while the space is unconfirmed', async () => {
        const h = harness({ routeAccountId: ALICE, rooms });
        await openInSpace(h);

        // A replacement client that has only replayed a cache without the space.
        h.synced.set(new Set([BOB]));
        drop(h, ALICE, SPACE);
        await settle();

        expect(h.service.view().scope).toEqual({
          kind: 'space',
          spaceId: SPACE,
        });
        expect(h.navigate).not.toHaveBeenCalled();
      });

      /** Open OTHER from the space's list, its Router navigation held until `finish`. */
      function openHeld(h: ReturnType<typeof harness>) {
        const project = h.navigate.getMockImplementation()!;
        let finish!: (navigated: boolean) => void;
        h.navigate.mockImplementationOnce((commands, extras) => {
          void project(commands, extras);
          return new Promise<boolean>((resolve) => (finish = resolve));
        });
        const opened = firstValueFrom(
          h.service.navigate({
            kind: 'room',
            accountId: ALICE,
            roomId: OTHER,
            origin: 'room-list',
          }),
        );
        return { opened, finish: (navigated: boolean) => finish(navigated) };
      }

      it('does not repair mid-transition, and checks the view it commits', async () => {
        const h = harness({ routeAccountId: ALICE, rooms });
        await openInSpace(h);
        const open = openHeld(h);

        drop(h, ALICE, SPACE);
        await settle();
        expect(h.navigate).toHaveBeenCalledOnce();
        expect(h.service.view().roomId).toBe(ROOM);

        open.finish(true);
        await open.opened;
        await vi.waitFor(() => {
          TestBed.tick();
          expect(h.service.view()).toEqual({
            accountId: ALICE,
            scope: { kind: 'recent' },
            roomId: OTHER,
            pane: 'conversation',
          });
        });
        expect(h.navigate).toHaveBeenCalledTimes(2);
      });

      it('checks the view again once a transition that did not commit settles', async () => {
        const h = harness({ routeAccountId: ALICE, rooms });
        await openInSpace(h);
        const open = openHeld(h);

        drop(h, ALICE, SPACE);
        await settle();
        open.finish(false);
        await open.opened;

        await vi.waitFor(() => {
          TestBed.tick();
          expect(h.service.view()).toEqual({
            accountId: ALICE,
            scope: { kind: 'recent' },
            roomId: ROOM,
            pane: 'conversation',
          });
        });
      });

      // Repairing would cancel that navigation and land the person on Recent instead.
      it('does not repair while a navigation the person started is in flight, and checks again once it settles', async () => {
        const h = harness({ routeAccountId: ALICE, rooms });
        await openInSpace(h);

        h.routerNavigating.set(true);
        drop(h, ALICE, SPACE);
        await settle();
        expect(h.navigate).not.toHaveBeenCalled();
        expect(h.service.view().scope).toEqual({
          kind: 'space',
          spaceId: SPACE,
        });

        h.routerNavigating.set(false);

        await vi.waitFor(() => {
          TestBed.tick();
          expect(h.service.view()).toEqual({
            accountId: ALICE,
            scope: { kind: 'recent' },
            roomId: ROOM,
            pane: 'conversation',
          });
        });
      });

      it("does not repair a space this app is leaving; the leave flow's Home is the only navigation", async () => {
        const h = harness({ routeAccountId: ALICE, rooms });
        await openInSpace(h);

        h.leaving.set(new Set([`${ALICE} ${SPACE}`]));
        drop(h, ALICE, SPACE);
        await settle();
        expect(h.navigate).not.toHaveBeenCalled();

        // What the leave flow does once its request settles: navigate, then clear the mark.
        const home = firstValueFrom(
          h.service.navigate({
            kind: 'scope',
            accountId: ALICE,
            scope: { kind: 'home' },
          }),
        );
        h.leaving.set(new Set());
        await home;
        await settle();

        expect(h.service.view().scope).toEqual({ kind: 'home' });
        expect(h.navigate).toHaveBeenCalledOnce();
      });

      it('does not repair outside Workspace; the return repairs through restoration', async () => {
        const h = harness({ routeAccountId: ALICE, rooms });
        await openInSpace(h);

        h.locationMode.next('outside');
        drop(h, ALICE, SPACE);
        await settle();
        expect(h.navigate).not.toHaveBeenCalled();

        h.locationMode.next('workspace');

        await vi.waitFor(() =>
          expect(h.service.view()).toEqual({
            accountId: ALICE,
            scope: { kind: 'recent' },
            roomId: ROOM,
            pane: 'conversation',
          }),
        );
        expect(h.navigate).toHaveBeenCalledExactlyOnceWith(
          ['/rooms', encodeRoomSegment(ROOM)],
          { queryParams: { account: ALICE }, replaceUrl: true },
        );
      });

      it('does not repair for an Account that is not the active one', async () => {
        const h = harness({ routeAccountId: ALICE, rooms });
        await openInSpace(h);

        // An Account switch or sign-out moves the active Account before Workspace commits.
        h.activeAccountId.set(BOB);
        drop(h, ALICE, SPACE);
        await settle();

        expect(h.service.view().scope).toEqual({
          kind: 'space',
          spaceId: SPACE,
        });
        expect(h.navigate).not.toHaveBeenCalled();
      });

      it('makes one attempt per committed view when the Router rejects the repair', async () => {
        const h = harness({ routeAccountId: ALICE, rooms });
        await openInSpace(h);
        h.navigate.mockImplementation(() => Promise.resolve(false));

        drop(h, ALICE, SPACE);
        await settle();
        expect(h.navigate).toHaveBeenCalledOnce();

        // Unconfirmed, then unavailable again: the same committed view is not retried.
        h.synced.set(new Set([BOB]));
        await settle();
        h.synced.set(new Set([ALICE, BOB]));
        await settle();

        expect(h.navigate).toHaveBeenCalledOnce();
        expect(h.service.view().scope).toEqual({
          kind: 'space',
          spaceId: SPACE,
        });
      });

      it('keeps the open room when a navigation names a space no Account holds', async () => {
        const h = harness({ routeAccountId: ALICE, routeRoomId: ROOM, rooms });
        await settle();

        await expect(
          firstValueFrom(
            h.service.navigate({
              kind: 'scope',
              accountId: ALICE,
              scope: { kind: 'space', spaceId: '!gone:example.org' },
            }),
          ),
        ).resolves.toMatchObject({ kind: 'ready', change: 'committed' });
        expect(h.service.view()).toEqual({
          accountId: ALICE,
          scope: { kind: 'recent' },
          roomId: ROOM,
          pane: 'conversation',
        });
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

      // No list below this Conversation (a reload): the list replaces it, so it is not one
      // history step behind the list (#1113).
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
          replaceUrl: true,
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

    it('pushes a Room opened from its list over that list, and only then', async () => {
      const h = harness({ routeAccountId: ALICE, compact: true });

      await firstValueFrom(
        h.service.navigate({
          kind: 'room',
          accountId: ALICE,
          roomId: ROOM,
          origin: 'room-list',
        }),
      );
      expect(h.projections.at(-1)).toEqual({ history: 'push', overList: true });

      // From a Conversation, the entry below is not the list.
      await firstValueFrom(
        h.service.navigate({
          kind: 'room',
          accountId: ALICE,
          roomId: '!other:example.org',
          origin: 'room-list',
        }),
      );
      expect(h.projections.at(-1)).toEqual({
        history: 'push',
        overList: false,
      });
    });

    it('opens a Room in split view without marking it over the list', async () => {
      const h = harness({ routeAccountId: ALICE });

      await firstValueFrom(
        h.service.navigate({
          kind: 'room',
          accountId: ALICE,
          roomId: ROOM,
          origin: 'room-list',
        }),
      );

      expect(h.projections.at(-1)).toEqual({
        history: 'push',
        overList: false,
      });
    });

    it.each(['compact-close', 'workspace-back'] as const)(
      'pops a Conversation pushed over its list on %s',
      async (origin) => {
        const h = harness({ routeAccountId: ALICE, routeRoomId: ROOM });
        h.listBelow.set(true);
        h.navigate.mockClear();

        await firstValueFrom(h.service.navigate({ kind: 'list', origin }));

        expect(h.projections.at(-1)?.history).toBe('back');
        expect(h.popHistory).toHaveBeenCalledOnce();
        expect(h.navigate).not.toHaveBeenCalled();
        expect(h.service.view()).toMatchObject({ roomId: ROOM, pane: 'list' });
      },
    );

    it('reports a Conversation over its list only while one is in view', async () => {
      const h = harness({ routeAccountId: ALICE, routeRoomId: ROOM });
      expect(h.service.conversationOverList()).toBe(false);
      h.listBelow.set(true);
      expect(h.service.conversationOverList()).toBe(true);

      await firstValueFrom(
        h.service.navigate({ kind: 'list', origin: 'compact-close' }),
      );
      expect(h.service.conversationOverList()).toBe(false);
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

    it('keeps an unsynced notification room through normal Workspace policy', async () => {
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
        roomId: '!missing:example.org',
        pane: 'conversation',
      });
      expect(h.conversations.focus).toHaveBeenLastCalledWith(
        expect.objectContaining({ roomId: '!missing:example.org' }),
      );
      expect(h.service.eventTarget()).toMatchObject({ eventId: '$event' });
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

  it('keeps an unsynced room and replaces malformed history', async () => {
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
      roomId: '!missing:example.org',
      pane: 'conversation',
    });
    expect(h.navigate).toHaveBeenLastCalledWith(
      ['/rooms', encodeRoomSegment('!missing:example.org')],
      {
        queryParams: { account: ALICE, view: 'home' },
        replaceUrl: true,
      },
    );
    expect(h.conversations.focus).toHaveBeenLastCalledWith(
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
