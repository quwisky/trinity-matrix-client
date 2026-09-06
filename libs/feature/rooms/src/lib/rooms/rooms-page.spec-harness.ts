// Shared TestBed scaffolding for the rooms.page specs.
//
// This file exists because the suite was one 3912-line spec that could not finish: each
// TestBed block retains roughly 24 MB after a forced GC, so 184 tests in a single vitest
// fork crossed the 2 GB heap ceiling around test 77 and died mid-run. vitest isolates per
// FILE, so splitting the describes across files is what bounds the peak; this holds the
// pieces they all shared.
import { computed, inject, signal, type Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  DefaultUrlSerializer,
  NavigationEnd,
  Router,
  convertToParamMap,
  type ParamMap,
} from '@angular/router';
import { TrustService } from '@trinity/data-access/trust';
import {
  AccountRuntimeService,
  type AccountSwitchCoordination,
} from '@trinity/data-access/accounts';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  InvitesService,
  RoomLibraryService,
  SelectedRoomLibraryService,
  SpaceContentsService,
  SpacesService,
  type PendingInvite,
} from '@trinity/data-access/room-library';
import {
  ConversationRuntime,
  type ConversationHandle,
  type ConversationKey,
} from '@trinity/data-access/timeline';
import { RoomNotificationsService } from '@trinity/data-access/notifications';
import {
  RoomActionPermissionsService,
  RoomMembersService,
} from '@trinity/data-access/room-administration';
import {
  WORKSPACE_SYSTEM_STATUS,
  WorkspaceApplicationSurfaceService,
  type WorkspaceApplicationSurfaceRequest,
} from '@trinity/application/workspace';

import { TrnActionSheetService } from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { BehaviorSubject, Subject, of, switchMap } from 'rxjs';
import { vi } from 'vitest';
import { RoomsPage } from './rooms.page';
import { RoomShellStore } from './room-shell-store';
import { RoomSurfaceLifecycle } from './room-surface-lifecycle';
import { ShellStatusService } from './shell-status.service';
import { RoomShellViewModel } from './room-shell-view-model';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { MemberActionsService } from './member-actions.service';
import { AccountRoutingService } from './account-routing.service';
import { InviteActionsService } from './invite-actions.service';
import { SpaceActionsService } from './space-actions.service';
import { RoomActionsService } from './room-actions.service';
import { ReadStateService } from './read-state.service';
import { encodeRoomSegment } from '@trinity/util/matrix';
import { MessageActionsService } from './message-actions.service';
import { ShellShortcutsService } from './shell-shortcuts.service';
import { SessionActionsService } from './session-actions.service';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import {
  ConversationComposeStub,
  ConversationTimelineStub,
} from '../testing/conversation-timeline.stub';

export { ConversationTimelineStub as RoomsTimelineStub };

/**
 * `ActivatedRoute.queryParamMap`, kept only because the stub has to answer it: nothing in
 * the rooms feature reads query params any more. The `?room=` deep link it used to carry
 * became `/rooms/:roomId` — see {@link setRouteRoom}.
 */
const queryParamMap = new BehaviorSubject<ParamMap>(convertToParamMap({}));

/**
 * `ActivatedRoute.paramMap`, which is where the open room now lives: `/rooms/:roomId`.
 *
 * A BehaviorSubject for the same reason as the query params above — `RoomShellStore` reads
 * this through `toSignal` in a field initializer, so a stream that did not replay would leave
 * every store constructed in a test with `activeRoomId` stuck at its initial value.
 */
const paramMap = new BehaviorSubject<ParamMap>(convertToParamMap({}));
const routerEvents = new Subject<NavigationEnd>();
const urlSerializer = new DefaultUrlSerializer();
let currentRouteUrl = `/rooms?account=${encodeURIComponent('@me:hs')}`;
let navigationId = 0;

function moveRoute(url: string): void {
  currentRouteUrl = url;
  routerEvents.next(new NavigationEnd(++navigationId, url, url));
}

/**
 * Open a room BY URL, the way the router does — the only way to open one now.
 *
 * Takes the room id and encodes it here, so specs read in room ids rather than in base64:
 * `setRouteRoom('!a:hs')`, not `setRouteRoom('IWE6aHM')`. Pass `null` to close.
 */
