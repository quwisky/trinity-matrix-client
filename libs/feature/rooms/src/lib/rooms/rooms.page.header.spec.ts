import { RoomModerationService } from '@trinity/data-access/room-administration';
import { signal, type WritableSignal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { type PresenceState } from '@trinity/util/matrix';
import { Router } from '@angular/router';
import { WorkspaceBackService } from '@trinity/application/workspace';
import {
  type MemberSummary,
  RoomMembersService,
} from '@trinity/data-access/room-administration';
import {
  TrustVerificationService,
  TrustService,
} from '@trinity/data-access/trust';
import { InvitesService } from '@trinity/data-access/room-library';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  IgnoredUsersService,
  IdentityPresenceService,
} from '@trinity/data-access/identity';
import {
  AccountScopeService,
  RoomLibraryService,
  SelectedRoomLibraryService,
  SpaceChildrenService,
  SpacesService,
  type RoomSummary,
} from '@trinity/data-access/room-library';
import {
  ConversationRuntime,
  TimelineActionsService,
  type TimelineLoadState,
} from '@trinity/data-access/timeline';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  FeatureFlagsService,
  HapticsService,
  MessageGestureSettingsService,
  ShellLayoutService,
} from '@trinity/platform-native';
import { MockComponent, MockProvider, ngMocks } from 'ng-mocks';
import { NEVER, of } from 'rxjs';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ChannelSidebarComponent } from '../channel-sidebar/channel-sidebar.component';
import { SidebarUserPanelComponent } from '../channel-sidebar/sidebar-user-panel/sidebar-user-panel.component';
import { ConnectivityBannerComponent } from '../connectivity-banner/connectivity-banner.component';
import { EncryptionBannerComponent } from '../encryption-banner/encryption-banner.component';
import { MessageListComponent } from '../message-list/message-list.component';
import { NO_RAIL_UNREAD_CHATS } from '../server-rail/rail-unread-chats';
import { ServerRailComponent } from '../server-rail/server-rail.component';
import { TombstoneBannerComponent } from '../tombstone-banner/tombstone-banner.component';
import { IdentityChangeBannerComponent } from '../identity-change/identity-change-banner.component';
import { JoinRequestsBannerComponent } from '../join-requests-banner/join-requests-banner.component';
import { ThreadViewComponent } from '../thread/thread-view.component';
import { AccountRoutingService } from './account-routing.service';
import { InviteActionsService } from './invite-actions.service';
import { MemberActionsService } from './member-actions.service';
import { MessageActionsService } from './message-actions.service';
import { PaneHandleComponent } from './pane-handle.component';
import { ReadStateService } from './read-state.service';
import { RoomActionsService } from './room-actions.service';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { RoomSurfaceLifecycle } from './room-surface-lifecycle';
import { RoomShellViewModel } from './room-shell-view-model';
import { RoomsPage } from './rooms.page';
import { ConversationTimelineStub } from '../testing/conversation-timeline.stub';
import {
  ROUTE_PROVIDER,
  SYSTEM_STATUS_PROVIDER,
  setRouteRoom,
  stubLiveLayout,
  workspacePanelStub,
} from './rooms-page.spec-harness';
import { BELOW_MD_QUERY, BELOW_MEMBERS_QUERY } from '@trinity/util/ui';
import { SessionActionsService } from './session-actions.service';
import { ShellShortcutsService } from './shell-shortcuts.service';
import { ShellStatusService } from './shell-status.service';
import { SpaceActionsService } from './space-actions.service';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { roomSummary } from '../testing/room-summary.fixture';
import { CallService, type ActiveCall } from '@trinity/data-access/calls';
import { compileBeforeTests } from '../testing/test-bed';

const BOB: MemberSummary = {
  userId: '@bob:hs',
  roomDisplayName: 'Bob',
  roomInitial: 'B',
  roomAvatarMxc: null,
  powerLevel: 0,
  isCreator: false,
};

const ROOM: RoomSummary = roomSummary({
  id: '!r:hs',
  accountId: '@me:hs',
  name: 'General',
  memberCount: 2,
});

const CALL_ROOM: RoomSummary = roomSummary({
  id: '!call:hs',
  accountId: '@me:hs',
  name: 'Standup',
  memberCount: 3,
});

