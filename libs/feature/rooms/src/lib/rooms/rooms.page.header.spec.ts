import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { MessageListComponent } from '../message-list/message-list.component';
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
  stubNarrowLayout,
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
        MessageListComponent,
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
        MockComponent(MessageListComponent),
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

describe('RoomsPage header title', () => {
  const topicRoom = (topic: string): RoomSummary => ({ ...ROOM, topic });

  it('shows a 24px avatar, no hash, and a divider with the topic', () => {
    const host = renderHeader(0, { room: topicRoom('Release planning') });
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

  it('hides the decorative avatar so the heading names the room once', () => {
    const host = renderHeader(0);
    expect(
      host
        .querySelector('[data-testid="room-title"] trn-avatar')
        ?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  it('omits the divider and topic when the topic is empty', () => {
    const host = renderHeader(0);
    expect(host.querySelector('[data-testid="room-topic"]')).toBeNull();
    expect(host.querySelector('[data-testid="room-topic-divider"]')).toBeNull();
  });

  it('points the topic button at the popover', () => {
    const host = renderHeader(0, { room: topicRoom('Release planning') });
    const button = host.querySelector('[data-testid="room-topic"]');
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.getAttribute('popovertarget')).toBe('room-topic-popover');
    expect(host.querySelector('#room-topic-popover')).not.toBeNull();
  });

  it('shows markup in the topic as text and links as safe anchors', () => {
    const host = renderHeader(0, {
      room: topicRoom('<img src=x onerror=alert(1)> see https://example.org'),
    });
    const popover = host.querySelector('#room-topic-popover') as HTMLElement;
    expect(popover.querySelector('img')).toBeNull();
    expect(popover.textContent).toContain('<img src=x onerror=alert(1)>');
    const links = popover.querySelectorAll(
      'a[href="https://example.org"][target="_blank"][rel~="noopener"]',
    );
    expect(links).toHaveLength(1);
  });

  it('treats a literal anchor tag in the topic as text, not a link', () => {
    const host = renderHeader(0, {
      room: topicRoom('<a href="javascript:alert(1)">hi</a>'),
    });
    const popover = host.querySelector('#room-topic-popover') as HTMLElement;
    expect(popover.querySelector('a')).toBeNull();
    expect(popover.textContent).toContain(
      '<a href="javascript:alert(1)">hi</a>',
    );
  });

  it('caps the name width only while a topic is shown', () => {
    const withTopic = renderHeader(0, { room: topicRoom('Release planning') });
    expect(
      withTopic
        .querySelector('.title-room')
        ?.classList.contains('title-room--topic'),
    ).toBe(true);
    TestBed.resetTestingModule();
    const without = renderHeader(0);
    expect(
      without
        .querySelector('.title-room')
        ?.classList.contains('title-room--topic'),
    ).toBe(false);
  });

  it('keeps the heading named but visually empty with no room open', () => {
    const host = renderHeader(0, { room: null });
    const h1 = host.querySelector('h1') as HTMLElement;
    expect(h1.querySelector('.sr-only')?.textContent?.trim()).toBe('Trinity');
    expect(h1.querySelector('[data-testid="room-title"]')).toBeNull();
    h1.querySelector('.sr-only')?.remove();
    expect(h1.textContent?.trim()).toBe('');
  });

  it('does not render the topic below md', () => {
    const restore = stubNarrowLayout();
    try {
      const host = renderHeader(0, { room: topicRoom('Release planning') });
      expect(host.querySelector('[data-testid="room-topic"]')).toBeNull();
    } finally {
      restore();
    }
  });
});

describe('RoomsPage topic popover stylesheet', () => {
  const scss = readFileSync(join(__dirname, 'rooms.page.scss'), 'utf8');

  it('applies anchor positioning and the margin reset only where supported', () => {
    const supports = scss.match(
      /@supports \(top: anchor\(bottom\)\) \{[\s\S]*?\n {2}\}/,
    );
    expect(supports).not.toBeNull();
    for (const decl of ['position-anchor', 'top: anchor(', 'margin: 0']) {
      expect(supports![0]).toContain(decl);
    }
    expect(scss.replace(supports![0], '')).not.toMatch(/anchor\(|margin: 0;/);
  });

  it('leaves the closed popover to the UA display: none', () => {
    const rule = scss.match(/\n {2}\.topic-popover \{[\s\S]*?\n {2}\}/);
    expect(rule).not.toBeNull();
    expect(rule![0]).not.toMatch(/\bdisplay:/);
  });

  it('flips the anchored popover inline when it would overflow', () => {
    expect(scss).toContain('position-try-fallbacks: flip-inline');
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

  it('orders threads, pinned, members, the search field, then the overflow', () => {
    const root = renderHeader(0);
    const actions = [
      'open-threads',
      'open-pinned',
      'toggle-members',
      'header-search',
      'room-actions-overflow',
    ].map((id) => byId(root, id) as HTMLElement);
    actions.forEach((el, i) => {
      if (i > 0) {
        expect(
          actions[i - 1].compareDocumentPosition(el) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    });
  });

  it('moves invite and room settings into the overflow menu', () => {
    const root = renderHeader(0);
    expect(byId(root, 'invite-people')).toBeNull();
    expect(byId(root, 'open-room-settings')).toBeNull();
    const source = readFileSync(join(__dirname, 'rooms.page.html'), 'utf8');
    expect(source).toContain('data-testid="overflow-invite-people"');
    expect(source).toContain('data-testid="overflow-open-room-settings"');
  });

  it('marks only the open panel button as pressed', () => {
    const root = renderHeader(0);
    const pressed = () =>
      ['open-threads', 'open-pinned', 'toggle-members'].map((id) =>
        byId(root, id)?.getAttribute('aria-pressed'),
      );
    expect(pressed()).toEqual(['false', 'false', 'false']);
    surfaces().transition({ kind: 'open-threads' });
    lastRender.fixture.detectChanges();
    expect(pressed()).toEqual(['true', 'false', 'false']);
    surfaces().transition({ kind: 'open-pinned' });
    lastRender.fixture.detectChanges();
    expect(pressed()).toEqual(['false', 'true', 'false']);
    surfaces().transition({ kind: 'open-members' });
    lastRender.fixture.detectChanges();
    expect(pressed()).toEqual(['false', 'false', 'true']);
  });

  it('names the field after the room', () => {
    const field = byId(renderHeader(0), 'header-search');
    expect(field?.getAttribute('placeholder')).toBe('Search General');
  });

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

  it('clears and blurs the field on Escape', async () => {
    const root = renderHeader(0);
    document.body.append(root);
    const field = await typeInHeader(root, 'hello');
    field.focus();
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    lastRender.fixture.detectChanges();
    expect(field.value).toBe('');
    expect(document.activeElement).not.toBe(field);
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

  it('shows the inline field only beside static panels, else the icon', () => {
    const root = renderHeader(0);
    expect(byId(root, 'header-search')?.classList).toContain(
      'max-members:hidden',
    );
    expect(byId(root, 'search-messages')?.classList).toContain(
      'members:hidden',
    );
  });

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

  it('keeps the threads button pressed while a single thread is open', () => {
    const root = renderHeader(0);
    surfaces().transition({ kind: 'open-thread', rootEventId: '$root' });
    lastRender.fixture.detectChanges();
    expect(byId(root, 'open-threads')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
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