/**
 * Run `MessageActionsService.onPanelJump`'s deferred jump.
 *
 * The jump is deferred to `afterNextRender` so it measures the layout the closing panel
 * leaves behind — see the note on `onPanelJump`. Nothing flushes render hooks on its own in
 * a `TestBed.inject`-driven spec, so the assertions have to ask for it.
 */
export function flushPanelJump(): void {
  TestBed.tick();
}

export function setRouteRoom(roomId: string | null): void {
  // Page-level specs start from the canonical Active Account coordinate. Legacy URLs
  // without `account` are covered by Workspace's adapter suite; leaving it absent here
  // starts an asynchronous canonicalization before each test can issue its own command.
  queryParamMap.next(convertToParamMap({ account: '@me:hs' }));
  paramMap.next(
    convertToParamMap(roomId ? { roomId: encodeRoomSegment(roomId) } : {}),
  );
  moveRoute(
    `/rooms${roomId ? `/${encodeRoomSegment(roomId)}` : ''}?account=${encodeURIComponent('@me:hs')}`,
  );
}

/**
 * The same route parameter, written RAW — no encoding step.
 *
 * For the one case {@link setRouteRoom} cannot express: a segment that is not one of ours.
 * Because that helper encodes, `decodeRoomSegment` succeeds in every spec that uses it, so
 * its `null` branch — the guard that keeps a hand-typed or mangled URL from reaching the
 * SDK as a room id — is otherwise unreachable from a test.
 */
export function setRouteSegment(segment: string): void {
  paramMap.next(convertToParamMap({ roomId: segment }));
  queryParamMap.next(convertToParamMap({ account: '@me:hs' }));
  moveRoute(`/rooms/${segment}?account=${encodeURIComponent('@me:hs')}`);
}

/** The ActivatedRoute stub, for the one block that builds RoomsPage without SHARED_MOCKS. */
export const ROUTE_PROVIDER: Provider = {
  provide: ActivatedRoute,
  useValue: { queryParamMap, paramMap } as unknown as ActivatedRoute,
};

export const SYSTEM_STATUS_PROVIDER: Provider = {
  provide: WORKSPACE_SYSTEM_STATUS,
  useFactory: () => ({ hasProblems: signal(false), show: vi.fn() }),
};

/**
 * Providers every TestBed block across the rooms.page specs supplies identically, with
 * no stub.
 *
 * Only tokens that are bare in EVERY block live here — deliberately not stated as a count,
 * which was already wrong before the specs were split again. The blocks are deliberately
 * divergent elsewhere — RoomLibraryService is richly stubbed in some and bare in others, for
 * instance — so folding a stubbed token in here would silently change what a describe
 * asserts against, and every test would still pass against different data.
 *
 * This is also the single place to register a page-scoped provider: services listed in
 * a component's `providers:` array are invisible to `TestBed.inject(RoomsPage)`, so each
 * one has to be supplied to the TestBed by hand, in every block.
 */