beforeEach(() => setRouteRoom(null));

let lastRender: {
  fixture: ComponentFixture<RoomsPage>;
  activeAccountId: WritableSignal<string | null>;
};
let lastFixture: ComponentFixture<RoomsPage>;
const windowingFlag = signal(false);
const deferMediaFlag = signal(false);
const flingPlaceholdersFlag = signal(false);

function renderHeader(
  pinCount: number,
  opts: {
    room?: RoomSummary | null;
    routeRoom?: string;
    loadState?: TimelineLoadState;
    presenceByUser?: Record<string, WritableSignal<PresenceState | null>>;
    calls?: Partial<CallService>;
  } = {},
) {
  windowingFlag.set(false);
  deferMediaFlag.set(false);
  flingPlaceholdersFlag.set(false);
  const presenceByUser = opts.presenceByUser ?? {};
  const pinMessages = signal<readonly unknown[]>(
    Array.from({ length: pinCount }, (_, id) => ({ id })),
  );
  const vm = {
    accountBadges: signal(new Map()),
    accounts: signal([]),
    activeAccountId: signal<string | null>('@me:hs'),
    activeRoom: signal<RoomSummary | null>(
      opts.room === undefined ? ROOM : opts.room,
    ),
    activeRoomIsDirect: signal(false),
    activeSpaceListed: signal(false),
    activeSpacePending: signal(false),
    roomListLoading: signal(false),
    anyRoomUnread: signal(false),
    canConfigureSpace: signal(false),
    canCurateSpace: signal(false),
    roomInvitePermission: signal({ available: false, reason: null }),
    spaceCuratePermission: signal({ available: false, reason: null }),
    spaceInvitePermission: signal({ available: false, reason: null }),
    spaceMembershipPermission: signal({ available: false, reason: null }),
    spaceOrderOwnerName: signal(null),
    defaultSpaceSortMode: signal('recent'),
    filteredRooms: signal<RoomSummary[]>([]),
    backLabel: signal('Back to rooms'),
    inboxShown: signal(false),
    members: signal<MemberSummary[]>([BOB]),
    membersView: signal({
      availability: 'coherent' as const,
      current: [BOB],
      stale: null,
    }),
    railSpaces: signal([]),
    railUnreadChats: signal(NO_RAIL_UNREAD_CHATS),
    railUnread: signal({
      recent: { unread: 0, mentions: 0 },
      home: { unread: 0, mentions: 0 },
      rooms: { unread: 0, mentions: 0 },
      perSpace: {},
    }),
    reauthAccounts: signal([]),
    accountsRestoring: signal(false),
    sidebarTitle: signal('Home'),
    spaceSortMode: signal('recent'),
    spaceSortOverridden: signal(false),
    syncLabel: signal('Connecting…'),
    userAvatarMxc: signal<string | null>(null),
    userId: signal('@me:hs'),
    userInitial: signal('M'),
    userName: signal('Me'),
    userProfile: signal({
      userId: '@me:hs',
      displayName: 'Me',
      avatarMxc: null,
    }),
  };
  const nav = {
    bindFocus: vi.fn(),
    releaseOpenRoom: vi.fn(),
    knownRooms: () => [ROOM, CALL_ROOM],
  };
  const status = { error: signal<string | null>(null), showError: vi.fn() };

  TestBed.configureTestingModule({
    providers: [
      ROUTE_PROVIDER,
      SYSTEM_STATUS_PROVIDER,
      MockProvider(Router),
      MockProvider(MessageGestureSettingsService, {
        messageSwipe: signal('off'),
      }),
      {
        provide: ShellLayoutService,
        useValue: {
          sidebarWidth: signal(280),
          rightPanelWidth: signal(360),
          sidebarBounds: { min: 240, max: 560 },
          rightPanelBounds: { min: 320, max: 720 },
        },
      },
      MockProvider(HapticsService),
      MockProvider(WorkspaceBackService, { register: () => vi.fn() }),
      MockProvider(RoomLibraryService, {
        selectionAvailability: () => 'available',
        clearMarkedUnread: () => of(void 0),
        createDirectMessage: vi.fn(() => of('!dm:hs')),
      }),
      MockProvider(SpacesService, {
        openSpace: () => of(void 0),
        spaces: signal([]),
      }),
      MockProvider(AccountScopeService, {
        selected: signal(new Set(['@me:hs'])),
        mixing: signal(false),
      }),
      MockProvider(SelectedRoomLibraryService, {
        view: signal({
          accountIds: new Set(['@me:hs']),
          mode: 'active' as const,
          rooms: [ROOM],
          spaces: [],
          spaceChildRoomIdsByAccount: new Map(),
          invitations: [],
        }),
      }),
      MockProvider(InvitesService),
      MockProvider(TimelineActionsService),
      MockProvider(FeatureFlagsService, {
        virtualTimeline: windowingFlag,
        deferMediaWhileScrolling: deferMediaFlag,
        flingPlaceholders: flingPlaceholdersFlag,
      }),
      MockProvider(MatrixClientService, {
        activeUserId: signal<string | null>('@me:hs'),
      }),
      MockProvider(TrustService),
      MockProvider(IdentityPresenceService, {
        presenceFor: (userId: string) =>
          presenceByUser[userId] ?? signal('offline'),
        presenceDetailsFor: () => signal(null),
        revision: signal(0),
        peekDetails: () => null,
      }),
      MockProvider(SpaceChildrenService),
      MockProvider(RoomMembersService),
      MockProvider(RoomModerationService),
      MockProvider(TrustVerificationService),
      MockProvider(IgnoredUsersService, {
        isIgnored: () => false,
        runProjection: () => NEVER,
      }),
      MockProvider(TrnAlertService),
      MockProvider(TrnToastService),
      ...(opts.calls ? [MockProvider(CallService, opts.calls)] : []),
    ],
  });
  TestBed.overrideComponent(RoomsPage, {
    remove: {
      providers: [
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
      ],
      imports: [
        ServerRailComponent,
        ChannelSidebarComponent,
        SidebarUserPanelComponent,
        PaneHandleComponent,
        MessageListComponent,
        EncryptionBannerComponent,
        ConnectivityBannerComponent,
        TombstoneBannerComponent,
        IdentityChangeBannerComponent,
        JoinRequestsBannerComponent,
        ThreadViewComponent,
      ],
    },
    add: {
      providers: [
        {
          provide: ConversationRuntime,
          useFactory: () => ({
            timeline: Object.assign(new ConversationTimelineStub(), {
              loadState: signal(opts.loadState ?? { kind: 'ready' as const }),
            }),
            search: {
              searchLoaded: () => ({
                hits: [],
                encrypted: false,
                serverAvailable: false,
                scanned: 0,
              }),
            },
            threads: { summaries: signal({}), list: signal([]) },
            pins: {
              messages: pinMessages.asReadonly(),
              eventIds: signal<readonly string[]>([]),
              canMutate: signal(false),
              retryFailed: () => undefined,
            },
          }),
        },
        { provide: ShellStatusService, useValue: status },
        { provide: RoomShellViewModel, useValue: vm },
        { provide: RoomShellNavigationService, useValue: nav },
        {
          provide: WorkspaceNavigationService,
          useValue: {
            activeAccountId: signal<string | null>('@me:hs'),
            activeSpaceId: signal<string | null>(null),
            recentView: signal(true),
            roomsView: signal(false),
            inboxView: signal(false),
            activeRoomId: signal<string | null>(opts.routeRoom ?? '!r:hs'),
            pane: signal<'list' | 'conversation'>('conversation'),
            placement: signal<'list' | 'conversation' | 'split'>('split'),
            eventTarget: signal(null),
            ...workspacePanelStub(),
          },
        },
        {
          provide: MemberActionsService,
          useValue: { onSelectMember: vi.fn() },
        },
        { provide: AccountRoutingService, useValue: {} },
        { provide: InviteActionsService, useValue: {} },
        { provide: SpaceActionsService, useValue: {} },
        { provide: RoomActionsService, useValue: {} },
        { provide: ReadStateService, useValue: {} },
        {
          provide: MessageActionsService,
          useFactory: (surfaces: RoomSurfaceLifecycle) => ({
            uploadProgress: signal(null),
            openThreadsList: () =>
              surfaces.transition({ kind: 'open-threads' }),
            openPinnedPanel: () => surfaces.transition({ kind: 'open-pinned' }),
            openMessageSearch: () =>
              surfaces.transition({ kind: 'open-search' }),
            onMatrixLink: vi.fn(),
          }),
          deps: [RoomSurfaceLifecycle],
        },
        {
          provide: ShellShortcutsService,
          useValue: { bindSearchFocus: vi.fn(), onGlobalKeydown: vi.fn() },
        },
        { provide: SessionActionsService, useValue: {} },
      ],
      imports: [
        MockComponent(ServerRailComponent),
        MockComponent(ChannelSidebarComponent),
        MockComponent(SidebarUserPanelComponent),
        MockComponent(PaneHandleComponent),
        MockComponent(MessageListComponent),
        MockComponent(EncryptionBannerComponent),
        MockComponent(ConnectivityBannerComponent),
        MockComponent(TombstoneBannerComponent),
        MockComponent(IdentityChangeBannerComponent),
        MockComponent(JoinRequestsBannerComponent),
        MockComponent(ThreadViewComponent),
      ],
    },
  });
  setRouteRoom(opts.routeRoom ?? '!r:hs');
  const fixture = TestBed.createComponent(RoomsPage);
  lastFixture = fixture;
  fixture.detectChanges();
  lastRender = { fixture, activeAccountId: vm.activeAccountId };
  return fixture.nativeElement as HTMLElement;
}

