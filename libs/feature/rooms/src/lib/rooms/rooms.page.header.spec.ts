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
} from '@trinity/data-access/timeline';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  FeatureFlagsService,
  HapticsService,
  MessageGestureSettingsService,
  ShellLayoutService,
} from '@trinity/platform-native';
import { MockComponent, MockProvider } from 'ng-mocks';
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
  stubNarrowLayout,
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

let lastRender: {
  fixture: ComponentFixture<RoomsPage>;
  activeAccountId: WritableSignal<string | null>;
};

function renderHeader(
  pinCount: number,
  presenceByUser: Record<string, WritableSignal<PresenceState | null>> = {},
  room: RoomSummary | null = ROOM,
) {
  const pinMessages = signal<readonly unknown[]>(
    Array.from({ length: pinCount }, (_, id) => ({ id })),
  );
  const vm = {
    accountBadges: signal(new Map()),
    accounts: signal([]),
    activeAccountId: signal<string | null>('@me:hs'),
    activeRoom: signal<RoomSummary | null>(room),
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
      ],
    },
    add: {
      providers: [
        {
          provide: ConversationRuntime,
          useFactory: () => ({
            timeline: new ConversationTimelineStub(),
            threads: { summaries: signal({}), list: signal([]) },
            pins: {
              messages: pinMessages.asReadonly(),
              eventIds: signal<readonly string[]>([]),
              canMutate: signal(false),
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
            activeRoomId: signal<string | null>('!r:hs'),
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
  setRouteRoom('!r:hs');
  const fixture = TestBed.createComponent(RoomsPage);
  fixture.detectChanges();
  lastRender = { fixture, activeAccountId: vm.activeAccountId };
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

describe('RoomsPage user panel presence', () => {
  const panelPresence = () =>
    (
      lastRender.fixture.debugElement.query(By.css('trn-sidebar-user-panel'))
        .componentInstance as SidebarUserPanelComponent
    ).presence();

  it('binds the active account’s presence and follows an account switch', () => {
    const me = signal<PresenceState | null>('online');
    const alt = signal<PresenceState | null>('unavailable');
    renderHeader(0, { '@me:hs': me, '@alt:hs': alt });
    expect(panelPresence()).toBe('online');

    me.set('offline');
    lastRender.fixture.detectChanges();
    expect(panelPresence()).toBe('offline');

    lastRender.activeAccountId.set('@alt:hs');
    lastRender.fixture.detectChanges();
    expect(panelPresence()).toBe('unavailable');
  });
});

describe('RoomsPage header title', () => {
  const topicRoom = (topic: string): RoomSummary => ({ ...ROOM, topic });

  it('shows a 24px avatar, no hash, and a divider with the topic', () => {
    const host = renderHeader(0, {}, topicRoom('Release planning'));
    const avatar = host.querySelector(
      '[data-testid="room-title"] trn-avatar',
    ) as HTMLElement | null;
    expect(avatar).not.toBeNull();
    expect(
      lastRender.fixture.debugElement
        .query(By.css('[data-testid="room-title"] trn-avatar'))
        .componentInstance.exactSize(),
    ).toBe(24);
    expect(host.querySelector('.title-hash')).toBeNull();
    expect(
      host.querySelector('[data-testid="room-topic"]')?.textContent?.trim(),
    ).toBe('Release planning');
    expect(
      host.querySelector('[data-testid="room-topic-divider"]'),
    ).not.toBeNull();
  });

  it('omits the divider and topic when the topic is empty', () => {
    const host = renderHeader(0);
    expect(host.querySelector('[data-testid="room-topic"]')).toBeNull();
    expect(host.querySelector('[data-testid="room-topic-divider"]')).toBeNull();
  });

  it('points the topic button at the popover', () => {
    const host = renderHeader(0, {}, topicRoom('Release planning'));
    const button = host.querySelector('[data-testid="room-topic"]');
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.getAttribute('popovertarget')).toBe('room-topic-popover');
    expect(host.querySelector('#room-topic-popover')).not.toBeNull();
  });

  it('shows markup in the topic as text and links as safe anchors', () => {
    const host = renderHeader(
      0,
      {},
      topicRoom('<img src=x onerror=alert(1)> see https://example.org'),
    );
    const popover = host.querySelector('#room-topic-popover') as HTMLElement;
    expect(popover.querySelector('img')).toBeNull();
    expect(popover.textContent).toContain('<img src=x onerror=alert(1)>');
    const links = popover.querySelectorAll(
      'a[href="https://example.org"][target="_blank"][rel~="noopener"]',
    );
    expect(links).toHaveLength(1);
  });

  it('keeps the heading named but visually empty with no room open', () => {
    const host = renderHeader(0, {}, null);
    const h1 = host.querySelector('h1') as HTMLElement;
    expect(h1.querySelector('.sr-only')?.textContent?.trim()).toBe('Trinity');
    expect(h1.querySelector('[data-testid="room-title"]')).toBeNull();
    h1.querySelector('.sr-only')?.remove();
    expect(h1.textContent?.trim()).toBe('');
  });

  it('does not render the topic below md', () => {
    const restore = stubNarrowLayout();
    try {
      const host = renderHeader(0, {}, topicRoom('Release planning'));
      expect(host.querySelector('[data-testid="room-topic"]')).toBeNull();
    } finally {
      restore();
    }
  });
});
