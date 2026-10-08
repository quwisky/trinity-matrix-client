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
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelSidebarComponent } from '../channel-sidebar/channel-sidebar.component';
import { SidebarUserPanelComponent } from '../channel-sidebar/sidebar-user-panel/sidebar-user-panel.component';
import { ConnectivityBannerComponent } from '../connectivity-banner/connectivity-banner.component';
import { EncryptionBannerComponent } from '../encryption-banner/encryption-banner.component';
import { SimpleMessageListComponent } from '../message-list/simple-message-list/simple-message-list.component';
import { VirtualMessageListComponent } from '../message-list/virtual-message-list/virtual-message-list.component';
import { ServerRailComponent } from '../server-rail/server-rail.component';
import { TombstoneBannerComponent } from '../tombstone-banner/tombstone-banner.component';
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
} from './rooms-page.spec-harness';
import { BELOW_MEMBERS_QUERY } from '@trinity/util/ui';
import { SessionActionsService } from './session-actions.service';
import { ShellShortcutsService } from './shell-shortcuts.service';
import { ShellStatusService } from './shell-status.service';
import { SpaceActionsService } from './space-actions.service';
import { WorkspaceNavigationService } from '@trinity/application/workspace';

const BOB: MemberSummary = {
  userId: '@bob:hs',
  roomDisplayName: 'Bob',
  roomInitial: 'B',
  roomAvatarMxc: null,
  powerLevel: 0,
  isCreator: false,
};

const ROOM: RoomSummary = {
  id: '!r:hs',
  accountId: '@me:hs',
  accountIds: ['@me:hs'],
  name: 'General',
  initial: 'G',
  avatarMxc: null,
  topic: '',
  memberCount: 2,
  encrypted: false,
  unreadCount: 0,
  highlightCount: 0,
  hasUnread: false,
  markedUnread: false,
  lastMessage: '',
  activityTs: 0,
  favourite: false,
  lowPriority: false,
};

beforeEach(() => setRouteRoom(null));

let lastRender: {
  fixture: ComponentFixture<RoomsPage>;
  activeAccountId: WritableSignal<string | null>;
};
let lastFixture: ComponentFixture<RoomsPage>;

function renderHeader(
  pinCount: number,
  opts: {
    room?: RoomSummary | null;
    routeRoom?: string;
    loadState?: TimelineLoadState;
    presenceByUser?: Record<string, WritableSignal<PresenceState | null>>;
  } = {},
) {
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
    anyRoomUnread: signal(false),
    canConfigureSpace: signal(false),
    canCurateSpace: signal(false),
    roomInvitePermission: signal({ available: false, reason: null }),
    spaceCuratePermission: signal({ available: false, reason: null }),
    spaceInvitePermission: signal({ available: false, reason: null }),
    defaultSpaceSortMode: signal('recent'),
    filteredRooms: signal<RoomSummary[]>([]),
    members: signal<MemberSummary[]>([BOB]),
    membersView: signal({
      availability: 'coherent' as const,
      current: [BOB],
      stale: null,
    }),
    railSpaces: signal([]),
    railUnread: signal({
      recent: { unread: 0, mentions: 0 },
      home: { unread: 0, mentions: 0 },
      rooms: { unread: 0, mentions: 0 },
      perSpace: {},
    }),
    reauthAccounts: signal([]),
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
  const nav = { bindFocus: vi.fn(), releaseOpenRoom: vi.fn() };
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
          rightPanelWidth: signal(480),
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
      MockProvider(FeatureFlagsService, { virtualTimeline: signal(false) }),
      MockProvider(MatrixClientService, {
        activeUserId: signal<string | null>('@me:hs'),
      }),
      MockProvider(TrustService),
      MockProvider(IdentityPresenceService, {
        presenceFor: (userId: string) =>
          presenceByUser[userId] ?? signal('offline'),
      }),
      MockProvider(SpaceChildrenService),
      MockProvider(RoomMembersService),
      MockProvider(RoomModerationService),
      MockProvider(TrustVerificationService),
      MockProvider(IgnoredUsersService, { isIgnored: () => false }),
      MockProvider(TrnAlertService),
      MockProvider(TrnToastService),
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
        SimpleMessageListComponent,
        VirtualMessageListComponent,
        EncryptionBannerComponent,
        ConnectivityBannerComponent,
        TombstoneBannerComponent,
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
            activeRoomId: signal<string | null>(opts.routeRoom ?? '!r:hs'),
            pane: signal<'list' | 'conversation'>('conversation'),
            placement: signal<'list' | 'conversation' | 'split'>('split'),
            eventTarget: signal(null),
          },
        },
        {
          provide: MemberActionsService,
          useFactory: (surfaces: RoomSurfaceLifecycle) => ({
            onSelectMember: (member: MemberSummary) =>
              surfaces.transition({
                kind: 'open-member',
                member,
                direct: false,
              }),
          }),
          deps: [RoomSurfaceLifecycle],
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
        MockComponent(SimpleMessageListComponent),
        MockComponent(VirtualMessageListComponent),
        MockComponent(EncryptionBannerComponent),
        MockComponent(ConnectivityBannerComponent),
        MockComponent(TombstoneBannerComponent),
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
  it('closes only the popover, leaving the open panel alone', async () => {
    const root = renderHeader(0, {
      room: { ...ROOM, topic: 'Release planning' },
    });
    document.body.append(root);
    const surfaces =
      lastRender.fixture.debugElement.injector.get(RoomSurfaceLifecycle);
    surfaces.transition({ kind: 'open-threads' });
    lastRender.fixture.detectChanges();
    // jsdom has no Popover API: report the popover as open to the page's guard.
    const query = document.querySelector.bind(document);
    const spy = vi
      .spyOn(document, 'querySelector')
      .mockImplementation((selector: string) =>
        selector === '[popover]:popover-open'
          ? (root.querySelector('#room-topic-popover') as Element)
          : query(selector),
      );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(surfaces.renderedSurface()?.kind).toBe('threads');
    spy.mockRestore();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(surfaces.renderedSurface()).toBeNull();
    root.remove();
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

  it('still renders the timeline, fed the load state, but not the composer', () => {
    const state: TimelineLoadState = {
      kind: 'error',
      reason: 'room-unavailable',
    };
    const host = pending(state);
    const list = ngMocks.find(
      lastFixture.debugElement,
      SimpleMessageListComponent,
    );
    expect(list.componentInstance.loadState()).toEqual(state);
    expect(list.componentInstance.composerEnabled()).toBe(false);
    expect(list.componentInstance.roomId()).toBe('!pending:hs');
    expect(host.querySelector('[data-testid="chat-empty"]')).toBeNull();
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
        ngMocks.findAll(lastFixture.debugElement, SimpleMessageListComponent),
      ).toHaveLength(0);
    });
  }
});
