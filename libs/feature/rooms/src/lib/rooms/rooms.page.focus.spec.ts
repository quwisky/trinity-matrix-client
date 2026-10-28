import { RoomModerationService } from '@trinity/data-access/room-administration';
import { signal } from '@angular/core';
import { BELOW_MEMBERS_QUERY } from '@trinity/util/ui';
import { TestBed } from '@angular/core/testing';
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
import {
  MatrixClientService,
  SESSION_ENGINE,
} from '@trinity/data-access/matrix-client';
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
import { TimelineActionsService } from '@trinity/data-access/timeline';
import {
  TrnAlertService,
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import { MediaPipeline } from '@trinity/data-access/media';
import {
  FeatureFlagsService,
  HapticsService,
  MessageGestureSettingsService,
  ShellLayoutService,
} from '@trinity/platform-native';
import { MockComponent, MockProvider } from 'ng-mocks';
import { NEVER, of } from 'rxjs';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { ChannelSidebarComponent } from '../channel-sidebar/channel-sidebar.component';
import { SidebarUserPanelComponent } from '../channel-sidebar/sidebar-user-panel/sidebar-user-panel.component';
import { ConnectivityBannerComponent } from '../connectivity-banner/connectivity-banner.component';
import { EncryptionBannerComponent } from '../encryption-banner/encryption-banner.component';
import { MessageListComponent } from '../message-list/message-list.component';
import {
  NO_RAIL_UNREAD_CHATS,
  type RailUnreadChat,
  type RailUnreadChats,
} from '../server-rail/rail-unread-chats';
import { ServerRailComponent } from '../server-rail/server-rail.component';
import { TombstoneBannerComponent } from '../tombstone-banner/tombstone-banner.component';
import { IdentityChangeBannerComponent } from '../identity-change/identity-change-banner.component';
import { JoinRequestsBannerComponent } from '../join-requests-banner/join-requests-banner.component';
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
import {
  ROUTE_PROVIDER,
  SHARED_MOCKS,
  SYSTEM_STATUS_PROVIDER,
  RoomsTimelineStub,
  UNREAD_AGGREGATOR_PROVIDER,
  invitesProvider,
  matrixClientProvider,
  sessionStateProvider,
  IMAGE_PACKS_PROVIDER,
  setRouteRoom,
  shellFrom,
} from './rooms-page.spec-harness';
import { SessionActionsService } from './session-actions.service';
import { ShellShortcutsService } from './shell-shortcuts.service';
import { ShellStatusService } from './shell-status.service';
import { SpaceActionsService } from './space-actions.service';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { roomSummary } from '../testing/room-summary.fixture';
import { type RenderedRoomSurface } from './room-surface-lifecycle';
import { UserPickerService } from '../user-picker/user-picker.service';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';

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

beforeEach(() => setRouteRoom(null));

interface BuildOptions {
  /** Render the real space rail instead of a mock, so its entries can be activated. */
  readonly realRail?: boolean;
  readonly routing?: Partial<Record<keyof AccountRoutingService, unknown>>;
}

function buildPage({ realRail = false, routing = {} }: BuildOptions = {}) {
  const memberActions = { onSelectMember: vi.fn() };
  const vm = {
    accountBadges: signal(new Map()),
    accounts: signal([]),
    activeAccountId: signal<string | null>('@me:hs'),
    activeRoom: signal<RoomSummary | null>(ROOM),
    activeRoomIsDirect: signal(false),
    activeSpaceListed: signal(false),
    activeSpacePending: signal(false),
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
    members: signal<MemberSummary[]>([BOB]),
    membersView: signal({
      availability: 'coherent' as const,
      current: [BOB],
      stale: null,
    }),
    railSpaces: signal([]),
    railUnreadChats: signal<RailUnreadChats>(NO_RAIL_UNREAD_CHATS),
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
      // The timeline stores the text sender opens only listen for session changes.
      { provide: SESSION_ENGINE, useValue: { session: () => NEVER } },
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
      MockProvider(FeatureFlagsService, {
        virtualTimeline: signal(false),
        deferMediaWhileScrolling: signal(false),
        flingPlaceholders: signal(false),
      }),
      MockProvider(MatrixClientService, {
        activeUserId: signal<string | null>('@me:hs'),
      }),
      sessionStateProvider(),
      IMAGE_PACKS_PROVIDER,
      MockProvider(TrustService),
      MockProvider(IdentityPresenceService, {
        presenceFor: () => signal('offline'),
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
      ],
    },
    add: {
      providers: [
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
        { provide: MemberActionsService, useValue: memberActions },
        {
          provide: AccountRoutingService,
          useFactory: (surfaces: RoomSurfaceLifecycle) => ({
            onOpenRoomMembers: () =>
              surfaces.transition({ kind: 'toggle-members' }),
            ...routing,
          }),
          deps: [RoomSurfaceLifecycle],
        },
        { provide: InviteActionsService, useValue: {} },
        { provide: SpaceActionsService, useValue: {} },
        { provide: RoomActionsService, useValue: {} },
        { provide: ReadStateService, useValue: {} },
        {
          provide: MessageActionsService,
          useValue: { uploadProgress: signal(null) },
        },
        {
          provide: ShellShortcutsService,
          useValue: { bindSearchFocus: vi.fn() },
        },
        { provide: SessionActionsService, useValue: {} },
      ],
      imports: [
        realRail ? ServerRailComponent : MockComponent(ServerRailComponent),
        MockComponent(ChannelSidebarComponent),
        MockComponent(SidebarUserPanelComponent),
        MockComponent(PaneHandleComponent),
        MockComponent(MessageListComponent),
        MockComponent(EncryptionBannerComponent),
        MockComponent(ConnectivityBannerComponent),
        MockComponent(TombstoneBannerComponent),
        MockComponent(IdentityChangeBannerComponent),
        MockComponent(JoinRequestsBannerComponent),
      ],
    },
  });
  setRouteRoom('!r:hs');
  return { fixture: TestBed.createComponent(RoomsPage), vm, memberActions };
}