export const SHARED_MOCKS: Provider[] = [
  SYSTEM_STATUS_PROVIDER,
  // Page-scoped in the component; TestBed.inject(RoomsPage) does not apply component
  // providers, so it is supplied here as the real class.
  RoomShellStore,
  RoomSurfaceLifecycle,
  ShellStatusService,
  RoomShellViewModel,
  RoomShellNavigationService,
  MemberActionsService,
  AccountRoutingService,
  InviteActionsService,
  SpaceActionsService,
  RoomActionsService,
  ReadStateService,
  MessageActionsService,
  ShellShortcutsService,
  SessionActionsService,
  WorkspaceNavigationService,
  ConversationTimelineStub,
  MockProvider(SpaceContentsService, {
    create: () =>
      of({
        kind: 'linked' as const,
        item: { id: '!created:hs', name: 'Created', kind: 'room' as const },
      }),
    unlink: () => of(undefined),
  }),
  {
    provide: ConversationRuntime,
    useFactory: () => {
      const timeline = inject(ConversationTimelineStub);
      const compose = new ConversationComposeStub();
      const media = {
        send: vi.fn(() => of({ kind: 'sent' as const, eventId: '$media' })),
      };
      const messages = {
        beginReply: vi.fn(() => ({
          kind: 'applied' as const,
          operation: 'reply' as const,
        })),
        beginEdit: vi.fn(() => ({
          kind: 'applied' as const,
          operation: 'edit' as const,
        })),
        toggleReaction: vi.fn(() =>
          of({ kind: 'applied' as const, operation: 'reaction' as const }),
        ),
        redact: vi.fn(() =>
          of({ kind: 'applied' as const, operation: 'redaction' as const }),
        ),
        retry: vi.fn(() =>
          of({ kind: 'applied' as const, operation: 'retry' as const }),
        ),
        acknowledge: vi.fn(() =>
          of({ kind: 'applied' as const, operation: 'receipt' as const }),
        ),
      };
      const search = {
        searchLoaded: vi.fn(() => ({
          hits: [],
          scanned: 0,
          encrypted: false,
          serverAvailable: true,
        })),
        searchServer: vi.fn(() => of({ hits: [], count: 0, nextBatch: null })),
        loadOlder: vi.fn(() => of(0)),
      };
      const focused = signal<ConversationHandle | null>(null);
      const summaries = signal({});
      const threadList = signal([]);
      const pinnedEventIds = signal<readonly string[]>([]);
      const pinnedMessages = signal<readonly never[]>([]);
      const canMutatePins = signal(false);
      const threads = {
        summaries: summaries.asReadonly(),
        list: threadList.asReadonly(),
        forRoot: vi.fn(() => null),
      };
      const pins = {
        eventIds: pinnedEventIds.asReadonly(),
        messages: pinnedMessages.asReadonly(),
        canMutate: canMutatePins.asReadonly(),
        isPinned: vi.fn((eventId: string) =>
          pinnedEventIds().includes(eventId),
        ),
        pin: vi.fn(() =>
          of({ kind: 'applied' as const, operation: 'pin' as const }),
        ),
        unpin: vi.fn(() =>
          of({ kind: 'applied' as const, operation: 'unpin' as const }),
        ),
      };
      return {
        timeline,
        compose,
        messages,
        search,
        media,
        threads,
        pins,
        focused: focused.asReadonly(),
        focus: vi.fn((key: ConversationKey) => {
          timeline.focusRoom(key.roomId);
          const state = signal<'focused'>('focused');
          const handle = {
            key: Object.freeze({ ...key }),
            state: state.asReadonly(),
            timeline,
            compose,
            messages,
            search,
            media,
            threads,
            pins,
          } satisfies ConversationHandle;
          focused.set(handle);
          return handle;
        }),
        blur: vi.fn(() => {
          timeline.blurRoom();
          focused.set(null);
        }),
      };
    },
  },
  // Settings presentation has its own focused component-library suite. Room-shell tests only
  // need the session coordinator's boundary and must not construct a real dialog service from
  // their deliberately minimal Router stub.
  MockProvider(WorkspaceApplicationSurfaceService, {
    open: (request: WorkspaceApplicationSurfaceRequest) =>
      of({ kind: 'presented' as const, surface: request.surface }),
  }),
  {
    provide: AccountRuntimeService,
    useFactory: () => {
      const matrix = inject(MatrixClientService);
      const activeAccountId = signal(matrix.activeUserId());
      return {
        activeAccountId: activeAccountId.asReadonly(),
        switchActiveAccount: vi.fn(
          (accountId: string, coordination: AccountSwitchCoordination) =>
            coordination.prepare().pipe(
              switchMap(() => {
                coordination.onCommitStarted?.();
                activeAccountId.set(accountId);
                return of({
                  kind: 'ready' as const,
                  accountId,
                  metrics: {
                    durationMs: 0,
                    projectionDurationMs: 0,
                    projectionCount: 0,
                  },
                });
              }),
            ),
        ),
      };
    },
  },
  MockProvider(TrustService),
  MockProvider(RoomNotificationsService, {
    setModeForAccounts: () => of(undefined),
  }),
  MockProvider(RoomActionPermissionsService, {
    room: () => ({
      invite: { available: true, reason: null },
      curateSpace: { available: true, reason: null },
    }),
  }),
  MockProvider(RoomMembersService, {
    membersView: () => ({
      availability: 'coherent',
      current: [],
      stale: null,
    }),
  }),
  // A Router whose `navigate` actually MOVES the route, because the store now reads the room
  // from `paramMap` and every "opening a room opens it" assertion in these specs depends on
  // that round trip. A bare auto-stub swallows the call, which would leave `activeRoomId`
  // null forever and tempt each spec into asserting `navigate` was called instead — a
  // strictly weaker test that passes just as well when the route parameter is misspelled.
  //
  // Only `/rooms` is interpreted; every other destination is swallowed as before, since no
  // spec here asserts on those.
  {
    provide: Router,
    useFactory: () => ({
      get url() {
        return currentRouteUrl;
      },
      events: routerEvents,
      parseUrl: (url: string) => urlSerializer.parse(url),
      // `vi.fn` wrapping the behaviour, not a bare function: several specs assert on the
      // navigation itself (`expect(router.navigate).toHaveBeenCalledWith(...)`), and a plain
      // function fails those with "is not a spy" rather than with anything informative.
      navigate: vi.fn(
        (commands: unknown[], extras?: { queryParams?: object }) => {
          const [head, segment] = commands as [string, string | undefined];
          if (head === '/rooms') {
            const queryParams = extras?.queryParams ?? {};
            paramMap.next(
              convertToParamMap(segment ? { roomId: segment } : {}),
            );
            queryParamMap.next(convertToParamMap(queryParams));
            const tree = urlSerializer.parse(
              segment ? `/rooms/${segment}` : '/rooms',
            );
            tree.queryParams = queryParams;
            moveRoute(urlSerializer.serialize(tree));
          }
          return Promise.resolve(true);
        },
      ) as unknown as Router['navigate'],
      navigateByUrl: vi.fn((url: string) => {
        moveRoute(url);
        return Promise.resolve(true);
      }) as unknown as Router['navigateByUrl'],
    }),
  },
  ROUTE_PROVIDER,
  MockProvider(TrnActionSheetService),
];