compileBeforeTests(() => {
  renderHeader(0);
  return lastFixture;
});

describe('RoomsPage user panel presence', () => {
  const panelPresence = () =>
    (
      lastRender.fixture.debugElement.query(By.css('trn-sidebar-user-panel'))
        .componentInstance as SidebarUserPanelComponent
    ).presence();

  it('binds the active account’s presence and follows an account switch', () => {
    const me = signal<PresenceState | null>('online');
    const alt = signal<PresenceState | null>('unavailable');
    renderHeader(0, { presenceByUser: { '@me:hs': me, '@alt:hs': alt } });
    expect(panelPresence()).toBe('online');

    me.set('offline');
    lastRender.fixture.detectChanges();
    expect(panelPresence()).toBe('offline');

    lastRender.activeAccountId.set('@alt:hs');
    lastRender.fixture.detectChanges();
    expect(panelPresence()).toBe('unavailable');
  });
});

describe('RoomsPage header actions and search field', () => {
  const byId = (root: ParentNode, id: string) =>
    root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  function surfaces() {
    return lastRender.fixture.debugElement.injector.get(RoomSurfaceLifecycle);
  }

  function openThread() {
    surfaces().transition({ kind: 'open-thread', rootEventId: '$root' });
    lastRender.fixture.detectChanges();
    return ngMocks.find(lastFixture.debugElement, ThreadViewComponent)
      .componentInstance;
  }

  it('routes a matrix.to link clicked in a thread like one in the room', () => {
    renderHeader(0);
    const click = {
      target: { kind: 'user' as const, userId: '@ada:hs' },
    } as unknown as Parameters<MessageActionsService['onMatrixLink']>[0];

    openThread().matrixLink.emit(click);

    expect(
      lastRender.fixture.debugElement.injector.get(MessageActionsService)
        .onMatrixLink,
    ).toHaveBeenCalledExactlyOnceWith(click);
  });

  // As a page over the room (below md) the room's list is inert, so its typing region is
  // silent and the thread's own row must announce; beside the room it would say it twice.
  it('has the thread announce typing only while it is a page over the room', () => {
    renderHeader(0);
    expect(openThread().announceTyping()).toBe(false);
  });

  it('has the thread page over an inert room announce typing', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === BELOW_MD_QUERY,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    renderHeader(0);
    expect(openThread().announceTyping()).toBe(true);
  });

  it('hands the thread its message, and reports one it cannot reach', () => {
    renderHeader(0);
    surfaces().transition({
      kind: 'open-thread',
      rootEventId: '$root',
      revealEventId: '$reply',
    });
    lastRender.fixture.detectChanges();
    const thread = ngMocks.find(
      lastFixture.debugElement,
      ThreadViewComponent,
    ).componentInstance;
    expect(thread.revealEventId()).toBe('$reply');

    thread.revealFailed.emit();

    expect(
      lastRender.fixture.debugElement.injector.get(ShellStatusService)
        .showError,
    ).toHaveBeenCalledExactlyOnceWith('Could not load that message.');
  });

  async function typeInHeader(root: HTMLElement, value: string) {
    const field = byId(root, 'header-search') as HTMLInputElement;
    field.value = value;
    field.dispatchEvent(new Event('input'));
    lastRender.fixture.detectChanges();
    await lastRender.fixture.whenStable();
    lastRender.fixture.detectChanges();
    return field;
  }

  it('opens the search panel with the typed query', async () => {
    const root = renderHeader(0);
    await typeInHeader(root, 'hello');
    const panelField = root.querySelector<HTMLInputElement>(
      'trn-message-search input',
    );
    expect(panelField?.value).toBe('hello');
  });

  it('focuses the field when the search shortcut asks for it', () => {
    const root = renderHeader(0);
    document.body.append(root);
    const bindSearchFocus = lastRender.fixture.debugElement.injector.get(
      ShellShortcutsService,
    ).bindSearchFocus as ReturnType<typeof vi.fn>;
    bindSearchFocus.mock.calls.at(-1)?.[0]();
    expect(document.activeElement).toBe(byId(root, 'header-search'));
    root.remove();
  });

  function runSearchShortcut(): void {
    const bindSearchFocus = lastRender.fixture.debugElement.injector.get(
      ShellShortcutsService,
    ).bindSearchFocus as ReturnType<typeof vi.fn>;
    bindSearchFocus.mock.calls.at(-1)?.[0]();
  }

  async function settle(): Promise<void> {
    lastRender.fixture.detectChanges();
    await lastRender.fixture.whenStable();
    lastRender.fixture.detectChanges();
  }

  it('opens the panel and focuses its field from the shortcut below the members breakpoint', async () => {
    const restore = stubLiveLayout({ [BELOW_MEMBERS_QUERY]: true });
    try {
      const root = renderHeader(0);
      document.body.append(root);
      runSearchShortcut();
      await settle();
      const panelField = root.querySelector<HTMLInputElement>(
        'trn-message-search input',
      );
      expect(panelField).not.toBeNull();
      expect(document.activeElement).toBe(panelField);

      // Again with the panel already open: focus returns to the panel field.
      panelField!.blur();
      runSearchShortcut();
      await settle();
      expect(document.activeElement).toBe(panelField);
      root.remove();
    } finally {
      restore();
    }
  });

  it('lets Escape in an empty field reach the page and close the panel', async () => {
    const root = renderHeader(0);
    document.body.append(root);
    surfaces().transition({ kind: 'open-threads' });
    await settle();
    const field = byId(root, 'header-search') as HTMLInputElement;
    field.focus();
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    lastRender.fixture.detectChanges();
    expect(surfaces().renderedSurface()).toBeNull();
    root.remove();
  });
});