function showSurface(
  shell: ReturnType<typeof shellFrom>,
  surface: RenderedRoomSurface,
): void {
  if (surface.kind === 'thread') {
    shell.surfaces.transition({
      kind: 'open-thread',
      rootEventId: surface.rootEventId,
    });
    return;
  }
  if (
    surface.kind === 'threads' ||
    surface.kind === 'pinned' ||
    surface.kind === 'search'
  ) {
    shell.surfaces.transition({ kind: `open-${surface.kind}` });
    return;
  }
  shell.surfaces.transition({ kind: 'open-members' });
}

describe('RoomsPage rendered right-panel focus', () => {
  it('keeps the rendered roster and its focused row when a row opens member info', () => {
    // Member info is a modal surface over the roster (#1041): the row asks for it and the
    // slot keeps the list, so the dialog's focus restore has a row to come back to.
    const { fixture, memberActions } = buildPage();
    fixture.debugElement.injector
      .get(RoomSurfaceLifecycle)
      .transition({ kind: 'open-members' });
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const row = host.querySelector<HTMLElement>('[data-testid="member-row"]');
    expect(row).not.toBeNull();
    row!.focus();

    row!.click();
    fixture.detectChanges();
    TestBed.tick();

    expect(memberActions.onSelectMember).toHaveBeenCalledWith(BOB);
    expect(host.querySelector('trn-member-info')).toBeNull();
    expect(host.querySelector('[data-testid="member-row"]')).toBe(row);
    expect(document.activeElement).toBe(row);
  });

  it('returns focus to the members toggle when the members drawer X closes it', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === BELOW_MEMBERS_QUERY,
      media: query,
    }));
    try {
      const { fixture } = buildPage();
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      const toggle = host.querySelector<HTMLElement>(
        '[data-testid="toggle-members"]',
      );
      expect(toggle).not.toBeNull();
      toggle!.focus();

      toggle!.click();
      fixture.detectChanges();
      TestBed.tick();
      expect(document.activeElement).not.toBe(toggle);
      const close = host.querySelector<HTMLElement>(
        '[data-testid="close-members"]',
      );
      expect(close).not.toBeNull();

      close!.click();
      fixture.detectChanges();
      TestBed.tick();

      expect(host.querySelector('[data-testid="member-list"]')).toBeNull();
      expect(document.activeElement).toBe(toggle);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  let timelineOpen: Mock;
  let releaseAll: Mock;

  function build() {
    timelineOpen = vi.fn();
    releaseAll = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomLibraryService, {
          selectionAvailability: () => 'available',
          clearMarkedUnread: () => of(void 0),
          // ng-mocks >= 14.18 no longer stubs signal fields; the selected-library
          // projection reads this one.
          rooms: signal<RoomSummary[]>([]),
        }),
        MockProvider(SpacesService, {
          openSpace: () => of(void 0),
          spaces: signal([]),
        }),
        {
          provide: RoomsTimelineStub,
          useFactory: () => {
            const timeline = new RoomsTimelineStub();
            timeline.focusRoom = vi.fn((roomId: string) => {
              timelineOpen(roomId);
              timeline.open(roomId);
            });
            return timeline;
          },
        },
        MockProvider(TimelineActionsService),
        MockProvider(MediaPipeline, { releaseAll }),
        matrixClientProvider(),
        sessionStateProvider(),
        UNREAD_AGGREGATOR_PROVIDER,
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(TrnSurfaceService),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  it('gives focus back to whatever opened the slot once it empties', () => {
    // CDK did this for the four dialogs these panels replaced. Without it a keyboard user who
    // opens Threads, reads the list and closes it lands on `<body>` — and in-room search is
    // worse, because it deliberately takes focus when it opens.
    const shell = build();
    setRouteRoom('!r:hs');
    shell.page.closeRightPanel();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    try {
      trigger.focus();

      shell.surfaces.transition({ kind: 'open-threads' });
      TestBed.tick();
      trigger.blur(); // the panel took focus, then its removal orphans it
      shell.page.clearRightPanel();
      TestBed.tick();
      TestBed.tick(); // the restore is deferred to after the render that removes the panel

      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });

  it('leaves focus alone when something else has claimed it', () => {
    // The room-change handoff, or a DM the panel just opened, has a better idea than a
    // remembered button does — so the restore only fires when the removal orphaned focus.
    const shell = build();
    setRouteRoom('!r:hs');
    shell.page.closeRightPanel();
    const trigger = document.createElement('button');
    const elsewhere = document.createElement('button');
    document.body.append(trigger, elsewhere);
    try {
      trigger.focus();
      shell.surfaces.transition({ kind: 'open-threads' });
      TestBed.tick();

      shell.page.clearRightPanel();
      elsewhere.focus();
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(elsewhere);
    } finally {
      trigger.remove();
      elsewhere.remove();
    }
  });

  it.each<{
    name: string;
    from: RenderedRoomSurface;
    to: RenderedRoomSurface;
    targetTag: 'button' | 'input';
  }>([
    {
      name: 'threads → thread',
      from: { kind: 'threads' },
      to: { kind: 'thread', rootEventId: '$root' },
      targetTag: 'button',
    },
    {
      name: 'members → pinned',
      from: { kind: 'members' },
      to: { kind: 'pinned' },
      targetTag: 'button',
    },
    {
      name: 'search → members',
      from: { kind: 'search' },
      to: { kind: 'members' },
      targetTag: 'input',
    },
  ])('hands focus to the replacement on $name', ({ from, to, targetTag }) => {
    const shell = build();
    setRouteRoom('!r:hs');
    shell.page.closeRightPanel();
    TestBed.tick();
    const trigger = document.createElement('button');
    const slot = document.createElement('div');
    slot.dataset['rightPanelSlot'] = '';
    document.body.append(trigger, slot);
    try {
      trigger.focus();
      showSurface(shell, from);
      TestBed.tick();

      const source = document.createElement('button');
      slot.append(source);
      source.focus();
      showSurface(shell, to);
      source.remove(); // the outgoing panel's render removal orphans focus
      const target = document.createElement(targetTag);
      target.dataset['rightPanelFocus'] = '';
      slot.append(target);
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(target);
    } finally {
      trigger.remove();
      slot.remove();
    }
  });

  it('restores the original external trigger after an inline swap then close', () => {
    const shell = build();
    setRouteRoom('!r:hs');
    shell.page.closeRightPanel();
    TestBed.tick();
    const trigger = document.createElement('button');
    const slot = document.createElement('div');
    slot.dataset['rightPanelSlot'] = '';
    document.body.append(trigger, slot);
    try {
      trigger.focus();
      shell.surfaces.transition({ kind: 'open-threads' });
      TestBed.tick();

      const source = document.createElement('button');
      slot.append(source);
      source.focus();
      shell.surfaces.transition({
        kind: 'open-thread',
        rootEventId: '$root',
      });
      source.remove();
      const threadClose = document.createElement('button');
      threadClose.dataset['rightPanelFocus'] = '';
      slot.append(threadClose);
      TestBed.tick();
      TestBed.tick();
      expect(document.activeElement).toBe(threadClose);

      shell.page.clearRightPanel();
      slot.remove();
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
      slot.remove();
    }
  });

  it('remembers an outside opener when the wide roster was already open', () => {
    const shell = build();
    setRouteRoom('!r:hs');
    showSurface(shell, { kind: 'members' });
    expect(shell.surfaces.renderedSurface()).toEqual({ kind: 'members' });
    TestBed.tick(); // establish the already-rendered roster before its toolbar replacement
    const trigger = document.createElement('button');
    const slot = document.createElement('div');
    slot.dataset['rightPanelSlot'] = '';
    document.body.append(trigger, slot);
    try {
      trigger.focus();
      shell.surfaces.transition({ kind: 'open-threads' });
      TestBed.tick();

      const threadRow = document.createElement('button');
      slot.append(threadRow);
      threadRow.focus();
      shell.surfaces.transition({
        kind: 'open-thread',
        rootEventId: '$root',
      });
      threadRow.remove();
      const threadClose = document.createElement('button');
      threadClose.dataset['rightPanelFocus'] = '';
      slot.append(threadClose);
      TestBed.tick();
      TestBed.tick();
      expect(document.activeElement).toBe(threadClose);

      shell.page.clearRightPanel();
      slot.remove();
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
      slot.remove();
    }
  });

  it('remembers a timeline opener beside an open wide roster', () => {
    const shell = build();
    setRouteRoom('!r:hs');
    showSurface(shell, { kind: 'members' });
    expect(shell.surfaces.renderedSurface()).toEqual({ kind: 'members' });
    TestBed.tick();
    const slot = document.createElement('div');
    slot.dataset['rightPanelSlot'] = '';
    const timelineTrigger = document.createElement('button');
    slot.append(timelineTrigger);
    document.body.append(slot);
    try {
      timelineTrigger.focus();
      shell.surfaces.transition({
        kind: 'open-thread',
        rootEventId: '$root',
      });
      TestBed.tick();

      const panel = document.createElement('div');
      panel.dataset['rightPanelSurface'] = '';
      const threadClose = document.createElement('button');
      threadClose.dataset['rightPanelFocus'] = '';
      panel.append(threadClose);
      slot.append(panel);
      threadClose.focus();

      shell.page.clearRightPanel();
      panel.remove();
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(timelineTrigger);
    } finally {
      slot.remove();
    }
  });

  it('does not steal focus claimed while an inline swap renders', () => {
    const shell = build();
    setRouteRoom('!r:hs');
    shell.page.closeRightPanel();
    TestBed.tick();
    const trigger = document.createElement('button');
    const elsewhere = document.createElement('button');
    const slot = document.createElement('div');
    slot.dataset['rightPanelSlot'] = '';
    document.body.append(trigger, elsewhere, slot);
    try {
      trigger.focus();
      shell.surfaces.transition({ kind: 'open-threads' });
      TestBed.tick();

      const source = document.createElement('button');
      slot.append(source);
      source.focus();
      shell.surfaces.transition({
        kind: 'open-thread',
        rootEventId: '$root',
      });
      source.remove();
      const target = document.createElement('button');
      target.dataset['rightPanelFocus'] = '';
      slot.append(target);
      elsewhere.focus();
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(elsewhere);
    } finally {
      trigger.remove();
      elsewhere.remove();
      slot.remove();
    }
  });
});