/**
 * The page together with the page-scoped coordinators that actually own its behaviour.
 *
 * Assertions go to the owner — `shell.messages.onEdit(...)`, `shell.store.activeRoomId` —
 * rather than through the page. The page kept one-line delegates during the extraction so
 * this spec could stay an unmodified oracle while state moved out from under it; now that
 * the moves are done, testing the delegate instead of the thing it calls would only pin the
 * forwarding.
 */
export function shellFrom() {
  return {
    page: TestBed.inject(RoomsPage),
    store: TestBed.inject(RoomShellStore),
    surfaces: TestBed.inject(RoomSurfaceLifecycle),
    vm: TestBed.inject(RoomShellViewModel),
    status: TestBed.inject(ShellStatusService),
    nav: TestBed.inject(RoomShellNavigationService),
    routing: TestBed.inject(AccountRoutingService),
    members: TestBed.inject(MemberActionsService),
    invites: TestBed.inject(InviteActionsService),
    spaces: TestBed.inject(SpaceActionsService),
    rooms: TestBed.inject(RoomActionsService),
    readState: TestBed.inject(ReadStateService),
    messages: TestBed.inject(MessageActionsService),
    shortcuts: TestBed.inject(ShellShortcutsService),
    session: TestBed.inject(SessionActionsService),
  };
}

/** Default InvitesService mock: empty model + join/leave stubs. */
export function invitesProvider(over: Partial<InvitesService> = {}) {
  return MockProvider(InvitesService, {
    pendingInvites: signal<PendingInvite[]>([]),
    acceptInvite: () => of(undefined),
    declineInvite: () => of(undefined),
    ...over,
  });
}