describe('RoomsPage Escape with the topic popover open', () => {
  // Characterization: pins that the page's Escape guard is present (jsdom has no Popover API,
  // so the popover is faked open). The real ordering against the browser's own popover
  // handling is pinned by shell-layout.spec.mts:832-841.
  it('closes only the popover, leaving the open panel alone', async () => {
    const root = renderHeader(0, {
      room: { ...ROOM, topic: 'Release planning' },
    });
    document.body.append(root);
    const query = document.querySelector.bind(document);
    const spy = vi
      .spyOn(document, 'querySelector')
      .mockImplementation((selector: string) =>
        selector === '[popover]:popover-open'
          ? (root.querySelector('#room-topic-popover') as Element)
          : query(selector),
      );
    try {
      const surfaces =
        lastRender.fixture.debugElement.injector.get(RoomSurfaceLifecycle);
      surfaces.transition({ kind: 'open-threads' });
      lastRender.fixture.detectChanges();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(surfaces.renderedSurface()?.kind).toBe('threads');
      spy.mockRestore();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(surfaces.renderedSurface()).toBeNull();
    } finally {
      spy.mockRestore();
      root.remove();
    }
  });
});

describe('RoomsPage header for a linked room the client does not hold yet', () => {
  const pending = (loadState: TimelineLoadState) =>
    renderHeader(0, { room: null, routeRoom: '!pending:hs', loadState });
  it('titles the header "Loading room…" while the room is pending', () => {
    const host = pending({
      kind: 'loading',
      reason: 'room-pending',
      partial: false,
    });
    expect(host.querySelector('h1')?.textContent).toContain('Loading room…');
  });

  it('drops the loading title once the room is known to be unavailable', () => {
    const host = pending({ kind: 'error', reason: 'room-unavailable' });
    expect(host.querySelector('h1')?.textContent).not.toContain(
      'Loading room…',
    );
  });

  it('still renders the timeline, fed the load state, but not the composer', () => {
    const state: TimelineLoadState = {
      kind: 'error',
      reason: 'room-unavailable',
    };
    const host = pending(state);
    const list = ngMocks.find(lastFixture.debugElement, MessageListComponent);
    expect(list.componentInstance.loadState()).toEqual(state);
    expect(list.componentInstance.composerEnabled()).toBe(false);
    expect(list.componentInstance.roomId()).toBe('!pending:hs');
    expect(host.querySelector('[data-testid="chat-empty"]')).toBeNull();
  });
});