const UNREAD_CHAT: RailUnreadChat = {
  key: '@me:hs\u0000!c:hs',
  selection: { accountId: '@me:hs', roomId: '!c:hs' },
  name: 'Team',
  initial: 'T',
  avatarMxc: null,
  direct: false,
  countLabel: '3',
  accountBadge: null,
  label: 'Team · 3 unread',
  activityTs: 0,
};

describe('RoomsPage rail unread chat focus', () => {
  it('moves focus into the conversation when the activated entry leaves the rail', () => {
    let ready: (() => void) | undefined;
    const onSelectRoomSelection = vi.fn(
      (_selection: unknown, _origin: unknown, onReady?: () => void) => {
        ready = onReady;
      },
    );
    const { fixture, vm } = buildPage({
      realRail: true,
      routing: { onSelectRoomSelection },
    });
    vm.railUnreadChats.set({
      entries: [UNREAD_CHAT],
      overflow: 0,
      overflowEntries: [],
    });
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const entry = host.querySelector<HTMLElement>(
      '[data-testid="rail-unread-chat"] button',
    )!;
    expect(entry).not.toBeNull();
    entry.focus();
    expect(document.activeElement).toBe(entry);

    entry.click();
    // Workspace opens the chat: the split view stops listing it, then navigation is ready.
    vm.railUnreadChats.set(NO_RAIL_UNREAD_CHATS);
    ready?.();
    fixture.detectChanges();
    TestBed.tick();

    expect(host.querySelector('[data-testid="rail-unread-chat"]')).toBeNull();
    const active = document.activeElement;
    expect(active).not.toBe(document.body);
    expect(active?.isConnected).toBe(true);
    expect(active).toBe(host.querySelector('main'));
    expect(onSelectRoomSelection).toHaveBeenCalledWith(
      UNREAD_CHAT.selection,
      'rail-unread',
      expect.any(Function),
    );
  });

  it('leaves focus alone when something else took it before the chat opened', () => {
    let ready: (() => void) | undefined;
    const { fixture, vm } = buildPage({
      realRail: true,
      routing: {
        onSelectRoomSelection: (
          _selection: unknown,
          _origin: unknown,
          onReady?: () => void,
        ) => {
          ready = onReady;
        },
      },
    });
    vm.railUnreadChats.set({
      entries: [UNREAD_CHAT],
      overflow: 0,
      overflowEntries: [],
    });
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    host
      .querySelector<HTMLElement>('[data-testid="rail-unread-chat"] button')!
      .click();
    const recent = host.querySelector<HTMLElement>(
      '[data-testid="rail-recent"]',
    )!;
    recent.focus();

    vm.railUnreadChats.set(NO_RAIL_UNREAD_CHATS);
    ready?.();
    fixture.detectChanges();
    TestBed.tick();

    expect(document.activeElement).toBe(recent);
  });
});
