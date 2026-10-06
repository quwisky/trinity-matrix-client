import { RoomModerationService } from '@trinity/data-access/room-administration';
import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
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
} from './rooms-page.spec-harness';
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

let lastFixture: ComponentFixture<RoomsPage>;

function renderHeader(
  pinCount: number,
  opts: {
    room?: RoomSummary | null;
    routeRoom?: string;
    loadState?: TimelineLoadState;
  } = {},
) {
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
    railUnread: signal({ recent: 0, home: 0, rooms: 0, perSpace: {} }),
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
        presenceFor: () => signal('offline'),
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
          useValue: { uploadProgress: signal(null) },
        },
        { provide: ShellShortcutsService, useValue: {} },
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
      ],
    },
  });
  setRouteRoom(opts.routeRoom ?? '!r:hs');
  const fixture = TestBed.createComponent(RoomsPage);
  lastFixture = fixture;
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const badge = '.header-pin__badge';

describe('RoomsPage header pinned-messages state', () => {
  it('renders no count badge anywhere, with pins or without', () => {
    expect(renderHeader(3).querySelector(badge)).toBeNull();
  });

  it('leaves the overflow button plain, with no badge or state', () => {
    const overflow = renderHeader(3).querySelector(
      '[data-testid="room-actions-overflow"]',
    );
    expect(overflow?.textContent?.trim()).toBe('');
    expect(
      overflow?.querySelector('trn-icon')?.getAttribute('data-variant'),
    ).toBeNull();
  });

  it('marks the pin icon active only when the room has pinned messages', () => {
    const icon = (host: HTMLElement) =>
      host.querySelector('[data-testid="open-pinned"] trn-icon');
    expect(icon(renderHeader(0))?.getAttribute('data-variant')).toBeNull();
    TestBed.resetTestingModule();
    expect(icon(renderHeader(2))?.getAttribute('data-variant')).toBe('accent');
  });

  it('puts the count in the pin button accessible name', () => {
    const pin = renderHeader(2).querySelector('[data-testid="open-pinned"]');
    expect(pin?.getAttribute('aria-label')).toBe('Pinned messages (2)');
  });

  it('keeps the plain accessible name when nothing is pinned', () => {
    const pin = renderHeader(0).querySelector('[data-testid="open-pinned"]');
    expect(pin?.getAttribute('aria-label')).toBe('Pinned messages');
  });
});

describe('RoomsPage header for a linked room the client does not hold yet', () => {
  const pending = (loadState: TimelineLoadState) =>
    renderHeader(0, { room: null, routeRoom: '!pending:hs', loadState });
  const roomActions = [
    'search-messages',
    'invite-people',
    'open-room-settings',
    'open-threads',
    'open-pinned',
    'toggle-members',
    'room-actions-overflow',
  ];

  it('titles the header "Loading room…" while the room is pending', () => {
    const host = pending({
      kind: 'loading',
      reason: 'room-pending',
      partial: false,
    });
    expect(host.querySelector('h1')?.textContent).toContain('Loading room…');
  });

  it('offers no room-scoped actions', () => {
    const host = pending({
      kind: 'loading',
      reason: 'room-pending',
      partial: false,
    });
    for (const id of roomActions) {
      expect(host.querySelector(`[data-testid="${id}"]`), id).toBeNull();
    }
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