describe('RoomsPage timeline', () => {
  it('renders one list, binds the windowing flag to it, and keeps it when the flag flips', () => {
    renderHeader(0);
    const lists = () =>
      ngMocks.findAll(lastFixture.debugElement, MessageListComponent);
    expect(lists()).toHaveLength(1);
    const list = lists()[0].componentInstance;
    expect(list.windowed()).toBe(false);

    windowingFlag.set(true);
    lastFixture.detectChanges();
    expect(lists()).toHaveLength(1);
    expect(lists()[0].componentInstance).toBe(list);
    expect(list.windowed()).toBe(true);
  });

  it('binds "Load images after fast scrolling" to the list as it flips', () => {
    renderHeader(0);
    const list = ngMocks.find(
      lastFixture.debugElement,
      MessageListComponent,
    ).componentInstance;
    expect(list.deferMediaWhileScrolling()).toBe(false);

    deferMediaFlag.set(true);
    lastFixture.detectChanges();

    expect(list.deferMediaWhileScrolling()).toBe(true);
  });

  it('binds "Blank rows while scrolling fast" to the list as it flips', () => {
    renderHeader(0);
    const list = ngMocks.find(
      lastFixture.debugElement,
      MessageListComponent,
    ).componentInstance;
    expect(list.flingPlaceholders()).toBe(false);

    flingPlaceholdersFlag.set(true);
    lastFixture.detectChanges();

    expect(list.flingPlaceholders()).toBe(true);
  });
});