/** Keep single-Account page tests on their directly driven projection signals. */
export function selectedRoomLibraryProvider(): Provider {
  return {
    provide: SelectedRoomLibraryService,
    useFactory: () => {
      const matrix = inject(MatrixClientService);
      const rooms = inject(RoomLibraryService);
      const spaces = inject(SpacesService);
      const invites = inject(InvitesService);
      return {
        view: computed(() => {
          const activeAccountId = matrix.activeUserId();
          return {
            accountIds: new Set(activeAccountId ? [activeAccountId] : []),
            mode: 'active' as const,
            rooms: rooms.rooms(),
            spaces: spaces.spaces(),
            spaceChildRoomIdsByAccount: activeAccountId
              ? new Map([
                  [
                    activeAccountId,
                    new Set(
                      spaces.spaces().flatMap((space) => space.childRoomIds),
                    ),
                  ],
                ])
              : new Map(),
            invitations: invites.pendingInvites(),
          };
        }),
      };
    },
  };
}

/**
 * Stub matchMedia so every query matches — the narrow layout where the member list is the
 * overlay drawer. Returns a restore function to reinstate the previous stub.
 *
 * CALL IT BEFORE `build()`, not after. The shell's viewport predicates are read early: the
 * page and its coordinators create their `mediaQuerySignal` fields in initialisers, each of
 * which takes its value from `matchMedia` at that moment. Stubbing afterwards changes what a
 * later call would return and nothing already built, so the test would assert against the
 * wide layout while reading as though it asked for the narrow one.
 */
/**
 * A LIVE matchMedia stub: it keeps its `change` listeners, so {@link setMediaQuery} can move
 * a breakpoint mid-test and `mediaQuerySignal` actually updates.
 *
 * {@link stubNarrowLayout} answers `true` to everything and drops its listeners on the floor,
 * which is all a fixed-layout test needs. Nothing could move a breakpoint under a built
 * shell — and a projection effect that re-ran on a resize was invisible because of it.
 *
 * Install it BEFORE `build()`, like `stubNarrowLayout`: the predicates are read at
 * construction.
 */
const mediaListeners = new Map<
  string,
  ((event: { matches: boolean }) => void)[]
>();
const mediaMatches = new Map<string, boolean>();

export function stubLiveLayout(
  initial: Record<string, boolean> = {},
): () => void {
  const previous = window.matchMedia;
  mediaListeners.clear();
  mediaMatches.clear();
  for (const [query, matches] of Object.entries(initial)) {
    mediaMatches.set(query, matches);
  }
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return mediaMatches.get(query) ?? false;
    },
    media: query,
    onchange: null,
    addEventListener: (
      _type: string,
      listener: (event: { matches: boolean }) => void,
    ) => {
      mediaListeners.set(query, [
        ...(mediaListeners.get(query) ?? []),
        listener,
      ]);
    },
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  return () => vi.stubGlobal('matchMedia', previous);
}

/** Move a breakpoint under a shell built with {@link stubLiveLayout}. */
export function setMediaQuery(query: string, matches: boolean): void {
  mediaMatches.set(query, matches);
  for (const listener of mediaListeners.get(query) ?? []) {
    listener({ matches });
  }
}

export function stubNarrowLayout(): () => void {
  const previous = window.matchMedia;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  return () => vi.stubGlobal('matchMedia', previous);
}

/**
 * Minimal MatrixClient double for a `clientFor` stub.
 *
 * UnreadAggregatorService sits in the page's injector tree and its constructor effect
 * attaches five listeners to whatever `clientFor` returns, so a stub carrying only
 * `getUser` throws "client.on is not a function" from inside an Angular effect — which
 * surfaces as a failure in whatever test happened to trigger the flush, nowhere near the
 * mock at fault. ng-mocks invented those methods until 14.16; it no longer does, so the
 * listener half has to be declared.
 */
export function clientStub(over: Record<string, unknown> = {}): never {
  return {
    getUser: () => null,
    on: () => undefined,
    off: () => undefined,
    // Once the listeners attach, the aggregator's first flush reduces over this. An
    // empty list is the honest answer for a page spec: these blocks assert routing and
    // actions, and stub UnreadAggregatorService itself where they care about counts.
    getRooms: () => [],
    ...over,
  } as never;
}

/** Settle a real Router navigation Promise, then flush the resulting signal projections. */
export async function settleWorkspace(): Promise<void> {
  await Promise.resolve();
  TestBed.tick();
}
