import { RoomModerationService } from '@trinity/data-access/room-administration';
import { signal } from '@angular/core';
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
import { TimelineActionsService } from '@trinity/data-access/timeline';
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
import { RoomShellStore } from './room-shell-store';
import { RoomShellViewModel } from './room-shell-view-model';
import { RoomsPage } from './rooms.page';
import { ROUTE_PROVIDER, setRouteRoom } from './rooms-page.spec-harness';
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

describe('RoomsPage rendered right-panel focus', () => {
  it('hands focus through the real members → member @switch render', () => {
    const vm = {
      accountBadges: signal(new Map()),
      accounts: signal([]),
      activeAccountId: signal<string | null>('@me:hs'),
      activeRoom: signal<RoomSummary | null>(ROOM),
      activeRoomIsDirect: signal(false),
      anyRoomUnread: signal(false),
      canConfigureSpace: signal(false),
      canCurateSpace: signal(false),
      roomInvitePermission: signal({ available: false, reason: null }),
      spaceCuratePermission: signal({ available: false, reason: null }),
      spaceInvitePermission: signal({ available: false, reason: null }),
      defaultSpaceSortMode: signal('recent'),
      filteredRooms: signal<RoomSummary[]>([]),
      loadHomeserverInfo: vi.fn(),
      members: signal<MemberSummary[]>([BOB]),
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
          connect: vi.fn(),
          createDirectMessage: vi.fn(() => of('!dm:hs')),
        }),
        MockProvider(SpacesService, {
          connect: vi.fn(),
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
        MockProvider(InvitesService, { connect: vi.fn() }),
        MockProvider(TimelineActionsService),
        MockProvider(FeatureFlagsService, { virtualTimeline: signal(false) }),
        MockProvider(MatrixClientService, {
          activeUserId: signal<string | null>('@me:hs'),
        }),
        MockProvider(TrustService, { connect: vi.fn() }),
        MockProvider(IdentityPresenceService, {
          connect: vi.fn(),
          presenceFor: () => signal('offline'),
        }),
        MockProvider(SpaceChildrenService, { connect: vi.fn() }),
        MockProvider(RoomMembersService, { connect: vi.fn() }),
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
            useFactory: (store: RoomShellStore) => ({
              onSelectMember: (member: MemberSummary) =>
                store.rightPanel.set({
                  kind: 'member',
                  member,
                  direct: false,
                }),
            }),
            deps: [RoomShellStore],
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
    const host = fixture.nativeElement as HTMLElement;
    const row = host.querySelector<HTMLElement>('[data-testid="member-row"]');
    expect(row).not.toBeNull();
    row!.focus();

    row!.click();
    fixture.detectChanges();
    TestBed.tick();

    const target = host.querySelector<HTMLElement>(
      '[data-testid="member-info-close"]',
    );
    expect(target).not.toBeNull();
    expect(target?.closest('[data-right-panel-surface]')?.tagName).toBe(
      'TRN-MEMBER-INFO',
    );
    expect(document.activeElement).toBe(target);
  });
});
