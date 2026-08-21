// Shared TestBed scaffolding for the rooms.page specs.
//
// This file exists because the suite was one 3912-line spec that could not finish: each
// TestBed block retains roughly 24 MB after a forced GC, so 184 tests in a single vitest
// fork crossed the 2 GB heap ceiling around test 77 and died mid-run. vitest isolates per
// FILE, so splitting the describes across files is what bounds the peak; this holds the
// pieces they all shared.
import { signal, type Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  Router,
  convertToParamMap,
  type ParamMap,
} from '@angular/router';
import { CryptoService } from '@trinity/data-access/crypto';
import {
  InvitesService,
  type PendingInvite,
} from '@trinity/data-access/invites';
import { PinnedMessagesService } from '@trinity/data-access/pinned';

import { TrnActionSheetService } from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { BehaviorSubject, of } from 'rxjs';
import { vi } from 'vitest';
import { RoomsPage } from './rooms.page';
import { RoomShellStore } from './room-shell-store';
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
import { ThreadPanelService } from '../thread/thread-panel.service';
import { PinnedPanelService } from '../pinned/pinned-panel.service';

/**
 * The `?room=` deep link a notification tap produces, as the stream the page subscribes
 * to (`ActivatedRoute.queryParamMap`). A BehaviorSubject because the real one replays its
 * current value to a late subscriber, which is exactly the case that matters: `/rooms` is
 * already active when the tap arrives.
 *
 * Every block needs it since every block constructs the page; only the deep-link tests
 * push to it, and they reset it afterwards with {@link setRouteQueryParams}.
 */
const queryParamMap = new BehaviorSubject<ParamMap>(convertToParamMap({}));

/** Drive `ActivatedRoute.queryParamMap`. Reset with `{}` after a test that sets it. */
export function setRouteQueryParams(params: Record<string, string>): void {
  queryParamMap.next(convertToParamMap(params));
}

/**
 * `ActivatedRoute.paramMap`, which is where the open room now lives: `/rooms/:roomId`.
 *
 * A BehaviorSubject for the same reason as the query params above — `RoomShellStore` reads
 * this through `toSignal` in a field initializer, so a stream that did not replay would leave
 * every store constructed in a test with `activeRoomId` stuck at its initial value.
 */
const paramMap = new BehaviorSubject<ParamMap>(convertToParamMap({}));

/**
 * Open a room BY URL, the way the router does — the only way to open one now.
 *
 * Takes the room id and encodes it here, so specs read in room ids rather than in base64:
 * `setRouteRoom('!a:hs')`, not `setRouteRoom('IWE6aHM')`. Pass `null` to close.
 */
export function setRouteRoom(roomId: string | null): void {
  paramMap.next(
    convertToParamMap(roomId ? { roomId: encodeRoomSegment(roomId) } : {}),
  );
}

/** The ActivatedRoute stub, for the one block that builds RoomsPage without SHARED_MOCKS. */
export const ROUTE_PROVIDER: Provider = {
  provide: ActivatedRoute,
  useValue: { queryParamMap, paramMap } as unknown as ActivatedRoute,
};

/**
 * Providers every TestBed block across the rooms.page specs supplies identically, with
 * no stub.
 *
 * Only tokens that are bare in EVERY block live here — deliberately not stated as a count,
 * which was already wrong before the specs were split again. The blocks are deliberately
 * divergent elsewhere — RoomsService is richly stubbed in some and bare in others, for
 * instance — so folding a stubbed token in here would silently change what a describe
 * asserts against, and every test would still pass against different data.
 *
 * This is also the single place to register a page-scoped provider: services listed in
 * a component's `providers:` array are invisible to `TestBed.inject(RoomsPage)`, so each
 * one has to be supplied to the TestBed by hand, in every block.
 */
export const SHARED_MOCKS: Provider[] = [
  // Page-scoped in the component; TestBed.inject(RoomsPage) does not apply component
  // providers, so it is supplied here as the real class.
  RoomShellStore,
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
  MockProvider(CryptoService),
  MockProvider(PinnedMessagesService),
  MockProvider(PinnedPanelService),
  // A Router whose `navigate` actually MOVES the route, because the store now reads the room
  // from `paramMap` and every "opening a room opens it" assertion in these specs depends on
  // that round trip. A bare auto-stub swallows the call, which would leave `activeRoomId`
  // null forever and tempt each spec into asserting `navigate` was called instead — a
  // strictly weaker test that passes just as well when the route parameter is misspelled.
  //
  // Only `/rooms` is interpreted; every other destination is swallowed as before, since no
  // spec here asserts on those.
  MockProvider(Router, {
    // `vi.fn` wrapping the behaviour, not a bare function: several specs assert on the
    // navigation itself (`expect(router.navigate).toHaveBeenCalledWith(...)`), and a plain
    // function fails those with "is not a spy" rather than with anything informative.
    navigate: vi.fn((commands: unknown[]) => {
      const [head, segment] = commands as [string, string | undefined];
      if (head === '/rooms') {
        paramMap.next(convertToParamMap(segment ? { roomId: segment } : {}));
      }
      return Promise.resolve(true);
    }) as unknown as Router['navigate'],
  }),
  ROUTE_PROVIDER,
  MockProvider(ThreadPanelService),
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

/**
 * Stub matchMedia so every query matches — the narrow layout where the member list is the
 * overlay drawer. Returns a restore function to reinstate the previous stub.
 *
 * CALL IT BEFORE `build()`, not after. The shell's viewport predicates are now read at
 * construction: `RoomShellStore` SEEDS `membersOpen` from a one-shot `matchesQuery`, and the
 * page and its coordinators create their `mediaQuerySignal` fields in their initialisers, each
 * of which takes its value from `matchMedia` at that moment. Stubbing afterwards changes what
 * a later call would return and nothing that has already been built — the test then asserts
 * against the wide layout while reading as though it asked for the narrow one.
 */
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