describe('RoomsPage body for a room the client holds but the user has not joined', () => {
  for (const loadState of [
    { kind: 'ready' },
    { kind: 'empty' },
  ] as const satisfies readonly TimelineLoadState[]) {
    it(`shows the "Select a room" hero once its timeline is ${loadState.kind}`, () => {
      const host = renderHeader(0, {
        room: null,
        routeRoom: '!left:hs',
        loadState,
      });
      expect(host.querySelector('[data-testid="chat-empty"]')).not.toBeNull();
      expect(
        ngMocks.findAll(lastFixture.debugElement, MessageListComponent),
      ).toHaveLength(0);
    });
  }
});

describe('RoomsPage calls', () => {
  let lastId = 0;
  const ongoing = (roomId: string): ActiveCall => ({
    id: ++lastId,
    roomId,
    roomName: 'Elsewhere',
    accountId: '@me:hs',
    widgetUrl: 'trinity://app/element-call/index.html',
    state: 'joined',
    joinedAt: 0,
  });

  function renderCalls(activeCall: ActiveCall | null, room = ROOM) {
    const start = vi.fn();
    const root = renderHeader(0, {
      room,
      calls: {
        activeCall: signal(activeCall),
        start,
        participants: () => of(0),
        activeCallParticipants: () => of(0),
        callAvailable: () => of(true),
        elapsed: () => of(''),
      },
    });
    const confirm = vi.spyOn(TestBed.inject(TrnAlertService), 'confirm$');
    const click = (id: string) => {
      root.querySelector<HTMLElement>('[data-testid="start-call"]')?.click();
      document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click();
      lastFixture.detectChanges();
    };
    return { root, start, confirm, click };
  }

  it('starts a video call in the open room with no call running', () => {
    const { start, confirm, click } = renderCalls(null);
    click('start-video-call');
    expect(confirm).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith('!r:hs', {
      video: true,
      dm: false,
      theme: 'light',
      roomName: 'General',
    });
  });

  it('starts a voice call as a DM call in a direct room', () => {
    const { start, click } = renderCalls(
      null,
      roomSummary({ ...ROOM, directUserId: '@bob:hs' }),
    );
    click('start-voice-call');
    expect(start).toHaveBeenCalledWith('!r:hs', {
      video: false,
      dm: true,
      theme: 'light',
      roomName: 'General',
    });
  });

  it('asks before leaving a call in another room, and Cancel starts nothing', () => {
    const { start, confirm, click } = renderCalls(ongoing('!call:hs'));
    confirm.mockReturnValue(of(false));
    click('start-video-call');
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        header: 'Leave the call in Standup?',
        confirmText: 'Leave',
        cancelText: 'Cancel',
      }),
    );
    expect(start).not.toHaveBeenCalled();
  });

  it('leaves the other call and starts this one when confirmed', () => {
    const { start, confirm, click } = renderCalls(ongoing('!call:hs'));
    confirm.mockReturnValue(of(true));
    click('start-voice-call');
    expect(start).toHaveBeenCalledWith('!r:hs', {
      video: false,
      dm: false,
      theme: 'light',
      roomName: 'General',
    });
  });

  const stage = (root: ParentNode) =>
    root.querySelector('[data-testid="call-stage"]');

  it('stages the call in its own room, over the timeline', () => {
    const { root, start, confirm, click } = renderCalls(ongoing('!r:hs'));
    expect(stage(root)).not.toBeNull();
    expect(root.querySelector('.chat-body')?.className).toContain('hidden');
    click('start-video-call');
    expect(confirm).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('starts a fresh call in this room when its call failed', () => {
    const { root, start, confirm, click } = renderCalls({
      ...ongoing('!r:hs'),
      state: 'failed',
    });
    expect(stage(root)).toBeNull();
    expect(root.querySelector('.chat-body')?.className).not.toContain('hidden');
    click('start-video-call');
    expect(confirm).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith('!r:hs', {
      video: true,
      dm: false,
      theme: 'light',
      roomName: 'General',
    });
  });

  it('hides an ending call in its room and starts the next call without asking', () => {
    const { root, start, confirm, click } = renderCalls({
      ...ongoing('!r:hs'),
      state: 'ending',
    });
    expect(stage(root)).toBeNull();
    expect(root.querySelector('.chat-body')?.className).not.toContain('hidden');
    click('start-video-call');
    expect(confirm).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith('!r:hs', {
      video: true,
      dm: false,
      theme: 'light',
      roomName: 'General',
    });
  });

  it('offers no stage while another room is open', () => {
    const { root } = renderCalls(ongoing('!call:hs'));
    expect(stage(root)).toBeNull();
    expect(root.querySelector('.chat-body')?.className).not.toContain('hidden');
  });

  // Below md a panel page covers the conversation, and the fixed call frame would sit on it.
  it('docks the call while a panel page covers its room', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === BELOW_MD_QUERY,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const { root } = renderCalls(ongoing('!r:hs'));
    expect(stage(root)).not.toBeNull();

    lastFixture.debugElement.injector
      .get(RoomSurfaceLifecycle)
      .transition({ kind: 'open-threads' });
    lastFixture.detectChanges();

    expect(stage(root)).toBeNull();
    expect(root.querySelector('.chat-body')?.className).not.toContain('hidden');
  });

  it('keeps the call docked until a closing panel page has slid away', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === BELOW_MD_QUERY,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const { root } = renderCalls(ongoing('!r:hs'));
    Object.assign(
      lastFixture.debugElement.injector.get(WorkspaceNavigationService),
      { committedInApp: true },
    );
    const page = lastFixture.componentInstance as unknown as {
      panelSlide: () => string | null;
      shownSurface: () => unknown;
      onMainAnimationEnd: (event: AnimationEvent) => void;
    };
    const panelSlideEnds = () => {
      const panel = root.querySelector<HTMLElement>(
        '[data-right-panel-surface]',
      );
      page.onMainAnimationEnd({
        target: panel,
        currentTarget: root.querySelector('main'),
      } as unknown as AnimationEvent);
      lastFixture.detectChanges();
    };
    const surfaces =
      lastFixture.debugElement.injector.get(RoomSurfaceLifecycle);
    surfaces.transition({ kind: 'open-threads' });
    lastFixture.detectChanges();
    panelSlideEnds();

    surfaces.transition({ kind: 'clear' });
    lastFixture.detectChanges();
    expect(page.panelSlide()).toBe('close');
    expect(stage(root)).toBeNull();
    expect(root.querySelector('.chat-body')?.className).not.toContain('hidden');

    panelSlideEnds();
    expect(page.panelSlide()).toBeNull();
    expect(page.shownSurface()).toBeNull();
    expect(stage(root)).not.toBeNull();
  });

  it('keeps the call staged while a side panel is open on a wide window', () => {
    const { root } = renderCalls(ongoing('!r:hs'));
    lastFixture.debugElement.injector
      .get(RoomSurfaceLifecycle)
      .transition({ kind: 'open-threads' });
    lastFixture.detectChanges();
    expect(stage(root)).not.toBeNull();
  });

  const card = (root: ParentNode) => root.querySelector('trn-call-card');
  const stubBelowMd = () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === BELOW_MD_QUERY,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
  };

  it('docks a call in another room as the sidebar card', () => {
    const { root } = renderCalls(ongoing('!call:hs'));
    expect(card(root)).not.toBeNull();
  });

  it('shows no card while the call is expanded on its stage', () => {
    const { root } = renderCalls(ongoing('!r:hs'));
    expect(card(root)).toBeNull();
  });

  it('shows no card below md while a room covers the room list', () => {
    stubBelowMd();
    const { root } = renderCalls(ongoing('!call:hs'));
    expect(card(root)).toBeNull();
  });

  it('reserves the card height on the shell for the scrollers under it', () => {
    const { root } = renderCalls(ongoing('!call:hs'));
    const shell = root.querySelector<HTMLElement>('.shell-side');
    expect(shell?.style.getPropertyValue('--trinity-call-card-height')).toBe(
      '0px',
    );
    const observer = (
      ResizeObserver as unknown as {
        instances: {
          observed: Set<Element>;
          emit(entries: unknown[]): void;
        }[];
      }
    ).instances.find((o) => o.observed.has(card(root) as Element));
    observer?.emit([{ borderBoxSize: [{ blockSize: 240, inlineSize: 300 }] }]);
    lastFixture.detectChanges();
    expect(shell?.style.getPropertyValue('--trinity-call-card-height')).toBe(
      '240px',
    );
  });

  it("passes the open room's call participants to the header", () => {
    const participants = vi.fn(() => of(3));
    const root = renderHeader(0, {
      calls: {
        activeCall: signal(null),
        participants,
        callAvailable: () => of(true),
      },
    });
    expect(participants).toHaveBeenCalledWith('@me:hs', '!r:hs');
    expect(
      root
        .querySelector('[data-testid="start-call"]')
        ?.getAttribute('aria-label'),
    ).toBe('Join call · 3');
  });

  it('keeps watching the call when the room summary refreshes with the same ids', () => {
    const participants = vi.fn(() => of(1));
    renderHeader(0, {
      calls: {
        activeCall: signal(null),
        participants,
        callAvailable: () => of(true),
      },
    });
    const vm = lastFixture.debugElement.injector.get(RoomShellViewModel);
    (vm.activeRoom as WritableSignal<RoomSummary | null>).set({ ...ROOM });
    lastFixture.detectChanges();
    expect(participants).toHaveBeenCalledTimes(1);
  });
});
