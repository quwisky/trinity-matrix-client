import {
  ApplicationRef,
  computed,
  signal,
  type Provider,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { KeyboardShortcutsService } from '@trinity/platform-native';
import { Router } from '@angular/router';
import { AuthService } from '@trinity/data-access/auth';
import { CryptoService } from '@trinity/data-access/crypto';
import {
  InvitesService,
  MixedInvitesService,
  type PendingInvite,
} from '@trinity/data-access/invites';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MediaService } from '@trinity/data-access/media';
import { RoomNotificationsService } from '@trinity/data-access/notifications';
import { PinnedMessagesService } from '@trinity/data-access/pinned';
import {
  RoomsService,
  RoomSettingsService,
  RoomModerationService,
  RoomAliasesService,
  PublicRoomsService,
  SpacesService,
  AccountScopeService,
  MixedRoomsService,
  MixedSpacesService,
  UnreadAggregatorService,
  SpaceChildrenService,
  SpaceRoomOrderService,
  TRINITY_ROOM_SORTS,
  type RoomSortMode,
  type RoomSummary,
  type SpaceChildRoom,
  type SpaceSummary,
} from '@trinity/data-access/rooms';
import { ThreadsService, TimelineService } from '@trinity/data-access/timeline';
import {
  TrnActionSheetService,
  TrnAlertService,
  TrnDialogService,
  TrnToastService,
} from '@trinity/helm/overlay';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { MessageActionsService } from './message-actions.service';
import { ShellShortcutsService } from './shell-shortcuts.service';
import { SessionActionsService } from './session-actions.service';
import { ThreadPanelService } from '../thread/thread-panel.service';
import { PinnedPanelService } from '../pinned/pinned-panel.service';
import { UserPickerService } from '../user-picker/user-picker.service';
import { UserCardService } from '../user-card/user-card.service';
import { MemberInfoService } from '../member-info/member-info.service';
import { RoomSettingsComponent } from '../room-settings/room-settings.component';
import { AddToSpaceComponent } from '../add-to-space/add-to-space.component';
import { ManageSpaceRoomsComponent } from '../manage-space-rooms/manage-space-rooms.component';
import { SpaceMembersComponent } from '../space-members/space-members.component';
import { SpaceSettingsComponent } from '../space-settings/space-settings.component';
import { RoomDirectoryComponent } from '../room-directory/room-directory.component';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { MessageSearchService } from '../message-search/message-search.service';

/**
 * Providers every TestBed block in this file supplies identically, with no stub.
 *
 * Only tokens that are bare in ALL twelve blocks live here. The blocks are deliberately
 * divergent elsewhere — RoomsService is richly stubbed in some and bare in others, for
 * instance — so folding a stubbed token in here would silently change what a describe
 * asserts against, and every test would still pass against different data.
 *
 * This is also the single place to register a page-scoped provider: services listed in
 * a component's `providers:` array are invisible to `TestBed.inject(RoomsPage)`, so each
 * one has to be supplied to the TestBed by hand, in every block.
 */
const SHARED_MOCKS: Provider[] = [
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
  MockProvider(Router),
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
function shellFrom() {
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
function invitesProvider(over: Partial<InvitesService> = {}) {
  return MockProvider(InvitesService, {
    pendingInvites: signal<PendingInvite[]>([]),
    acceptInvite: () => of(undefined),
    declineInvite: () => of(undefined),
    ...over,
  });
}

/** Stub matchMedia so every query matches — the narrow layout where the member list is
 * the overlay drawer. Returns a restore function to reinstate the previous stub. */
function stubNarrowLayout(): () => void {
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

// Instantiate the page through DI without rendering (the shell template pulls in
// many child components); we only exercise the action handlers' error feedback.
describe('RoomsPage action error feedback', () => {
  let edit: ReturnType<typeof vi.fn>;
  let toastShow: ReturnType<typeof vi.fn>;
  let sendMedia: ReturnType<typeof vi.fn>;
  let setNotifyMode: ReturnType<typeof vi.fn>;
  let leaveRoom: ReturnType<typeof vi.fn>;
  let alertConfirm: ReturnType<typeof vi.fn>;
  let roomsSignal: WritableSignal<RoomSummary[]>;
  let editableFields: ReturnType<typeof vi.fn>;
  let currentAccess: ReturnType<typeof vi.fn>;
  let canManageBans: ReturnType<typeof vi.fn>;
  let canManageAliases: ReturnType<typeof vi.fn>;
  let parentSpaceIds: ReturnType<typeof vi.fn>;
  let railSpacesSignal: ReturnType<typeof signal<SpaceSummary[]>>;
  let supportsRestricted: ReturnType<typeof vi.fn>;
  let canCurate: ReturnType<typeof vi.fn>;
  let spaceCanModerate: ReturnType<typeof vi.fn>;
  let spaceMemberInfoOpen: ReturnType<typeof vi.fn>;
  let createSpace: ReturnType<typeof vi.fn>;
  let addExistingRoom: ReturnType<typeof vi.fn>;
  let currentIdentity: ReturnType<typeof vi.fn>;
  let joinPublicRoom: ReturnType<typeof vi.fn>;
  let markReadFn: ReturnType<typeof vi.fn>;
  let setMarkedUnreadFn: ReturnType<typeof vi.fn>;
  let clearMarkedUnreadFn: ReturnType<typeof vi.fn>;

  function build() {
    toastShow = vi.fn();
    edit = vi.fn();
    sendMedia = vi.fn(() => of(undefined));
    setNotifyMode = vi.fn(() => of(undefined));
    leaveRoom = vi.fn(() => of(undefined));
    alertConfirm = vi.fn().mockResolvedValue(true);
    roomsSignal = signal<RoomSummary[]>([]);
    editableFields = vi.fn(() => ({
      name: true,
      topic: false,
      avatar: false,
      joinRule: false,
      history: false,
    }));
    currentAccess = vi.fn(() => ({
      joinRule: 'invite',
      historyVisibility: 'shared',
      allowedSpaceIds: [] as string[],
    }));
    parentSpaceIds = vi.fn(() => [] as string[]);
    railSpacesSignal = signal<SpaceSummary[]>([]);
    supportsRestricted = vi.fn(() => false);
    canCurate = vi.fn(() => true);
    spaceCanModerate = vi.fn(() => ({}) as never);
    spaceMemberInfoOpen = vi.fn().mockResolvedValue(null);
    createSpace = vi.fn(() => of('!new-space:hs'));
    addExistingRoom = vi.fn(() => of(undefined));
    currentIdentity = vi.fn(() => ({
      name: '',
      topic: '',
      avatarMxc: null as string | null,
    }));
    canManageBans = vi.fn(() => false);
    canManageAliases = vi.fn(() => false);
    joinPublicRoom = vi.fn(() => of('!new:hs'));
    markReadFn = vi.fn(() => of(undefined));
    setMarkedUnreadFn = vi.fn(() => of(undefined));
    clearMarkedUnreadFn = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService, {
          leave: leaveRoom,
          rooms: roomsSignal,
          directRoomIds: signal<ReadonlySet<string>>(new Set()).asReadonly(),
          markRead: markReadFn,
          setMarkedUnread: setMarkedUnreadFn,
          clearMarkedUnread: clearMarkedUnreadFn,
        }),
        MockProvider(RoomSettingsService, {
          editableFields,
          currentAccess,
          supportsRestricted,
          currentIdentity,
        }),
        MockProvider(RoomModerationService, {
          canManageBans,
          canModerate: spaceCanModerate,
        }),
        MockProvider(MemberInfoService, { open: spaceMemberInfoOpen }),
        MockProvider(RoomAliasesService, { canManageAliases }),
        MockProvider(PublicRoomsService, { join: joinPublicRoom }),
        MockProvider(SpacesService, {
          parentSpaceIds,
          spaces: railSpacesSignal,
          createSpace,
        }),
        MockProvider(AccountScopeService, { mixing: signal(false) }),
        MockProvider(SpaceChildrenService, { canCurate, addExistingRoom }),
        MockProvider(TrnAlertService, { confirm: alertConfirm }),
        MockProvider(TimelineService, { edit, sendMedia }),
        MockProvider(MediaService),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>(['@me:hs']).asReadonly(),
          clientFor: () => ({ getUser: () => null }) as never,
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map(),
          ).asReadonly(),
        }),
        MockProvider(ThreadsService),
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(MessageSearchService),
        MockProvider(AuthService),
        MockProvider(TrnDialogService),
        MockProvider(TrnToastService, { show: toastShow }),
        MockProvider(RoomNotificationsService, { setMode: setNotifyMode }),
      ],
    });
    return shellFrom();
  }

  it('shows a danger toast when an edit fails', () => {
    const shell = build();
    edit.mockReturnValue(throwError(() => new Error('nope')));

    shell.messages.onEdit({ id: '$1', body: 'x' });

    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('does not toast when the action succeeds', () => {
    const shell = build();
    edit.mockReturnValue(of(undefined));

    shell.messages.onEdit({ id: '$1', body: 'x' });

    expect(toastShow).not.toHaveBeenCalled();
  });

  // Favouriting moved into ChannelSidebarComponent (it now calls RoomsService
  // directly), so that behaviour is covered by channel-sidebar.component.spec.ts.

  it('applies a notification level chosen from the sidebar room menu', () => {
    const shell = build();

    shell.readState.onSetNotifyMode({ roomId: '!r:hs', mode: 'mentions' });

    expect(setNotifyMode).toHaveBeenCalledWith('!r:hs', 'mentions', undefined);
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('shows a danger toast when setting a notification level fails', () => {
    const shell = build();
    setNotifyMode.mockReturnValue(throwError(() => new Error('nope')));

    shell.readState.onSetNotifyMode({ roomId: '!r:hs', mode: 'mute' });

    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('leaves a room after confirmation and clears it if it was the open one', async () => {
    const shell = build();
    shell.store.activeRoomId.set('!r:hs');

    await shell.rooms.onLeaveRoom({ roomId: '!r:hs' });

    expect(alertConfirm).toHaveBeenCalled();
    expect(leaveRoom).toHaveBeenCalledWith('!r:hs', undefined);
    expect(shell.store.activeRoomId()).toBeNull();
    // Tear every open-room projection down so none keeps listening on it.
    expect(TestBed.inject(TimelineService).close).toHaveBeenCalled();
    expect(TestBed.inject(ThreadsService).close).toHaveBeenCalled();
    expect(TestBed.inject(ThreadsService).closeThread).toHaveBeenCalled();
    expect(TestBed.inject(PinnedMessagesService).close).toHaveBeenCalled();
    expect(TestBed.inject(MediaService).releaseAll).toHaveBeenCalled();
  });

  // Leaving is irreversible for a private room, so a mixed-in row must leave on ITS
  // account rather than falling through to whichever one happens to be active.
  it('leaves a foreign-account room on its own account', async () => {
    const shell = build();

    await shell.rooms.onLeaveRoom({ roomId: '!r:hs', accountId: '@alt:hs' });

    expect(leaveRoom).toHaveBeenCalledWith('!r:hs', '@alt:hs');
  });

  it('leaves a room but keeps a different open room selected', async () => {
    const shell = build();
    shell.store.activeRoomId.set('!other:hs');

    await shell.rooms.onLeaveRoom({ roomId: '!r:hs' });

    expect(leaveRoom).toHaveBeenCalledWith('!r:hs', undefined);
    expect(shell.store.activeRoomId()).toBe('!other:hs');
    // The open room wasn't the one left, so its projections stay put.
    expect(TestBed.inject(TimelineService).close).not.toHaveBeenCalled();
  });

  it('does not leave a room when the confirmation is cancelled', async () => {
    const shell = build();
    alertConfirm.mockResolvedValue(false);

    await shell.rooms.onLeaveRoom({ roomId: '!r:hs' });

    expect(leaveRoom).not.toHaveBeenCalled();
  });

  it('shows a danger toast when leaving a room fails', async () => {
    const shell = build();
    leaveRoom.mockReturnValue(throwError(() => new Error('nope')));

    await shell.rooms.onLeaveRoom({ roomId: '!r:hs' });

    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  /** A rail space owned by `accountId`, which is what the mixed-account gate turns on. */
  function railSpace(id: string, accountId = '@me:hs') {
    return {
      id,
      accountId,
      name: `Space ${id}`,
      initial: 'S',
      avatarMxc: null,
      childRoomIds: [],
    };
  }

  it('opens the space members dialog and routes a pick to member info', async () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    railSpacesSignal.set([railSpace('!s:hs')]);
    const picked = {
      userId: '@a:hs',
      name: 'Ada',
      initial: 'A',
      avatarMxc: null,
      powerLevel: 0,
      isCreator: false,
    };
    (
      TestBed.inject(TrnDialogService).openAndWait as ReturnType<typeof vi.fn>
    ).mockResolvedValue(picked);

    shell.spaces.onOpenSpaceMembers();
    await Promise.resolve();
    await Promise.resolve();

    expect(TestBed.inject(TrnDialogService).openAndWait).toHaveBeenCalledWith(
      SpaceMembersComponent,
      expect.objectContaining({
        inputs: expect.objectContaining({ spaceId: '!s:hs' }),
      }),
    );
    // Moderation caps are resolved against the SPACE, so kick/ban act where the user is.
    expect(spaceCanModerate).toHaveBeenCalledWith('!s:hs', '@a:hs');
  });

  it('does not open member info when the members dialog is dismissed', async () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    railSpacesSignal.set([railSpace('!s:hs')]);
    (
      TestBed.inject(TrnDialogService).openAndWait as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);

    shell.spaces.onOpenSpaceMembers();
    await Promise.resolve();
    await Promise.resolve();

    expect(spaceCanModerate).not.toHaveBeenCalled();
  });

  it('creates a subspace and links it into the active space', async () => {
    const shell = build();
    shell.store.activeSpaceId.set('!parent:hs');
    railSpacesSignal.set([railSpace('!parent:hs')]);
    alertConfirm.mockResolvedValue(true);
    const prompt = TestBed.inject(TrnAlertService).prompt as ReturnType<
      typeof vi.fn
    >;
    prompt.mockResolvedValue('Sub');

    await shell.spaces.onCreateSubspace();

    expect(createSpace).toHaveBeenCalledWith({ name: 'Sub' });
    // The link is the whole point — a space created and not nested is just a space.
    expect(addExistingRoom).toHaveBeenCalledWith('!parent:hs', '!new-space:hs');
  });

  it('does not create a subspace without power to curate', async () => {
    const shell = build();
    shell.store.activeSpaceId.set('!parent:hs');
    railSpacesSignal.set([railSpace('!parent:hs')]);
    canCurate.mockReturnValue(false);

    await shell.spaces.onCreateSubspace();

    expect(createSpace).not.toHaveBeenCalled();
  });

  it('opens the add-rooms picker for the active space', () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    railSpacesSignal.set([railSpace('!s:hs')]);

    shell.spaces.onAddToSpace();

    expect(TestBed.inject(TrnDialogService).openAndWait).toHaveBeenCalledWith(
      AddToSpaceComponent,
      expect.objectContaining({
        inputs: expect.objectContaining({ spaceId: '!s:hs' }),
      }),
    );
  });

  it('opens the curation dialog for the active space', () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    railSpacesSignal.set([railSpace('!s:hs')]);

    shell.spaces.onManageSpaceRooms();

    expect(TestBed.inject(TrnDialogService).openAndWait).toHaveBeenCalledWith(
      ManageSpaceRoomsComponent,
      expect.objectContaining({
        inputs: expect.objectContaining({ spaceId: '!s:hs' }),
      }),
    );
  });

  it('refuses both curation dialogs without power to curate', () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    railSpacesSignal.set([railSpace('!s:hs')]);
    canCurate.mockReturnValue(false);

    expect(shell.vm.canCurateSpace()).toBe(false);
    shell.spaces.onAddToSpace();
    shell.spaces.onManageSpaceRooms();

    expect(TestBed.inject(TrnDialogService).openAndWait).not.toHaveBeenCalled();
  });

  it('refuses to curate another account’s space', () => {
    // Same reasoning as Space settings: the write goes through the ACTIVE client, so it
    // would land on the wrong account or nowhere.
    const shell = build();
    shell.store.activeSpaceId.set('!theirs:hs');
    railSpacesSignal.set([railSpace('!theirs:hs', '@other:hs')]);
    canCurate.mockReturnValue(true);

    expect(shell.vm.canCurateSpace()).toBe(false);
  });

  it('separates curating from configuring, which are different power levels', () => {
    // A moderator can curate the child list without being able to rename the space.
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    railSpacesSignal.set([railSpace('!s:hs')]);
    canCurate.mockReturnValue(false);

    expect(shell.vm.canConfigureSpace()).toBe(true);
    expect(shell.vm.canCurateSpace()).toBe(false);
  });

  it('opens space settings seeded from raw state and the viewer’s permissions', () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    railSpacesSignal.set([railSpace('!s:hs')]);
    currentIdentity.mockReturnValue({
      name: 'Design',
      topic: 'Where design happens',
      avatarMxc: 'mxc://a/b',
    });
    currentAccess.mockReturnValue({
      joinRule: 'public',
      historyVisibility: 'shared',
      allowedSpaceIds: [],
    });
    editableFields.mockReturnValue({
      name: true,
      topic: true,
      avatar: false,
      joinRule: true,
      history: false,
    });
    canManageBans.mockReturnValue(true);
    canManageAliases.mockReturnValue(false);

    shell.spaces.onOpenSpaceSettings();

    // Every read is against the SPACE id — a space is a room, so these services take it
    // unchanged, and passing the active ROOM id here would silently configure the wrong one.
    expect(currentIdentity).toHaveBeenCalledWith('!s:hs');
    expect(editableFields).toHaveBeenCalledWith('!s:hs');
    expect(currentAccess).toHaveBeenCalledWith('!s:hs');
    expect(TestBed.inject(TrnDialogService).openAndWait).toHaveBeenCalledWith(
      SpaceSettingsComponent,
      {
        ariaLabel: 'Space settings',
        inputs: expect.objectContaining({
          spaceId: '!s:hs',
          name: 'Design',
          topic: 'Where design happens',
          avatarMxc: 'mxc://a/b',
          joinRule: 'public',
          canEditName: true,
          canEditTopic: true,
          canEditAvatar: false,
          canEditJoinRule: true,
          canManageBans: true,
          canManageAliases: false,
        }),
      },
    );
  });

  it('offers no history visibility to the space dialog', () => {
    // A space has no timeline to hide, and the dialog has no control for it — passing one
    // would be a seed for a field that cannot be saved.
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    railSpacesSignal.set([railSpace('!s:hs')]);

    shell.spaces.onOpenSpaceSettings();

    const [, options] = (
      TestBed.inject(TrnDialogService).openAndWait as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(options.inputs).not.toHaveProperty('historyVisibility');
    expect(options.inputs).not.toHaveProperty('canEditHistory');
  });

  it('does not open space settings when no space is active', () => {
    const shell = build();
    shell.store.activeSpaceId.set(null);

    shell.spaces.onOpenSpaceSettings();

    expect(TestBed.inject(TrnDialogService).openAndWait).not.toHaveBeenCalled();
  });

  it('refuses to configure another account’s space', () => {
    // RoomSettingsService resolves the ACTIVE client, so this dialog would seed blank and
    // every write would land on the wrong account — or nowhere.
    const shell = build();
    shell.store.activeSpaceId.set('!theirs:hs');
    railSpacesSignal.set([railSpace('!theirs:hs', '@other:hs')]);

    expect(shell.vm.canConfigureSpace()).toBe(false);

    shell.spaces.onOpenSpaceSettings();

    expect(TestBed.inject(TrnDialogService).openAndWait).not.toHaveBeenCalled();
    expect(currentIdentity).not.toHaveBeenCalled();
  });

  it('allows configuring a space on the signed-in account', () => {
    const shell = build();
    shell.store.activeSpaceId.set('!mine:hs');
    railSpacesSignal.set([railSpace('!mine:hs', '@me:hs')]);

    expect(shell.vm.canConfigureSpace()).toBe(true);
  });

  it('reports no configurable space for Home or an unknown id', () => {
    const shell = build();
    railSpacesSignal.set([railSpace('!s:hs')]);

    shell.store.activeSpaceId.set(null);
    expect(shell.vm.canConfigureSpace()).toBe(false);

    shell.store.activeSpaceId.set('!gone:hs');
    expect(shell.vm.canConfigureSpace()).toBe(false);
  });

  it('seeds the restricted option from the spaces the room sits in', () => {
    const shell = build();
    roomsSignal.set([
      {
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
      },
    ]);
    shell.store.activeRoomId.set('!r:hs');
    railSpacesSignal.set([
      {
        id: '!s:hs',
        accountId: '@me:hs',
        name: 'Design',
        initial: 'D',
        avatarMxc: null,
        childRoomIds: ['!r:hs'],
      },
    ]);
    parentSpaceIds.mockReturnValue(['!s:hs']);
    supportsRestricted.mockReturnValue(true);
    currentAccess.mockReturnValue({
      joinRule: 'invite',
      historyVisibility: 'shared',
      allowedSpaceIds: ['!kept:hs'],
    });

    shell.rooms.onOpenRoomSettings();

    // The label names the space, so the id alone is not enough to pass through.
    expect(TestBed.inject(TrnDialogService).openAndWait).toHaveBeenCalledWith(
      RoomSettingsComponent,
      {
        ariaLabel: 'Room settings',
        inputs: expect.objectContaining({
          parentSpaces: [{ id: '!s:hs', name: 'Design' }],
          supportsRestricted: true,
          allowedSpaceIds: ['!kept:hs'],
        }),
      },
    );
  });

  it('opens room settings, mapping each edit permission to a dialog input', () => {
    const shell = build();
    roomsSignal.set([
      {
        id: '!r:hs',
        accountId: '@me:hs',
        accountIds: ['@me:hs'],
        name: 'General',
        initial: 'G',
        avatarMxc: null,
        topic: 'The topic',
        memberCount: 2,
        encrypted: false,
        unreadCount: 0,
        highlightCount: 0,
        hasUnread: false,
        markedUnread: false,
        lastMessage: '',
        activityTs: 0,
        favourite: false,
      },
    ]);
    shell.store.activeRoomId.set('!r:hs');
    editableFields.mockReturnValue({
      name: true,
      topic: false,
      avatar: false,
      joinRule: true,
      history: false,
    });
    currentAccess.mockReturnValue({
      joinRule: 'public',
      historyVisibility: 'world_readable',
      allowedSpaceIds: [],
    });
    canManageBans.mockReturnValue(true);
    canManageAliases.mockReturnValue(true);
    // Deliberately NOT the summary's 'General': that is `room.name || roomId`, which the
    // SDK fabricates from the member list for a nameless room. The dialog must seed from
    // raw m.room.name state, so the two are made to differ here.
    currentIdentity.mockReturnValue({
      name: 'Raw name',
      topic: 'Raw topic',
      avatarMxc: 'mxc://a/b',
    });

    shell.rooms.onOpenRoomSettings();

    expect(editableFields).toHaveBeenCalledWith('!r:hs');
    expect(currentAccess).toHaveBeenCalledWith('!r:hs');
    expect(canManageBans).toHaveBeenCalledWith('!r:hs');
    expect(canManageAliases).toHaveBeenCalledWith('!r:hs');
    expect(TestBed.inject(TrnDialogService).openAndWait).toHaveBeenCalledWith(
      RoomSettingsComponent,
      {
        ariaLabel: 'Room settings',
        inputs: expect.objectContaining({
          roomId: '!r:hs',
          name: 'Raw name',
          topic: 'Raw topic',
          avatarMxc: 'mxc://a/b',
          joinRule: 'public',
          historyVisibility: 'world_readable',
          canEditName: true,
          canEditTopic: false,
          canEditAvatar: false,
          canEditJoinRule: true,
          canEditHistory: false,
          canManageBans: true,
          canManageAliases: true,
        }),
      },
    );
  });

  it('opens the room directory and selects a room joined from it', async () => {
    const shell = build();
    const dialog = TestBed.inject(TrnDialogService);
    vi.mocked(dialog.openAndWait).mockResolvedValue({
      roomId: '!joined:hs',
      isSpace: false,
    });

    await shell.rooms.onExploreRooms();

    expect(dialog.openAndWait).toHaveBeenCalledWith(RoomDirectoryComponent);
    expect(shell.store.roomsView()).toBe(true); // listed in the Rooms view
    expect(shell.store.activeSpaceId()).toBeNull();
    expect(shell.store.activeRoomId()).toBe('!joined:hs'); // onSelectRoom ran
  });

  it('selects a space joined from the directory in the rail', async () => {
    const shell = build();
    const dialog = TestBed.inject(TrnDialogService);
    vi.mocked(dialog.openAndWait).mockResolvedValue({
      roomId: '!space:hs',
      isSpace: true,
    });

    await shell.rooms.onExploreRooms();

    expect(shell.store.activeSpaceId()).toBe('!space:hs'); // onSelectSpace ran
    expect(shell.store.activeRoomId()).toBeNull(); // no room opened
  });

  it('does not select a room when the directory is dismissed', async () => {
    const shell = build();
    const dialog = TestBed.inject(TrnDialogService);
    vi.mocked(dialog.openAndWait).mockResolvedValue(null);

    await shell.rooms.onExploreRooms();

    expect(shell.store.activeRoomId()).toBeNull();
  });

  it('joins and opens the successor room from the tombstone banner', () => {
    const shell = build();

    shell.rooms.onGoToUpgradedRoom('!old:hs');

    expect(joinPublicRoom).toHaveBeenCalledWith('!old:hs');
    expect(shell.store.roomsView()).toBe(true); // surfaced in the Rooms view, not opened invisibly
    expect(shell.store.activeRoomId()).toBe('!new:hs'); // onSelectRoom ran with the joined id
  });

  it('marks a room read via RoomsService', () => {
    const shell = build();
    shell.readState.onMarkRead({ roomId: '!r:hs' });
    expect(markReadFn).toHaveBeenCalledWith('!r:hs', undefined);
  });

  // A row merged from two accounts carries the loudest unread of the two, so acking only
  // one would leave a badge the user has no way to clear.
  it('acks every account joined to a merged row', () => {
    const shell = build();

    shell.readState.onMarkRead({
      roomId: '!r:hs',
      accountIds: ['@me:hs', '@alt:hs'],
    });

    expect(markReadFn).toHaveBeenCalledWith('!r:hs', '@me:hs');
    expect(markReadFn).toHaveBeenCalledWith('!r:hs', '@alt:hs');
  });

  it('tells the user when flagging a room fails', () => {
    // The service rolls its optimistic overlay back on failure, so without this the row
    // simply un-flags itself and the user is left thinking the click missed.
    const shell = build();
    setMarkedUnreadFn.mockReturnValue(throwError(() => new Error('nope')));

    shell.readState.onMarkUnread({ roomId: '!r:hs', accountIds: ['@me:hs'] });

    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('Could not mark the room unread.'),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('flags a room on every account joined to a merged row', () => {
    const shell = build();

    shell.readState.onMarkUnread({
      roomId: '!r:hs',
      accountIds: ['@me:hs', '@alt:hs'],
    });

    expect(setMarkedUnreadFn).toHaveBeenCalledWith('!r:hs', true, '@me:hs');
    expect(setMarkedUnreadFn).toHaveBeenCalledWith('!r:hs', true, '@alt:hs');
  });

  it('flags on the active account when the row names none', () => {
    // The fallback matters: `forkJoin([])` completes without emitting, so dropping it
    // would make the single-account ⋮ menu write nothing at all, silently.
    const shell = build();

    shell.readState.onMarkUnread({ roomId: '!r:hs' });

    expect(setMarkedUnreadFn).toHaveBeenCalledTimes(1);
    expect(setMarkedUnreadFn).toHaveBeenCalledWith('!r:hs', true, undefined);
  });

  it('clears the flag whenever a room is opened, however it was opened', () => {
    // The clear is wired to selection rather than to the focus-gated ack, so every
    // opener has to go through it — a permalink hop included.
    const shell = build();

    shell.nav.onSelectRoom('!r:hs');
    shell.nav.onSelectRoom('!h:hs', 'hop');

    expect(clearMarkedUnreadFn).toHaveBeenCalledWith('!r:hs');
    expect(clearMarkedUnreadFn).toHaveBeenCalledWith('!h:hs');
  });

  it('applies a notification level on every account joined to a merged row', () => {
    const shell = build();

    shell.readState.onSetNotifyMode({
      roomId: '!r:hs',
      mode: 'mute',
      accountIds: ['@me:hs', '@alt:hs'],
    });

    expect(setNotifyMode).toHaveBeenCalledWith('!r:hs', 'mute', '@me:hs');
    expect(setNotifyMode).toHaveBeenCalledWith('!r:hs', 'mute', '@alt:hs');
  });

  // Acked per owning account rather than through one bulk call: in the mixed view the
  // header button is offered for rooms belonging to accounts other than the active one,
  // and acking those through the active client would silently do nothing.
  it('marks every unread visible room read on its own account', () => {
    const shell = build();
    const unreadRoom = (
      id: string,
      accountId: string,
      hasUnread: boolean,
    ): RoomSummary => ({
      id,
      accountId,
      accountIds: [accountId],
      name: id,
      initial: 'X',
      avatarMxc: null,
      topic: '',
      memberCount: 2,
      encrypted: false,
      unreadCount: hasUnread ? 3 : 0,
      highlightCount: 0,
      hasUnread,
      markedUnread: false,
      lastMessage: '',
      activityTs: 0,
      favourite: false,
    });
    roomsSignal.set([
      unreadRoom('!a:hs', '@me:hs', true),
      unreadRoom('!b:hs', '@me:hs', false),
      unreadRoom('!c:hs', '@alt:hs', true),
    ]);

    shell.readState.onMarkAllRead();

    expect(markReadFn).toHaveBeenCalledWith('!a:hs', '@me:hs');
    expect(markReadFn).toHaveBeenCalledWith('!c:hs', '@alt:hs');
    expect(markReadFn).not.toHaveBeenCalledWith('!b:hs', expect.anything());
  });

  it('marks read a room that is flagged but has no unread count', () => {
    // The header button selects on hasUnread, which now includes the flag. Narrowing it
    // to a notification count would leave the button offering to clear a row it skips.
    const shell = build();
    const flagged = (id: string): RoomSummary => ({
      id,
      accountId: '@me:hs',
      accountIds: ['@me:hs'],
      name: id,
      initial: 'X',
      avatarMxc: null,
      topic: '',
      memberCount: 2,
      encrypted: false,
      unreadCount: 0,
      highlightCount: 0,
      hasUnread: true,
      markedUnread: true,
      lastMessage: '',
      activityTs: 0,
      favourite: false,
    });
    roomsSignal.set([flagged('!f:hs')]);

    shell.readState.onMarkAllRead();

    expect(markReadFn).toHaveBeenCalledWith('!f:hs', '@me:hs');
  });

  it('marks read on every account of a merged row', () => {
    // Mirrors the ⋮ path: acking only the winning account leaves a merged row unread
    // with the header button still offering to clear it, forever.
    const shell = build();
    const merged: RoomSummary = {
      id: '!m:hs',
      accountId: '@me:hs',
      accountIds: ['@me:hs', '@alt:hs'],
      name: 'merged',
      initial: 'M',
      avatarMxc: null,
      topic: '',
      memberCount: 2,
      encrypted: false,
      unreadCount: 0,
      highlightCount: 0,
      hasUnread: true,
      markedUnread: true,
      lastMessage: '',
      activityTs: 0,
      favourite: false,
    };
    roomsSignal.set([merged]);

    shell.readState.onMarkAllRead();

    expect(markReadFn).toHaveBeenCalledWith('!m:hs', '@me:hs');
    expect(markReadFn).toHaveBeenCalledWith('!m:hs', '@alt:hs');
  });

  it('opens the threads-list panel for the active room', () => {
    const shell = build();
    shell.store.activeRoomId.set('!r:hs');
    const panel = TestBed.inject(ThreadPanelService);

    shell.messages.openThreadsList();

    expect(panel.openList).toHaveBeenCalledWith('!r:hs');
  });

  it('does not open the threads-list panel without an active room', () => {
    const shell = build();
    shell.store.activeRoomId.set(null);
    const panel = TestBed.inject(ThreadPanelService);

    shell.messages.openThreadsList();

    expect(panel.openList).not.toHaveBeenCalled();
  });

  it('onTogglePin pins an unpinned message', () => {
    const shell = build();
    const pinned = TestBed.inject(PinnedMessagesService);
    vi.mocked(pinned.isPinned).mockReturnValue(false);
    vi.mocked(pinned.pin).mockReturnValue(of(undefined));

    shell.messages.onTogglePin('$1');

    expect(pinned.pin).toHaveBeenCalledWith('$1');
    expect(pinned.unpin).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(
      'Message pinned.',
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('onTogglePin unpins an already-pinned message', () => {
    const shell = build();
    const pinned = TestBed.inject(PinnedMessagesService);
    vi.mocked(pinned.isPinned).mockReturnValue(true);
    vi.mocked(pinned.unpin).mockReturnValue(of(undefined));

    shell.messages.onTogglePin('$1');

    expect(pinned.unpin).toHaveBeenCalledWith('$1');
    expect(pinned.pin).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(
      'Message unpinned.',
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('onTogglePin shows a destructive toast when the pin fails', () => {
    const shell = build();
    const pinned = TestBed.inject(PinnedMessagesService);
    vi.mocked(pinned.isPinned).mockReturnValue(false);
    vi.mocked(pinned.pin).mockReturnValue(throwError(() => new Error('nope')));

    shell.messages.onTogglePin('$1');

    expect(toastShow).toHaveBeenCalledWith(
      'Could not pin the message.',
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('openPinnedPanel jumps the timeline to the chosen pinned message', async () => {
    const shell = build();
    const panel = TestBed.inject(PinnedPanelService);
    vi.mocked(panel.openPanel).mockResolvedValue('$evt:hs');

    await shell.messages.openPinnedPanel();

    expect(panel.openPanel).toHaveBeenCalled();
    expect(shell.store.messageSearchTarget()).toBe('$evt:hs');
    expect(shell.store.jumpRequest()).toBe(1);
  });

  it('openPinnedPanel bumps jumpRequest again when the SAME message is re-picked', async () => {
    // The bug: re-selecting the same pinned row must still re-trigger a jump —
    // messageSearchTarget alone is a no-op signal write (Object.is), so the list
    // only re-fires because jumpRequest keeps incrementing.
    const shell = build();
    const panel = TestBed.inject(PinnedPanelService);
    vi.mocked(panel.openPanel).mockResolvedValue('$evt:hs');

    await shell.messages.openPinnedPanel();
    expect(shell.store.jumpRequest()).toBe(1);

    await shell.messages.openPinnedPanel();

    expect(shell.store.messageSearchTarget()).toBe('$evt:hs');
    expect(shell.store.jumpRequest()).toBe(2);
  });

  it('openPinnedPanel does not jump when the panel is cancelled', async () => {
    const shell = build();
    const panel = TestBed.inject(PinnedPanelService);
    vi.mocked(panel.openPanel).mockResolvedValue(null);

    await shell.messages.openPinnedPanel();

    expect(shell.store.messageSearchTarget()).toBeNull();
    expect(shell.store.jumpRequest()).toBe(0);
  });

  const pngFile = () =>
    new File([new Uint8Array([1])], 'pic.png', { type: 'image/png' });

  it('drives uploadProgress 0 → fraction → null over a successful media send', () => {
    const shell = build(); // build() (re)creates the sendMedia mock — set it after
    const stream = new Subject<void>();
    let progressCb: ((fraction: number) => void) | undefined;
    sendMedia.mockImplementation(
      (_file: File, _caption: string, cb?: (fraction: number) => void) => {
        progressCb = cb;
        return stream.asObservable();
      },
    );

    shell.messages.onSendMedia({ file: pngFile(), caption: '' });
    expect(shell.messages.uploadProgress()).toBe(0); // reset to 0 on start

    progressCb?.(0.5);
    expect(shell.messages.uploadProgress()).toBe(0.5); // tracks the upload fraction

    stream.complete();
    expect(shell.messages.uploadProgress()).toBeNull(); // cleared by finalize on success
    expect(toastShow).not.toHaveBeenCalled(); // no error toast
  });

  it('clears uploadProgress and toasts when a media send fails', () => {
    const shell = build();
    const stream = new Subject<void>();
    sendMedia.mockReturnValue(stream.asObservable());

    shell.messages.onSendMedia({ file: pngFile(), caption: '' });
    expect(shell.messages.uploadProgress()).toBe(0);

    stream.error(new Error('upload failed'));

    expect(shell.messages.uploadProgress()).toBeNull(); // finalize clears on error too
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });
});

// The channel sidebar is fed by `visibleRooms()`: Home shows only direct messages, the
// Rooms view shows non-DM rooms, a selected space shows only its joined children.
describe('RoomsPage space filtering', () => {
  function roomSummary(id: string, name: string, unread = 0): RoomSummary {
    return {
      id,
      accountId: '@me:hs',
      accountIds: ['@me:hs'],
      name,
      initial: name[0].toUpperCase(),
      avatarMxc: null,
      topic: '',
      memberCount: 0,
      encrypted: false,
      unreadCount: unread,
      highlightCount: 0,
      hasUnread: unread > 0,
      markedUnread: false,
      lastMessage: '',
      activityTs: 0,
      favourite: false,
    };
  }

  function spaceSummary(id: string, childRoomIds: string[]): SpaceSummary {
    return {
      id,
      accountId: '@me:hs',
      name: id,
      initial: 'S',
      avatarMxc: null,
      childRoomIds,
    };
  }

  function build() {
    // Home recency order is c, a, b. The space orders its children b, a — deliberately NOT
    // alphabetical, because every room here has activityTs 0: with a name tiebreak, a
    // curated order of a, b would be indistinguishable from the default recency ordering,
    // and the space-order assertion below would pass whether or not the mode was honoured.
    const rooms = [
      roomSummary('!c:hs', 'charlie', 2),
      roomSummary('!a:hs', 'alpha', 5),
      roomSummary('!b:hs', 'bravo', 3),
    ];
    const childRoomIds = vi.fn((id: string | null) =>
      id === '!s:hs' ? ['!b:hs', '!a:hs'] : [],
    );
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService, {
          rooms: signal(rooms),
          directRoomIds: signal<ReadonlySet<string>>(new Set(['!a:hs'])), // '!a:hs' is a DM
        }),
        MockProvider(SpacesService, {
          spaces: signal([spaceSummary('!s:hs', ['!b:hs', '!a:hs'])]),
          childRoomIds,
        }),
        MockProvider(SpaceRoomOrderService, {
          effectiveFor: () => 'space',
          overrideFor: () => null,
          defaultMode: signal<RoomSortMode>('recent').asReadonly(),
          modes: TRINITY_ROOM_SORTS,
        }),
        MockProvider(TimelineService),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>(['@me:hs']).asReadonly(),
          clientFor: () => ({ getUser: () => null }) as never,
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map(),
          ).asReadonly(),
        }),
        MockProvider(ThreadsService),
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(MessageSearchService),
        MockProvider(AuthService),
        MockProvider(TrnDialogService),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  it('Recent activity (the default) shows every joined room, mixed', () => {
    const shell = build();

    // Nothing selected → Recent is active from the start, listing all rooms in the
    // service's favourite-then-recency order (c, a, b as seeded), DM and non-DM alike.
    expect(shell.store.recentView()).toBe(true);
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual([
      '!c:hs',
      '!a:hs',
      '!b:hs',
    ]);
    expect(shell.vm.sidebarTitle()).toBe('Recent activity');
  });

  it('Home (no space) shows only direct messages', () => {
    const shell = build();
    shell.nav.onSelectSpace(null); // click Home — leaves the default Recent view

    // Only '!a:hs' is a DM (see directRoomIds in build()).
    expect(shell.store.recentView()).toBe(false);
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual(['!a:hs']);
    expect(shell.vm.sidebarTitle()).toBe('Direct Messages');
  });

  it('a selected space shows only its joined children, in space order', () => {
    const shell = build();
    shell.nav.onSelectSpace('!s:hs');

    // '!c:hs' is excluded (not a child); b/a appear in the space's curated order, which is
    // neither alphabetical nor the recency order the other views use.
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual([
      '!b:hs',
      '!a:hs',
    ]);
    expect(shell.vm.activeSpaceName()).toBe('!s:hs');
  });

  it('the Rooms view shows non-DM rooms that do not belong to a space', () => {
    const shell = build();
    shell.nav.onShowRooms();

    expect(shell.store.roomsView()).toBe(true);
    expect(shell.store.recentView()).toBe(false); // Rooms clears the default Recent view
    // Only the spaceless non-DM room '!c:hs': the DM '!a:hs' and the space child
    // '!b:hs' (owned by '!s:hs') are both excluded.
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual(['!c:hs']);
    expect(shell.vm.sidebarTitle()).toBe('Rooms');
  });

  it('showing Rooms clears the active space', () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs'); // a space is selected…
    shell.nav.onShowRooms(); // …switching to Rooms leaves it

    expect(shell.store.activeSpaceId()).toBeNull();
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual(['!c:hs']);
  });

  it('selecting a space leaves the Rooms view', () => {
    const shell = build();
    shell.nav.onShowRooms();
    expect(shell.store.roomsView()).toBe(true);

    shell.nav.onSelectSpace('!s:hs');
    expect(shell.store.roomsView()).toBe(false);
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual([
      '!b:hs',
      '!a:hs',
    ]);
    expect(shell.vm.sidebarTitle()).toBe('!s:hs');
  });

  it('Home returns to direct messages from the Rooms view', () => {
    const shell = build();
    shell.nav.onShowRooms();
    expect(shell.store.roomsView()).toBe(true);

    shell.nav.onSelectSpace(null); // clicking Home
    expect(shell.store.roomsView()).toBe(false);
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual(['!a:hs']); // DMs
    expect(shell.vm.sidebarTitle()).toBe('Direct Messages');
  });

  it('returns to Recent activity from another view', () => {
    const shell = build();
    shell.nav.onShowRooms();
    expect(shell.store.recentView()).toBe(false);

    shell.nav.onShowRecent();
    expect(shell.store.recentView()).toBe(true);
    expect(shell.store.roomsView()).toBe(false);
    expect(shell.store.activeSpaceId()).toBeNull();
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual([
      '!c:hs',
      '!a:hs',
      '!b:hs',
    ]);
  });

  it('sums unread notifications for the Recent, Home (DMs) and Rooms rail badges', () => {
    const shell = build();
    // directRoomIds = {!a:hs}; DMs: a(5). Rooms view (non-DM, spaceless): c(2).
    // b(3) is a child of '!s:hs' → counted on the space pill, not the Rooms badge.
    // Recent lists everything, so its badge is the sum across all rooms: 2 + 5 + 3.
    expect(shell.vm.recentUnread()).toBe(10);
    expect(shell.vm.homeUnread()).toBe(5);
    expect(shell.vm.roomsUnread()).toBe(2);
  });

  it('sums unread notifications per space for the space-pill badges', () => {
    const shell = build();
    // space !s:hs children [a, b] → a(5) + b(3) = 8.
    expect(shell.vm.spaceUnread()['!s:hs']).toBe(8);
  });

  it('re-derives homeUnread/roomsUnread when a room unreadCount changes underneath', () => {
    const shell = build();
    expect(shell.vm.homeUnread()).toBe(5); // a(5)
    expect(shell.vm.roomsUnread()).toBe(2); // c(2); b is a space child → excluded

    const rooms = TestBed.inject(RoomsService)
      .rooms as unknown as WritableSignal<RoomSummary[]>;
    rooms.update((list) =>
      list.map((r) => (r.id === '!c:hs' ? { ...r, unreadCount: 20 } : r)),
    );

    expect(shell.vm.roomsUnread()).toBe(20); // c(20); b still excluded
    expect(shell.vm.homeUnread()).toBe(5); // DM total untouched
  });

  it('re-derives spaceUnread when a room is added to the tracked room list', () => {
    const shell = build();
    expect(shell.vm.spaceUnread()['!s:hs']).toBe(8); // a(5) + b(3)

    const rooms = TestBed.inject(RoomsService)
      .rooms as unknown as WritableSignal<RoomSummary[]>;
    // A new message pushes bravo's unread up, as would a real sync refresh.
    rooms.update((list) =>
      list.map((r) => (r.id === '!b:hs' ? { ...r, unreadCount: 30 } : r)),
    );

    expect(shell.vm.spaceUnread()['!s:hs']).toBe(35); // a(5) + b(30)
  });

  it('re-derives the aggregates when a room is removed from the list', () => {
    const shell = build();
    expect(shell.vm.spaceUnread()['!s:hs']).toBe(8);
    expect(shell.vm.roomsUnread()).toBe(2); // c(2); b is a space child → excluded

    const rooms = TestBed.inject(RoomsService)
      .rooms as unknown as WritableSignal<RoomSummary[]>;
    rooms.update((list) => list.filter((r) => r.id !== '!b:hs'));

    expect(shell.vm.spaceUnread()['!s:hs']).toBe(5); // only a(5) remains
    expect(shell.vm.roomsUnread()).toBe(2); // still just c(2) — b was already excluded
  });

  it('a spaceless room disappears from the Rooms view once a space claims it', () => {
    const shell = build();
    shell.nav.onShowRooms();
    // Before: only '!c:hs' is spaceless non-DM.
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual(['!c:hs']);
    expect(shell.vm.roomsUnread()).toBe(2);

    const spaces = TestBed.inject(SpacesService)
      .spaces as unknown as WritableSignal<SpaceSummary[]>;
    // '!s:hs' now also claims '!c:hs' (e.g. it was just added as a child).
    spaces.update((list) =>
      list.map((s) =>
        s.id === '!s:hs'
          ? { ...s, childRoomIds: [...s.childRoomIds, '!c:hs'] }
          : s,
      ),
    );

    expect(shell.vm.visibleRooms()).toEqual([]); // '!c:hs' is now space-owned
    expect(shell.vm.roomsUnread()).toBe(0); // its unread leaves the Rooms badge too
  });

  it('a space child reappears in the Rooms view once its space no longer lists it', () => {
    const shell = build();
    shell.nav.onShowRooms();
    // '!b:hs' is owned by '!s:hs' — hidden from the Rooms view.
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual(['!c:hs']);
    expect(shell.vm.roomsUnread()).toBe(2);

    const spaces = TestBed.inject(SpacesService)
      .spaces as unknown as WritableSignal<SpaceSummary[]>;
    // The space is removed entirely (as leaving it would surface via sync).
    spaces.set([]);

    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual([
      '!c:hs',
      '!b:hs',
    ]);
    expect(shell.vm.roomsUnread()).toBe(5); // c(2) + b(3), now both spaceless
  });

  it('a room owned by two spaces is still excluded once it is dropped from only one', () => {
    const shell = build();
    const spaces = TestBed.inject(SpacesService)
      .spaces as unknown as WritableSignal<SpaceSummary[]>;
    // '!b:hs' is now a child of both '!s:hs' and a second space '!t:hs'.
    spaces.update((list) => [...list, spaceSummary('!t:hs', ['!b:hs'])]);
    shell.nav.onShowRooms();
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual(['!c:hs']); // b still hidden

    // Dropping '!b:hs' from '!s:hs' alone must not surface it — '!t:hs' still owns it.
    spaces.update((list) =>
      list.map((s) =>
        s.id === '!s:hs'
          ? {
              ...s,
              childRoomIds: s.childRoomIds.filter((id) => id !== '!b:hs'),
            }
          : s,
      ),
    );

    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual(['!c:hs']); // still hidden
    expect(shell.vm.roomsUnread()).toBe(2); // b's unread stays off the Rooms badge
  });
});

// Inside a space the list is ordered by the mode that space resolves to. The fixture below
// makes the three orderings disagree pairwise, so no assertion can pass under the wrong one.
describe('RoomsPage space ordering', () => {
  /** Curated order z, a, m; alphabetical a, m, z; recency m, z, a. */
  const CHILD_IDS = ['!z:hs', '!a:hs', '!m:hs'];

  function orderedRoom(
    id: string,
    name: string,
    activityTs: number,
    favourite = false,
  ): RoomSummary {
    return {
      id,
      accountId: '@me:hs',
      accountIds: ['@me:hs'],
      name,
      initial: name[0].toUpperCase(),
      avatarMxc: null,
      topic: '',
      memberCount: 0,
      encrypted: false,
      unreadCount: 0,
      highlightCount: 0,
      hasUnread: false,
      markedUnread: false,
      lastMessage: '',
      activityTs,
      favourite,
    };
  }

  function orderedSpace(id: string, childRoomIds: string[]): SpaceSummary {
    return {
      id,
      accountId: '@me:hs',
      name: id,
      initial: 'S',
      avatarMxc: null,
      childRoomIds,
    };
  }

  function build(order: Partial<SpaceRoomOrderService> = {}) {
    const rooms = signal([
      orderedRoom('!z:hs', 'zulu', 200),
      orderedRoom('!a:hs', 'alpha', 100),
      orderedRoom('!m:hs', 'mike', 300),
    ]);
    const setForSpace = vi.fn();
    const clearForSpace = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService, {
          rooms,
          directRoomIds: signal<ReadonlySet<string>>(new Set()),
        }),
        MockProvider(SpacesService, {
          spaces: signal([orderedSpace('!s:hs', CHILD_IDS)]),
          childRoomIds: (id: string | null) =>
            id === '!s:hs' ? CHILD_IDS : [],
        }),
        MockProvider(SpaceRoomOrderService, {
          effectiveFor: () => 'recent',
          overrideFor: () => null,
          defaultMode: signal<RoomSortMode>('recent').asReadonly(),
          modes: TRINITY_ROOM_SORTS,
          setForSpace,
          clearForSpace,
          ...order,
        }),
        MockProvider(TimelineService),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>(['@me:hs']).asReadonly(),
          clientFor: () => ({ getUser: () => null }) as never,
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map(),
          ).asReadonly(),
        }),
        MockProvider(ThreadsService),
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(MessageSearchService),
        MockProvider(AuthService),
        MockProvider(TrnDialogService),
        MockProvider(TrnToastService),
      ],
    });
    const shell = shellFrom();
    shell.nav.onSelectSpace('!s:hs');
    return { shell, rooms, setForSpace, clearForSpace };
  }

  const names = (shell: ReturnType<typeof shellFrom>) =>
    shell.vm.visibleRooms().map((r) => r.name);

  it('orders by recent activity, ignoring the curated child order', () => {
    const { shell } = build({ effectiveFor: () => 'recent' });

    expect(names(shell)).toEqual(['mike', 'zulu', 'alpha']);
  });

  it('orders alphabetically, ignoring both activity and the curated order', () => {
    const { shell } = build({ effectiveFor: () => 'alphabetical' });

    expect(names(shell)).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('preserves the curated order under space mode', () => {
    const { shell } = build({ effectiveFor: () => 'space' });

    expect(names(shell)).toEqual(['zulu', 'alpha', 'mike']);
  });

  it("uses a space's own override rather than the account default", () => {
    const { shell } = build({
      effectiveFor: (spaceId: string | null) =>
        spaceId === '!s:hs' ? 'alphabetical' : 'recent',
    });

    expect(names(shell)).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('re-sorts when a room becomes active, with nothing else called', () => {
    // The acceptance criterion: a new message reorders the space without reopening it.
    // No new listener is involved — `visibleRooms` already reads `rooms()`, which the
    // service re-snapshots on every sync.
    const { shell, rooms } = build({ effectiveFor: () => 'recent' });
    expect(names(shell)).toEqual(['mike', 'zulu', 'alpha']);

    rooms.update((list) =>
      list.map((room) =>
        room.id === '!a:hs' ? { ...room, activityTs: 999 } : room,
      ),
    );

    expect(names(shell)).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('keeps favourites first in every mode', () => {
    const { shell, rooms } = build({ effectiveFor: () => 'space' });
    rooms.update((list) =>
      list.map((room) =>
        room.id === '!a:hs' ? { ...room, favourite: true } : room,
      ),
    );

    // 'alpha' is second in the curated order, but the array the keyboard walk and
    // "mark all read" iterate must match what the sidebar renders — favourites first.
    expect(names(shell)).toEqual(['alpha', 'zulu', 'mike']);
  });

  it('sorts a copy, never the array the rooms service handed out', () => {
    const { shell, rooms } = build({ effectiveFor: () => 'alphabetical' });
    const seeded = rooms();

    expect(names(shell)).toEqual(['alpha', 'mike', 'zulu']);

    // `sort` mutates; reordering this array would corrupt every other consumer of the
    // service's signal (unread totals, the rail badges, the quick switcher).
    expect(rooms()).toBe(seeded);
    expect(seeded.map((r) => r.name)).toEqual(['zulu', 'alpha', 'mike']);
    expect(shell.vm.visibleRooms()).not.toBe(seeded);
  });

  it('leaves the Recent view returning the service array by identity', () => {
    const { shell, rooms } = build();
    shell.nav.onShowRecent();

    expect(shell.vm.visibleRooms()).toBe(rooms());
  });

  describe('changing the order from the sidebar', () => {
    it('pins the open space to a mode', () => {
      const { shell, setForSpace } = build();

      shell.spaces.onSetSpaceSort('alphabetical');

      expect(setForSpace).toHaveBeenCalledWith('!s:hs', 'alphabetical');
    });

    it('clears the override when asked to follow the default', () => {
      const { shell, clearForSpace, setForSpace } = build();

      shell.spaces.onSetSpaceSort(null);

      expect(clearForSpace).toHaveBeenCalledWith('!s:hs');
      expect(setForSpace).not.toHaveBeenCalled();
    });

    it('does nothing when no space is open', () => {
      const { shell, setForSpace, clearForSpace } = build();
      shell.nav.onSelectSpace(null);

      shell.spaces.onSetSpaceSort('space');
      shell.spaces.onSetSpaceSort(null);

      expect(setForSpace).not.toHaveBeenCalled();
      expect(clearForSpace).not.toHaveBeenCalled();
    });
  });
});

// A mixed scenario exercising several distinct spaces (each with its own unread
// total) alongside a DM/non-DM split in the same room set, all in one pass.
describe('RoomsPage unread aggregation: multiple spaces + DM split', () => {
  function roomSummary(
    id: string,
    name: string,
    unread = 0,
    markedUnread = false,
  ): RoomSummary {
    return {
      id,
      accountId: '@me:hs',
      accountIds: ['@me:hs'],
      name,
      initial: name[0].toUpperCase(),
      avatarMxc: null,
      topic: '',
      memberCount: 0,
      encrypted: false,
      unreadCount: unread,
      highlightCount: 0,
      hasUnread: unread > 0 || markedUnread,
      markedUnread,
      lastMessage: '',
      activityTs: 0,
      favourite: false,
    };
  }

  function spaceSummary(id: string, childRoomIds: string[]): SpaceSummary {
    return {
      id,
      accountId: '@me:hs',
      name: id,
      initial: 'S',
      avatarMxc: null,
      childRoomIds,
    };
  }

  /** `extra` adds a third space and its rooms, so the default fixture is unchanged. */
  function build(extra: { rooms?: RoomSummary[]; children?: string[] } = {}) {
    const rooms = [
      roomSummary('!dm:hs', 'dm-with-bob', 4), // a direct message
      roomSummary('!a:hs', 'alpha', 5), // space 1's only child
      roomSummary('!b:hs', 'bravo', 3), // space 2's child
      roomSummary('!c:hs', 'charlie', 7), // space 2's other child
      roomSummary('!free:hs', 'freestanding', 6), // non-DM, in no space
      ...(extra.rooms ?? []),
    ];
    const childRoomIds = vi.fn((id: string | null) => {
      if (id === '!s1:hs') return ['!a:hs'];
      if (id === '!s2:hs') return ['!b:hs', '!c:hs'];
      if (id === '!s3:hs') return extra.children ?? [];
      return [];
    });
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService, {
          rooms: signal(rooms),
          directRoomIds: signal<ReadonlySet<string>>(new Set(['!dm:hs'])),
        }),
        MockProvider(SpacesService, {
          spaces: signal([
            spaceSummary('!s1:hs', ['!a:hs']),
            spaceSummary('!s2:hs', ['!b:hs', '!c:hs']),
            ...(extra.children ? [spaceSummary('!s3:hs', extra.children)] : []),
          ]),
          childRoomIds,
        }),
        MockProvider(TimelineService),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>(['@me:hs']).asReadonly(),
          clientFor: () => ({ getUser: () => null }) as never,
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map(),
          ).asReadonly(),
        }),
        MockProvider(ThreadsService),
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(MessageSearchService),
        MockProvider(AuthService),
        MockProvider(TrnDialogService),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  it('keeps each space total independent and splits DM vs non-DM totals', () => {
    const shell = build();

    expect(shell.vm.spaceUnread()).toEqual({
      '!s1:hs': 5, // alpha only
      '!s2:hs': 10, // bravo(3) + charlie(7)
    });
    expect(shell.vm.homeUnread()).toBe(4); // the DM only
    // The Rooms view is spaceless non-DM rooms only: just freestanding(6).
    // a/b/c belong to spaces (counted on their pills) and the DM is excluded.
    expect(shell.vm.roomsUnread()).toBe(6);
  });

  it('counts a flagged child as one, without adding to a real count', () => {
    // A flagged room has no notification count behind it, so without this the pill for
    // the space holding it stays blank and the flag is invisible from everywhere but
    // that space's own list — which is most of the point of the feature.
    const shell = build({
      rooms: [
        roomSummary('!flagged:hs', 'flagged', 0, true),
        roomSummary('!loud:hs', 'loud', 4, true),
      ],
      children: ['!flagged:hs', '!loud:hs'],
    });

    expect(shell.vm.spaceUnread()['!s3:hs']).toBe(5); // 1 for the flag + 4 real, not 6
  });
});

// Create-space / create-channel / leave-space: the page prompts via TrnAlertService
// and delegates to SpacesService, handling the success navigation + error state.
describe('RoomsPage space actions', () => {
  let alertPrompt: ReturnType<typeof vi.fn>;
  let alertConfirm: ReturnType<typeof vi.fn>;
  let createSpace: ReturnType<typeof vi.fn>;
  let createRoomInSpace: ReturnType<typeof vi.fn>;
  let leaveSpace: ReturnType<typeof vi.fn>;

  function build(
    activeUserId: string | null = '@me:hs',
    accountIds: readonly string[] = ['@me:hs'],
  ) {
    alertPrompt = vi.fn().mockResolvedValue(null);
    alertConfirm = vi.fn().mockResolvedValue(false);
    createSpace = vi.fn(() => of('!new:hs'));
    createRoomInSpace = vi.fn(() => of('!room:hs'));
    leaveSpace = vi.fn(() => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService),
        MockProvider(SpacesService, {
          spaces: signal<SpaceSummary[]>([]),
          createSpace,
          createRoomInSpace,
          leaveSpace,
        }),
        MockProvider(TimelineService),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>(activeUserId).asReadonly(),
          accountIds: signal<readonly string[]>(accountIds).asReadonly(),
          clientFor: () => ({ getUser: () => null }) as never,
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map(),
          ).asReadonly(),
        }),
        MockProvider(ThreadsService),
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(MessageSearchService),
        MockProvider(AuthService, {
          logout: vi.fn(() => of(undefined)),
          switchAccount: vi.fn(() => of(undefined)),
        }),
        MockProvider(TrnDialogService),
        MockProvider(TrnAlertService, {
          confirm: alertConfirm,
          prompt: alertPrompt,
        }),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  it('creates a space and selects it on success', async () => {
    const shell = build();
    alertPrompt.mockResolvedValue('My Space');

    await shell.spaces.onCreateSpace();

    expect(createSpace).toHaveBeenCalledWith({ name: 'My Space' });
    expect(shell.store.activeSpaceId()).toBe('!new:hs');
  });

  it('does not create a space for an empty name', async () => {
    const shell = build();
    alertPrompt.mockResolvedValue('   ');

    await shell.spaces.onCreateSpace();

    expect(createSpace).not.toHaveBeenCalled();
  });

  it('does not create a space when the prompt is cancelled', async () => {
    const shell = build();
    alertPrompt.mockResolvedValue(null);

    await shell.spaces.onCreateSpace();

    expect(createSpace).not.toHaveBeenCalled();
  });

  it('surfaces a create-space failure in spaceError', async () => {
    const shell = build();
    alertPrompt.mockResolvedValue('My Space');
    createSpace.mockReturnValue(throwError(() => new Error('boom')));

    await shell.spaces.onCreateSpace();

    expect(shell.status.error()).toBe('boom');
    expect(shell.store.activeSpaceId()).toBeNull(); // not selected on failure
  });

  it('creates a channel in the active space', async () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    alertPrompt.mockResolvedValue('general');

    await shell.spaces.onCreateChannel();

    expect(createRoomInSpace).toHaveBeenCalledWith('!s:hs', {
      name: 'general',
    });
  });

  it('does not prompt to create a channel on Home (no active space)', async () => {
    const shell = build();
    shell.store.activeSpaceId.set(null);

    await shell.spaces.onCreateChannel();

    expect(alertPrompt).not.toHaveBeenCalled();
    expect(createRoomInSpace).not.toHaveBeenCalled();
  });

  it('leaves the active space and returns to Home on success', async () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    alertConfirm.mockResolvedValue(true);

    await shell.spaces.onLeaveSpace();

    expect(leaveSpace).toHaveBeenCalledWith('!s:hs');
    expect(shell.store.activeSpaceId()).toBeNull();
  });

  it('does not leave when the confirm is cancelled', async () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    alertConfirm.mockResolvedValue(false);

    await shell.spaces.onLeaveSpace();

    expect(leaveSpace).not.toHaveBeenCalled();
  });

  it('does not prompt to leave on Home (no active space)', async () => {
    const shell = build();
    shell.store.activeSpaceId.set(null);

    await shell.spaces.onLeaveSpace();

    expect(alertConfirm).not.toHaveBeenCalled();
    expect(leaveSpace).not.toHaveBeenCalled();
  });

  it('signs out the last account and navigates to /login after confirming', async () => {
    const shell = build();
    alertConfirm.mockResolvedValue(true);
    const auth = TestBed.inject(AuthService);
    const router = TestBed.inject(Router);

    await shell.session.logout('@me:hs');

    expect(alertConfirm).toHaveBeenCalled();
    expect(auth.logout).toHaveBeenCalledWith('@me:hs');
    // The harness has a single account, so signing it out returns to /login.
    expect(router.navigateByUrl).toHaveBeenCalledWith('/login', {
      replaceUrl: true,
    });
  });

  it('signs out one of several accounts without leaving the shell', async () => {
    const shell = build('@me:hs', ['@me:hs', '@alt:hs']);
    alertConfirm.mockResolvedValue(true);
    const auth = TestBed.inject(AuthService);
    const router = TestBed.inject(Router);

    await shell.session.logout('@me:hs');

    expect(auth.logout).toHaveBeenCalledWith('@me:hs');
    // A second account is still signed in (activeUserId stays non-null), so the
    // wasLastAccount=false branch skips the /login redirect and the shell stays.
    expect(router.navigateByUrl).not.toHaveBeenCalledWith('/login', {
      replaceUrl: true,
    });
  });

  it('does not sign out when the confirm is cancelled', async () => {
    const shell = build();
    alertConfirm.mockResolvedValue(false);
    const auth = TestBed.inject(AuthService);

    await shell.session.logout('@me:hs');

    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('switches to another account (and no-ops on the active one)', () => {
    const shell = build();
    const auth = TestBed.inject(AuthService);

    shell.session.switchAccount('@me:hs'); // already active → ignored
    expect(auth.switchAccount).not.toHaveBeenCalled();

    shell.session.switchAccount('@other:hs');
    expect(auth.switchAccount).toHaveBeenCalledWith('@other:hs');
  });

  it('tears the open room down when switching accounts', () => {
    // The room panes are bound to the PREVIOUS account's client and Room objects, and
    // timeline/threads/pinned each early-return on open(sameRoomId) — so leaving the
    // room open across a switch would keep projecting the old account's data (including
    // its decryption) with no way to re-bind short of a reload.
    const shell = build();
    const timeline = TestBed.inject(TimelineService);
    const threads = TestBed.inject(ThreadsService);
    const pinned = TestBed.inject(PinnedMessagesService);
    shell.nav.onSelectRoom('!r:hs');
    expect(shell.store.activeRoomId()).toBe('!r:hs');

    shell.session.switchAccount('@other:hs');

    expect(shell.store.activeRoomId()).toBeNull();
    expect(timeline.close).toHaveBeenCalled();
    expect(threads.close).toHaveBeenCalled();
    expect(threads.closeThread).toHaveBeenCalled();
    expect(pinned.close).toHaveBeenCalled();
  });

  it('routes to /login in add mode from "Add account"', () => {
    const shell = build();
    const router = TestBed.inject(Router);

    shell.session.addAccount();

    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { add: 1 },
    });
  });

  it('routes to /login in re-auth mode for a soft-logged-out account', () => {
    const shell = build();
    const router = TestBed.inject(Router);

    shell.session.reauthAccount('@bob:hs');

    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { reauth: '@bob:hs' },
    });
  });

  it('returns to /login when the last account is lost (active becomes null)', () => {
    build(null); // no active account — e.g. a soft-logout of the last one
    const router = TestBed.inject(Router);

    TestBed.inject(ApplicationRef).tick(); // run the redirect effect

    expect(router.navigateByUrl).toHaveBeenCalledWith('/login', {
      replaceUrl: true,
    });
  });
});

// Room / DM creation, invites, and accept/decline. The page picks a user (modal),
// prompts for a name (alert), or reads a pending invite, then delegates to the
// services and handles selection + success/error toasts.
describe('RoomsPage room / DM / invite actions', () => {
  let alertPrompt: ReturnType<typeof vi.fn>;
  let toastShow: ReturnType<typeof vi.fn>;
  let pick: ReturnType<typeof vi.fn>;
  let createRoom: ReturnType<typeof vi.fn>;
  let directIds: ReturnType<typeof signal<ReadonlySet<string>>>;
  let createDirectMessage: ReturnType<typeof vi.fn>;
  let inviteUser: ReturnType<typeof vi.fn>;
  let acceptInvite: ReturnType<typeof vi.fn>;
  let declineInvite: ReturnType<typeof vi.fn>;
  let userCardOpen: ReturnType<typeof vi.fn>;
  let memberInfoOpen: ReturnType<typeof vi.fn>;
  let canModerate: ReturnType<typeof vi.fn>;
  let pending: WritableSignal<PendingInvite[]>;

  function pendingInvite(over: Partial<PendingInvite> = {}): PendingInvite {
    return {
      roomId: '!i:hs',
      name: 'Invited',
      initial: 'I',
      avatarMxc: null,
      inviterName: 'Alice',
      isSpace: false,
      isDirect: false,
      ...over,
    };
  }

  function build() {
    alertPrompt = vi.fn().mockResolvedValue(null);
    toastShow = vi.fn();
    pick = vi.fn();
    createRoom = vi.fn(() => of('!room:hs'));
    directIds = signal<ReadonlySet<string>>(new Set());
    createDirectMessage = vi.fn(() => of('!dm:hs'));
    inviteUser = vi.fn(() => of(undefined));
    acceptInvite = vi.fn(() => of(undefined));
    declineInvite = vi.fn(() => of(undefined));
    userCardOpen = vi.fn().mockResolvedValue(null);
    memberInfoOpen = vi.fn().mockResolvedValue(null);
    canModerate = vi.fn(() => ({
      kick: false,
      ban: false,
      setPower: false,
      myPower: 0,
    }));
    pending = signal<PendingInvite[]>([]);
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService, {
          rooms: signal<RoomSummary[]>([]),
          createRoom,
          createDirectMessage,
          inviteUser,
          directRoomIds: directIds,
        }),
        MockProvider(SpacesService, { spaces: signal<SpaceSummary[]>([]) }),
        invitesProvider({
          pendingInvites: pending,
          acceptInvite,
          declineInvite,
        }),
        MockProvider(UserPickerService, { pick }),
        MockProvider(UserCardService, { open: userCardOpen }),
        MockProvider(MemberInfoService, { open: memberInfoOpen }),
        MockProvider(RoomModerationService, { canModerate }),
        MockProvider(QuickSwitcherService),
        MockProvider(MessageSearchService),
        MockProvider(TimelineService),
        MockProvider(MediaService),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>(['@me:hs']).asReadonly(),
          clientFor: () => ({ getUser: () => null }) as never,
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map(),
          ).asReadonly(),
        }),
        MockProvider(ThreadsService),
        MockProvider(AuthService),
        MockProvider(TrnDialogService),
        MockProvider(TrnAlertService, { prompt: alertPrompt }),
        MockProvider(TrnToastService, { show: toastShow }),
      ],
    });
    return shellFrom();
  }

  it('creates an encrypted room from the name prompt and selects it', async () => {
    const shell = build();
    alertPrompt.mockResolvedValue('general');

    await shell.rooms.onCreateRoom();

    expect(createRoom).toHaveBeenCalledWith({ name: 'general' });
    expect(shell.store.activeRoomId()).toBe('!room:hs');
  });

  it('does not create a room for an empty name', async () => {
    const shell = build();
    alertPrompt.mockResolvedValue('   ');

    await shell.rooms.onCreateRoom();

    expect(createRoom).not.toHaveBeenCalled();
  });

  it('starts a DM with the picked user and selects the DM room', async () => {
    const shell = build();
    pick.mockResolvedValue('@bob:hs');

    await shell.rooms.onStartDm();

    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(shell.store.activeRoomId()).toBe('!dm:hs');
  });

  it('does not start a DM when the picker is cancelled', async () => {
    const shell = build();
    pick.mockResolvedValue(null);

    await shell.rooms.onStartDm();

    expect(createDirectMessage).not.toHaveBeenCalled();
  });

  it('shows a user card for a mention link, starting a DM only if messaged', async () => {
    const shell = build();
    userCardOpen.mockResolvedValue('@bob:hs'); // the viewer chose "Message"

    shell.messages.onMatrixLink({ kind: 'user', userId: '@bob:hs' });
    await Promise.resolve();
    await Promise.resolve();

    expect(userCardOpen).toHaveBeenCalledWith('@bob:hs');
    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(shell.store.activeRoomId()).toBe('!dm:hs');
  });

  it('opens no conversation when the user card is dismissed', async () => {
    const shell = build();
    userCardOpen.mockResolvedValue(null); // dismissed

    shell.messages.onMatrixLink({ kind: 'user', userId: '@bob:hs' });
    await Promise.resolve();
    await Promise.resolve();

    expect(userCardOpen).toHaveBeenCalledWith('@bob:hs');
    expect(createDirectMessage).not.toHaveBeenCalled();
  });

  it('opens a member info panel and starts a DM only if messaged', async () => {
    const shell = build();
    shell.store.activeRoomId.set('!r:hs');
    const bob = {
      userId: '@bob:hs',
      name: 'Bob',
      initial: 'B',
      avatarMxc: null,
      powerLevel: 0,
      isCreator: false,
    };
    memberInfoOpen.mockResolvedValue('@bob:hs'); // the viewer chose "Message"

    shell.members.onSelectMember(bob);
    await Promise.resolve();
    await Promise.resolve();

    expect(canModerate).toHaveBeenCalledWith('!r:hs', '@bob:hs');
    // The trailing flag says whether this room is a DM — the panel must not name an
    // owner in a 1:1 chat, where both people sit at power level 100.
    expect(memberInfoOpen).toHaveBeenCalledWith(
      bob,
      '!r:hs',
      { kick: false, ban: false, setPower: false, myPower: 0 },
      false,
    );
    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(shell.store.activeRoomId()).toBe('!dm:hs');
  });

  it('tells the member panel when the room is a direct message', async () => {
    // Both participants of a DM sit at 100 (trusted_private_chat), so without this the
    // person who started the chat is labelled Owner and their friend Admin.
    const bob = {
      userId: '@bob:hs',
      name: 'Bob',
      initial: 'B',
      avatarMxc: null,
      powerLevel: 0,
      isCreator: false,
    };
    const shell = build();
    shell.store.activeRoomId.set('!dm:hs');
    directIds.set(new Set(['!dm:hs']));

    shell.members.onSelectMember(bob);
    await Promise.resolve();

    expect(memberInfoOpen).toHaveBeenCalledWith(
      bob,
      '!dm:hs',
      expect.anything(),
      true,
    );
  });

  it('opens no member info panel without an active room', () => {
    const shell = build();
    shell.store.activeRoomId.set(null);

    shell.members.onSelectMember({
      userId: '@bob:hs',
      name: 'Bob',
      initial: 'B',
      avatarMxc: null,
      powerLevel: 0,
      isCreator: false,
    });

    expect(memberInfoOpen).not.toHaveBeenCalled();
  });

  it('closes the members drawer when a member is selected on the narrow layout', () => {
    // On the narrow (drawer) layout the list seeds closed, so open it first; selecting a
    // member must then slide it shut.
    const restore = stubNarrowLayout();
    try {
      const shell = build();
      shell.store.activeRoomId.set('!r:hs');
      shell.store.membersOpen.set(true);
      expect(shell.store.membersOpen()).toBe(true);

      shell.members.onSelectMember({
        userId: '@bob:hs',
        name: 'Bob',
        initial: 'B',
        avatarMxc: null,
        powerLevel: 0,
        isCreator: false,
      });

      expect(shell.store.membersOpen()).toBe(false);
      expect(memberInfoOpen).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('keeps the members column open when a member is selected on the wide layout', () => {
    // The base matchMedia stub reports non-drawer (matches:false) — i.e. the wide
    // static column, the desktop-protected path. onSelectMember must NOT collapse it.
    const shell = build();
    shell.store.activeRoomId.set('!r:hs');
    shell.store.membersOpen.set(true);

    shell.members.onSelectMember({
      userId: '@bob:hs',
      name: 'Bob',
      initial: 'B',
      avatarMxc: null,
      powerLevel: 0,
      isCreator: false,
    });

    expect(shell.store.membersOpen()).toBe(true);
    expect(memberInfoOpen).toHaveBeenCalled();
  });

  it('opens no conversation when the member panel is dismissed', async () => {
    const shell = build();
    shell.store.activeRoomId.set('!r:hs');
    memberInfoOpen.mockResolvedValue(null); // dismissed

    shell.members.onSelectMember({
      userId: '@bob:hs',
      name: 'Bob',
      initial: 'B',
      avatarMxc: null,
      powerLevel: 0,
      isCreator: false,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(memberInfoOpen).toHaveBeenCalled();
    expect(createDirectMessage).not.toHaveBeenCalled();
  });

  it('invites the picked user to the active room and toasts success', async () => {
    const shell = build();
    shell.store.activeRoomId.set('!r:hs');
    pick.mockResolvedValue('@bob:hs');

    await shell.rooms.onInviteToRoom();

    expect(inviteUser).toHaveBeenCalledWith('!r:hs', '@bob:hs');
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('captures an invite failure in spaceError without a success toast', async () => {
    const shell = build();
    shell.store.activeRoomId.set('!r:hs');
    pick.mockResolvedValue('@bob:hs');
    inviteUser.mockReturnValue(throwError(() => new Error('forbidden')));

    await shell.rooms.onInviteToRoom();

    // runWithBusy records the message in spaceError (the shell's effect toasts it,
    // like the create-space path); no success toast on failure.
    expect(shell.status.error()).toBe('forbidden');
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('shows the user that failure, rather than only recording it', () => {
    // The sibling above asserts no toast — true only because nothing has flushed yet. The
    // page turns `status.error` into a danger toast from a constructor effect, and every
    // failure test in this file stopped at the signal, so deleting that effect outright
    // left all 192 tests green: the error was recorded and never shown. What was missing
    // was a flush AFTER the failure, not a rendered harness.
    const shell = build();
    shell.status.error.set('forbidden');

    TestBed.tick();

    expect(toastShow).toHaveBeenCalledWith(
      'forbidden',
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('does not invite when the picker is cancelled', async () => {
    const shell = build();
    shell.store.activeRoomId.set('!r:hs');
    pick.mockResolvedValue(null);

    await shell.rooms.onInviteToRoom();

    expect(inviteUser).not.toHaveBeenCalled();
  });

  it('invites to the active space from the sidebar action', async () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    pick.mockResolvedValue('@bob:hs');

    await shell.rooms.onInviteToSpace();

    expect(inviteUser).toHaveBeenCalledWith('!s:hs', '@bob:hs');
  });

  it('accepts a room invite (joins) and selects the joined room', () => {
    const shell = build();
    pending.set([pendingInvite({ roomId: '!i:hs', isSpace: false })]);

    shell.invites.onAcceptInvite({ roomId: '!i:hs' });

    expect(acceptInvite).toHaveBeenCalledWith('!i:hs', undefined);
    expect(shell.store.activeRoomId()).toBe('!i:hs');
  });

  it('leaves a room invite on a view that can actually show the room', () => {
    // Accepting used to force the Home view, which lists DIRECT MESSAGES ONLY since the
    // rail split — so the room you had just joined was invisible in the sidebar, and the
    // row count went DOWN. Recent activity is the default and lists everything; accepting
    // a non-DM room must not navigate away from it.
    const shell = build();
    pending.set([pendingInvite({ roomId: '!i:hs', isDirect: false })]);
    expect(shell.store.recentView()).toBe(true);

    shell.invites.onAcceptInvite({ roomId: '!i:hs' });

    expect(shell.store.recentView()).toBe(true);
    expect(shell.store.activeRoomId()).toBe('!i:hs');
  });

  it('still lands a DM invite on the direct-message view', () => {
    // A DM is exactly what that view shows, so switching to it is right here.
    const shell = build();
    pending.set([pendingInvite({ roomId: '!d:hs', isDirect: true })]);

    shell.invites.onAcceptInvite({ roomId: '!d:hs' });

    expect(shell.store.recentView()).toBe(false);
    expect(shell.store.activeSpaceId()).toBeNull();
    expect(shell.store.activeRoomId()).toBe('!d:hs');
  });

  it('accepts a space invite without auto-selecting a room', () => {
    const shell = build();
    pending.set([pendingInvite({ roomId: '!s:hs', isSpace: true })]);

    shell.invites.onAcceptInvite({ roomId: '!s:hs' });

    expect(acceptInvite).toHaveBeenCalledWith('!s:hs', undefined);
    expect(shell.store.activeRoomId()).toBeNull(); // a space lands in the rail, not selected
  });

  it('declines an invite (leaves)', () => {
    const shell = build();

    shell.invites.onDeclineInvite({ roomId: '!i:hs' });

    expect(declineInvite).toHaveBeenCalledWith('!i:hs', undefined);
  });

  it('opens the new-chat action sheet on Home', async () => {
    const shell = build();
    const sheetOpen = TestBed.inject(TrnActionSheetService).open as ReturnType<
      typeof vi.fn
    >;

    shell.rooms.onNewChat();

    expect(sheetOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: expect.arrayContaining([
          expect.objectContaining({ text: 'Create a room' }),
          expect.objectContaining({ text: 'Explore public rooms' }),
          expect.objectContaining({ text: 'Start a direct message' }),
        ]),
      }),
    );
  });
});

// Selecting a space loads its hierarchy; joining a not-yet-joined child and
// removing a joined child delegate to SpacesService (the live read model + sync
// surface the result, so the page only fires the SDK-backed call).
describe('RoomsPage space hierarchy actions', () => {
  let alertConfirm: ReturnType<typeof vi.fn>;
  let openSpace: ReturnType<typeof vi.fn>;
  let joinRoom: ReturnType<typeof vi.fn>;
  let removeRoomFromSpace: ReturnType<typeof vi.fn>;

  function childRoom(over: Partial<SpaceChildRoom> = {}): SpaceChildRoom {
    return {
      roomId: '!c:hs',
      name: 'general',
      initial: 'G',
      avatarMxc: null,
      memberCount: 3,
      joinRule: 'public',
      suggested: false,
      isSpace: false,
      via: ['hs.example'],
      joined: false,
      ...over,
    };
  }

  function build() {
    alertConfirm = vi.fn().mockResolvedValue(false);
    openSpace = vi.fn();
    joinRoom = vi.fn(() => of(undefined));
    removeRoomFromSpace = vi.fn(() => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService, {
          rooms: signal<RoomSummary[]>([
            {
              id: '!c:hs',
              name: 'general',
              initial: 'G',
              avatarMxc: null,
              topic: '',
              memberCount: 0,
              encrypted: false,
              unreadCount: 0,
              highlightCount: 0,
              hasUnread: false,
              markedUnread: false,
              lastMessage: '',
              activityTs: 0,
              favourite: false,
            },
          ]),
        }),
        MockProvider(SpacesService, {
          openSpace,
          joinRoom,
          removeRoomFromSpace,
          spaces: signal<SpaceSummary[]>([
            {
              id: '!s:hs',
              name: 'My Space',
              initial: 'M',
              avatarMxc: null,
              childRoomIds: [],
            },
          ]),
        }),
        MockProvider(TimelineService),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>(['@me:hs']).asReadonly(),
          clientFor: () => ({ getUser: () => null }) as never,
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map(),
          ).asReadonly(),
        }),
        MockProvider(ThreadsService),
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(MessageSearchService),
        MockProvider(AuthService),
        MockProvider(TrnDialogService),
        MockProvider(TrnAlertService, { confirm: alertConfirm }),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  it('loads the hierarchy when a space is selected (and clears it for Home)', () => {
    const shell = build();

    shell.nav.onSelectSpace('!s:hs');
    expect(shell.store.activeSpaceId()).toBe('!s:hs');
    expect(openSpace).toHaveBeenCalledWith('!s:hs');

    shell.nav.onSelectSpace(null);
    expect(openSpace).toHaveBeenLastCalledWith(null);
  });

  it('joins a not-yet-joined child through its via servers', () => {
    const shell = build();

    shell.spaces.onJoinChild(
      childRoom({ roomId: '!x:hs', via: ['hs.example'] }),
    );

    expect(joinRoom).toHaveBeenCalledWith('!x:hs', ['hs.example']);
  });

  it('confirms then removes a joined child from the active space', async () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    alertConfirm.mockResolvedValue(true);

    await shell.spaces.onRemoveFromSpace('!c:hs');

    // The confirmation names the channel and the space.
    expect(alertConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ header: 'Remove from space' }),
    );
    expect(removeRoomFromSpace).toHaveBeenCalledWith('!s:hs', '!c:hs');
  });

  it('does not remove when the confirm is cancelled', async () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    alertConfirm.mockResolvedValue(false);

    await shell.spaces.onRemoveFromSpace('!c:hs');

    expect(removeRoomFromSpace).not.toHaveBeenCalled();
  });

  it('does not prompt to remove on Home (no active space)', async () => {
    const shell = build();
    shell.store.activeSpaceId.set(null);

    await shell.spaces.onRemoveFromSpace('!c:hs');

    expect(alertConfirm).not.toHaveBeenCalled();
    expect(removeRoomFromSpace).not.toHaveBeenCalled();
  });
});

// The quick switcher (Ctrl/Cmd+K) presents a modal and, on a selection, jumps per
// kind: room/dm open the room, space selects it in the rail, a directory person
// opens a DM, an invite runs the page's accept path.
describe('RoomsPage quick switcher', () => {
  let pick: ReturnType<typeof vi.fn>;
  let messageSearch: ReturnType<typeof vi.fn>;
  let createDirectMessage: ReturnType<typeof vi.fn>;
  let acceptInvite: ReturnType<typeof vi.fn>;
  let openSpace: ReturnType<typeof vi.fn>;
  let timelineOpen: ReturnType<typeof vi.fn>;
  let pending: WritableSignal<PendingInvite[]>;
  let dialogHasOpen: ReturnType<typeof vi.fn>;

  function build() {
    pick = vi.fn();
    messageSearch = vi.fn();
    createDirectMessage = vi.fn(() => of('!dm:hs'));
    acceptInvite = vi.fn(() => of(undefined));
    openSpace = vi.fn();
    timelineOpen = vi.fn();
    pending = signal<PendingInvite[]>([]);
    dialogHasOpen = vi.fn().mockReturnValue(false);
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService, {
          createDirectMessage,
          // The jump resolves the row's owning account from the known room set.
          rooms: signal<RoomSummary[]>([]),
          directRoomIds: signal<ReadonlySet<string>>(new Set()).asReadonly(),
        }),
        MockProvider(SpacesService, {
          openSpace,
          spaces: signal<SpaceSummary[]>([]),
          childRoomIds: vi.fn(() => []),
        }),
        invitesProvider({
          pendingInvites: pending,
          acceptInvite,
        }),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService, { pick }),
        MockProvider(MessageSearchService, { search: messageSearch }),
        MockProvider(TimelineService, { open: timelineOpen }),
        MockProvider(MediaService),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>(['@me:hs']).asReadonly(),
          clientFor: () => ({ getUser: () => null }) as never,
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map(),
          ).asReadonly(),
        }),
        MockProvider(ThreadsService),
        MockProvider(AuthService),
        MockProvider(TrnDialogService, { hasOpen: dialogHasOpen }),
        MockProvider(TrnAlertService),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  it('opens the selected room', async () => {
    const shell = build();
    pick.mockResolvedValue({ kind: 'room', id: '!r:hs' });

    await shell.shortcuts.openSwitcher();

    expect(shell.store.activeRoomId()).toBe('!r:hs');
    expect(timelineOpen).toHaveBeenCalledWith('!r:hs');
  });

  it('opens a DM result like a room', async () => {
    const shell = build();
    pick.mockResolvedValue({ kind: 'dm', id: '!d:hs' });

    await shell.shortcuts.openSwitcher();

    expect(shell.store.activeRoomId()).toBe('!d:hs');
  });

  it('selects a space in the rail (loading its hierarchy)', async () => {
    const shell = build();
    pick.mockResolvedValue({ kind: 'space', id: '!s:hs' });

    await shell.shortcuts.openSwitcher();

    expect(shell.store.activeSpaceId()).toBe('!s:hs');
    expect(openSpace).toHaveBeenCalledWith('!s:hs');
    expect(shell.store.activeRoomId()).toBeNull();
  });

  it('opens (or reuses) a DM for a directory person', async () => {
    const shell = build();
    pick.mockResolvedValue({ kind: 'user', id: '@bob:hs' });

    await shell.shortcuts.openSwitcher();

    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(shell.store.activeRoomId()).toBe('!dm:hs');
  });

  it('runs the accept path for an invite result', async () => {
    const shell = build();
    pending.set([
      {
        roomId: '!i:hs',
        name: 'Invited',
        initial: 'I',
        avatarMxc: null,
        inviterName: 'Alice',
        isSpace: false,
        isDirect: false,
      },
    ]);
    pick.mockResolvedValue({ kind: 'invite', id: '!i:hs' });

    await shell.shortcuts.openSwitcher();

    expect(acceptInvite).toHaveBeenCalledWith('!i:hs', undefined);
    expect(shell.store.activeRoomId()).toBe('!i:hs');
  });

  it('does nothing when the switcher is cancelled', async () => {
    const shell = build();
    pick.mockResolvedValue(null);

    await shell.shortcuts.openSwitcher();

    expect(shell.store.activeRoomId()).toBeNull();
    expect(timelineOpen).not.toHaveBeenCalled();
  });

  it('Ctrl/Cmd+K prevents default and opens the switcher', async () => {
    const shell = build();
    pick.mockResolvedValue(null);
    const preventDefault = vi.fn();

    // Cmd+K resolves to the `switcher.open` shortcut through the registry.
    shell.shortcuts.onGlobalKeydown({
      key: 'k',
      code: 'KeyK',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(preventDefault).toHaveBeenCalled(); // sync — stops the browser's Cmd+K
    await new Promise((resolve) => setTimeout(resolve)); // settle the async openSwitcher()
    expect(pick).toHaveBeenCalled();
  });

  it('does not open the switcher over an existing overlay', async () => {
    const shell = build();
    dialogHasOpen.mockReturnValue(true);

    await shell.shortcuts.openSwitcher();

    // A thread/search/verification modal owns the screen — the switcher must not
    // stack over it (picking a result would releaseAll() its pinned media).
    expect(pick).not.toHaveBeenCalled();
  });

  it('opens in-room message search for the active room and jumps to the hit', async () => {
    const shell = build();
    shell.nav.onSelectRoom('!r:hs');
    messageSearch.mockResolvedValue('$evt:hs');

    await shell.messages.openMessageSearch();

    expect(messageSearch).toHaveBeenCalledWith('!r:hs');
    expect(shell.store.messageSearchTarget()).toBe('$evt:hs');
    expect(shell.store.jumpRequest()).toBe(1);
  });

  it('in-room search bumps jumpRequest again when the SAME hit is re-picked', async () => {
    // Same crux as the pinned panel: picking the identical hit twice must still
    // re-fire the jump, which only happens because jumpRequest keeps incrementing.
    const shell = build();
    shell.nav.onSelectRoom('!r:hs');
    messageSearch.mockResolvedValue('$evt:hs');

    await shell.messages.openMessageSearch();
    expect(shell.store.jumpRequest()).toBe(1);

    await shell.messages.openMessageSearch();

    expect(shell.store.messageSearchTarget()).toBe('$evt:hs');
    expect(shell.store.jumpRequest()).toBe(2);
  });

  it('does not jump when in-room search is cancelled', async () => {
    const shell = build();
    shell.nav.onSelectRoom('!r:hs');
    messageSearch.mockResolvedValue(null);

    await shell.messages.openMessageSearch();

    expect(shell.store.messageSearchTarget()).toBeNull();
    expect(shell.store.jumpRequest()).toBe(0);
  });

  it('does not open in-room search when no room is active', async () => {
    const shell = build();
    messageSearch.mockResolvedValue('$evt:hs');

    await shell.messages.openMessageSearch();

    expect(messageSearch).not.toHaveBeenCalled();
    expect(shell.store.messageSearchTarget()).toBeNull();
  });
});

// Below md the rail + sidebar (room list) and the chat are separate full-screen
// pages keyed off `activeRoomId`: picking a room opens the chat page, and the back
// button (`backToList`) returns to the list. At md+ both columns are static columns.
describe('RoomsPage mobile navigation', () => {
  let timelineOpen: ReturnType<typeof vi.fn>;
  let threadsOpen: ReturnType<typeof vi.fn>;
  let releaseAll: ReturnType<typeof vi.fn>;

  function build() {
    timelineOpen = vi.fn();
    threadsOpen = vi.fn();
    releaseAll = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService),
        MockProvider(SpacesService),
        MockProvider(TimelineService, { open: timelineOpen }),
        MockProvider(MediaService, { releaseAll }),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>(['@me:hs']).asReadonly(),
          clientFor: () => ({ getUser: () => null }) as never,
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map(),
          ).asReadonly(),
        }),
        MockProvider(ThreadsService, { open: threadsOpen }),
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(MessageSearchService),
        MockProvider(AuthService),
        MockProvider(TrnDialogService),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  it('backToList closes the open room, returning to the list page', () => {
    const shell = build();
    shell.nav.onSelectRoom('!r:hs');
    expect(shell.store.activeRoomId()).toBe('!r:hs');

    shell.page.backToList();

    expect(shell.store.activeRoomId()).toBeNull();
    expect(TestBed.inject(TimelineService).close).toHaveBeenCalled();
    expect(TestBed.inject(ThreadsService).close).toHaveBeenCalled();
    expect(TestBed.inject(PinnedMessagesService).close).toHaveBeenCalled();
  });

  it('closing a room resets an open members drawer so it does not carry to the next room', () => {
    // Force the narrow (drawer) layout so the member list reads as an overlay.
    const restore = stubNarrowLayout();
    try {
      const shell = build();
      shell.nav.onSelectRoom('!a:hs');
      shell.store.membersOpen.set(true); // the drawer is open in room A
      expect(shell.store.membersOpen()).toBe(true);

      shell.page.backToList();

      // The drawer state is dropped, so it won't slide in over the next room.
      expect(shell.store.membersOpen()).toBe(false);
    } finally {
      restore();
    }
  });

  it('seeds the members list open as the wide static column and toggleMembers flips it', () => {
    // The base stub reports non-drawer (matches:false) — the wide layout — so the static
    // members column shows by default; toggleMembers hides and re-shows it.
    const shell = build();
    expect(shell.store.membersOpen()).toBe(true);

    shell.page.toggleMembers();
    expect(shell.store.membersOpen()).toBe(false);

    shell.page.toggleMembers();
    expect(shell.store.membersOpen()).toBe(true);
  });

  it('seeds the members drawer closed on the narrow layout', () => {
    // At/below the drawer cutoff the list is the overlay drawer, which starts closed
    // rather than defaulting open like the wide static column.
    const restore = stubNarrowLayout();
    try {
      expect(build().store.membersOpen()).toBe(false);
    } finally {
      restore();
    }
  });

  it('closeMembers closes the member list (the mobile drawer backdrop)', () => {
    const shell = build();
    shell.store.membersOpen.set(true);
    expect(shell.store.membersOpen()).toBe(true);

    shell.page.closeMembers();
    expect(shell.store.membersOpen()).toBe(false);
  });

  it('onSelectRoom opens the room (switching to the mobile chat page)', () => {
    const shell = build();

    shell.nav.onSelectRoom('!r:hs');

    expect(shell.store.activeRoomId()).toBe('!r:hs');
    expect(timelineOpen).toHaveBeenCalledWith('!r:hs');
    expect(threadsOpen).toHaveBeenCalledWith('!r:hs');
    expect(releaseAll).toHaveBeenCalled();
  });
});

// The user-panel switcher summarises every signed-in account: each row is that
// account's own client profile (display name + avatar) with a fallback to the raw
// MXID, plus its unread total — and it tolerates an account whose client isn't
// live yet (clientFor → null), which still shows as a row with a zero badge.
describe('RoomsPage account switcher summary', () => {
  const meAvatar = 'mxc://hs/me';

  function build() {
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService, { revision: signal(0).asReadonly() }),
        MockProvider(SpacesService),
        MockProvider(TimelineService),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>([
            '@me:hs',
            '@alt:hs',
          ]).asReadonly(),
          // '@me:hs' has a live client with a hydrated profile; '@alt:hs' isn't
          // live yet (no client created), so clientFor → null for it.
          clientFor: (userId: string) =>
            userId === '@me:hs'
              ? ({
                  getUser: () => ({ displayName: 'Me', avatarUrl: meAvatar }),
                } as never)
              : null,
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map([['@me:hs', 4]]),
          ).asReadonly(),
        }),
        MockProvider(ThreadsService),
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(MessageSearchService),
        MockProvider(AuthService),
        MockProvider(TrnDialogService),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  it('summarises each account by its client profile, MXID fallback, and unread total', () => {
    const shell = build();

    // '@me:hs': live profile (name + avatar) with its unread total from the
    // aggregator. '@alt:hs': no live client, so name falls back to the MXID, the
    // avatar is null, and its unread defaults to 0 (absent from the map).
    expect(shell.vm.accounts()).toEqual([
      { userId: '@me:hs', displayName: 'Me', avatarMxc: meAvatar, unread: 4 },
      { userId: '@alt:hs', displayName: '@alt:hs', avatarMxc: null, unread: 0 },
    ]);
  });
});

// Keyboard room switching (issue #12): the single `onGlobalKeydown` dispatcher. The MRU
// service and the pure nav helpers have their own specs; these assert the wiring — which
// chord opens what, the desktop gate, and the overlay guard.
describe('RoomsPage keyboard room switching', () => {
  function roomSummary(id: string, unread = 0): RoomSummary {
    return {
      id,
      name: id,
      initial: id[1].toUpperCase(),
      avatarMxc: null,
      topic: '',
      memberCount: 0,
      encrypted: false,
      unreadCount: unread,
      highlightCount: 0,
      hasUnread: unread > 0,
      markedUnread: false,
      lastMessage: '',
      activityTs: 0,
      favourite: false,
    };
  }

  let dialogOpen = false;

  let keyboardRooms: WritableSignal<RoomSummary[]>;

  const releaseAll = vi.fn();
  function build() {
    releaseAll.mockClear();
    dialogOpen = false;
    // Display order a, b, c; b and c carry unread.
    keyboardRooms = signal<RoomSummary[]>([
      roomSummary('!a:hs'),
      roomSummary('!b:hs', 3),
      roomSummary('!c:hs', 1),
    ]);
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService, {
          rooms: keyboardRooms,
          directRoomIds: signal<ReadonlySet<string>>(new Set()),
        }),
        MockProvider(SpacesService, {
          spaces: signal([]),
          childRoomIds: vi.fn(() => []),
        }),
        MockProvider(TimelineService),
        MockProvider(MediaService, { releaseAll }),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>(['@me:hs']).asReadonly(),
          clientFor: () => ({ getUser: () => null }) as never,
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map(),
          ).asReadonly(),
        }),
        MockProvider(ThreadsService),
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(MessageSearchService),
        MockProvider(AuthService),
        MockProvider(TrnDialogService, { hasOpen: () => dialogOpen }),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  /** A minimal KeyboardEvent-like with a preventDefault spy, for the host handler. */
  function key(init: Partial<KeyboardEvent>): KeyboardEvent {
    return {
      key: '',
      code: '',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault: vi.fn(),
      ...init,
    } as unknown as KeyboardEvent;
  }

  afterEach(() => {
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
  });

  /** Visit a → b → c so the MRU is [c, b, a] and we're in c. */
  function visitABC(shell: ReturnType<typeof shellFrom>): void {
    shell.nav.onSelectRoom('!a:hs');
    shell.nav.onSelectRoom('!b:hs');
    shell.nav.onSelectRoom('!c:hs');
  }

  it('ignores a shortcut that resolves to the room already open', () => {
    // Not a no-op for tidiness: re-entering onSelectRoom calls media.releaseAll(), which
    // revokes the object URLs for images currently on screen. timeline.open() early-returns
    // on the same id; releaseAll does not. Reachable with a one-room list, because the list
    // walk wraps around to the room you are already in.
    const shell = build();
    keyboardRooms.set([roomSummary('!only:hs')]);
    shell.nav.onSelectRoom('!only:hs');
    releaseAll.mockClear();

    shell.page.onGlobalKeydown(key({ key: 'ArrowDown', altKey: true }));

    expect(releaseAll).not.toHaveBeenCalled();
  });

  it('keeps the keyboard surface wired through the page', () => {
    // The host binding names a member of the component class, so the page keeps a delegate
    // nothing else calls. Re-pointing this suite onto the coordinators removed the only
    // test crossing that seam — emptying the delegate body left 192 tests green, i.e. the
    // whole keyboard feature could be unplugged from the page unnoticed.
    const shell = build();
    visitABC(shell);

    shell.page.onGlobalKeydown(key({ key: "'", ctrlKey: true }));

    expect(shell.store.activeRoomId()).toBe('!b:hs');
  });

  it('hops back through the visited stack, cycling deeper, without recording mid-cycle', () => {
    const shell = build();
    visitABC(shell);

    shell.shortcuts.onGlobalKeydown(key({ key: "'", ctrlKey: true }));
    expect(shell.store.activeRoomId()).toBe('!b:hs'); // previous room

    shell.shortcuts.onGlobalKeydown(key({ key: "'", ctrlKey: true }));
    expect(shell.store.activeRoomId()).toBe('!a:hs'); // two back — cycling deeper

    // Shift reverses.
    shell.shortcuts.onGlobalKeydown(
      key({ key: "'", ctrlKey: true, shiftKey: true }),
    );
    expect(shell.store.activeRoomId()).toBe('!b:hs');
  });

  it('consumes the chord it handles and ignores an unmodified quote', () => {
    const shell = build();
    visitABC(shell);

    const handled = key({ key: "'", metaKey: true });
    shell.shortcuts.onGlobalKeydown(handled);
    expect(handled.preventDefault).toHaveBeenCalled();

    const typed = key({ key: "'" }); // no modifier → plain typing
    shell.shortcuts.onGlobalKeydown(typed);
    expect(typed.preventDefault).not.toHaveBeenCalled();
  });

  it('walks the visible list with Alt+Arrow, wrapping', () => {
    const shell = build(); // list order a, b, c; in c after visiting
    visitABC(shell);

    shell.shortcuts.onGlobalKeydown(key({ key: 'ArrowDown', altKey: true }));
    expect(shell.store.activeRoomId()).toBe('!a:hs'); // c → wrap to a

    shell.shortcuts.onGlobalKeydown(key({ key: 'ArrowUp', altKey: true }));
    expect(shell.store.activeRoomId()).toBe('!c:hs'); // a → wrap back to c
  });

  it('jumps to the next unread room with Alt+Shift+Arrow', () => {
    const shell = build(); // b(3) and c(1) are unread
    shell.nav.onSelectRoom('!a:hs'); // in a read room

    shell.shortcuts.onGlobalKeydown(
      key({ key: 'ArrowDown', altKey: true, shiftKey: true }),
    );
    expect(shell.store.activeRoomId()).toBe('!b:hs'); // first unread
  });

  it('ignores Ctrl/Cmd+1…9 and Ctrl+Tab on the web (browser-reserved)', () => {
    const shell = build(); // no desktop marker
    visitABC(shell);

    shell.shortcuts.onGlobalKeydown(
      key({ code: 'Digit1', key: '1', metaKey: true }),
    );
    expect(shell.store.activeRoomId()).toBe('!c:hs'); // unchanged
    shell.shortcuts.onGlobalKeydown(key({ key: 'Tab', ctrlKey: true }));
    expect(shell.store.activeRoomId()).toBe('!c:hs'); // unchanged
  });

  it('jumps to the Nth most-recent room with Ctrl/Cmd+1…9 on the desktop shell', () => {
    // The marker must be present before the page reads it at construction.
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
      isElectron: true,
    };
    const shell = build();
    visitABC(shell); // MRU [c, b, a], in c

    shell.shortcuts.onGlobalKeydown(
      key({ code: 'Digit2', key: '2', ctrlKey: true }),
    );
    expect(shell.store.activeRoomId()).toBe('!a:hs'); // 2 = two rooms back
  });

  it('hops with Ctrl+Tab on the desktop shell', () => {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
      isElectron: true,
    };
    const shell = build();
    visitABC(shell); // in c

    shell.shortcuts.onGlobalKeydown(key({ key: 'Tab', ctrlKey: true }));
    expect(shell.store.activeRoomId()).toBe('!b:hs'); // Tab hops like the quote
  });

  // The MRU outlives account switches and unticks, so a numbered jump can name a room no
  // account in scope still holds — unlike hop, nth() filters against nothing. Opening it
  // would tear the timeline down and leave a blank chat pane, so it must decline.
  it('ignores a numbered jump to a room the list no longer knows', () => {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
      isElectron: true,
    };
    const shell = build();
    visitABC(shell); // MRU [c, b, a], in c
    // '!b:hs' leaves the scope (its account was unticked, or signed out).
    keyboardRooms.set([roomSummary('!a:hs'), roomSummary('!c:hs')]);

    shell.shortcuts.onGlobalKeydown(
      key({ code: 'Digit1', key: '1', ctrlKey: true }),
    );

    expect(shell.store.activeRoomId()).toBe('!c:hs'); // stayed put rather than opening a ghost
  });

  it('still jumps to a room that is in scope', () => {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
      isElectron: true,
    };
    const shell = build();
    visitABC(shell);

    shell.shortcuts.onGlobalKeydown(
      key({ code: 'Digit1', key: '1', ctrlKey: true }),
    );

    expect(shell.store.activeRoomId()).toBe('!b:hs');
  });

  it('stays quiet while an overlay owns the screen', () => {
    const shell = build();
    visitABC(shell);
    dialogOpen = true;

    const event = key({ key: "'", ctrlKey: true });
    shell.shortcuts.onGlobalKeydown(event);
    expect(shell.store.activeRoomId()).toBe('!c:hs'); // no hop
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('follows a rebound chord, not the old one', () => {
    const shell = build();
    visitABC(shell); // in c, MRU [c, b, a]
    // Move "hop back" from Ctrl+' to Alt+J through the registry.
    TestBed.inject(KeyboardShortcutsService).rebind('room.hop.back', {
      accel: false,
      alt: true,
      shift: false,
      key: 'j',
    });

    shell.shortcuts.onGlobalKeydown(key({ key: "'", ctrlKey: true }));
    expect(shell.store.activeRoomId()).toBe('!c:hs'); // old chord no longer hops

    shell.shortcuts.onGlobalKeydown(key({ key: 'j', altKey: true }));
    expect(shell.store.activeRoomId()).toBe('!b:hs'); // the new chord does

    TestBed.inject(KeyboardShortcutsService).resetAll(); // don't leak into other specs
  });
});

// Mixed-account view (issue #10): the global "All accounts" scope spans every signed-in
// account across ALL surfaces — Recent, Home's DMs, the Rooms list and the rail spaces —
// and opening a foreign-account item switches to that account first.
describe('RoomsPage mixed-account view', () => {
  function room(
    id: string,
    accountId: string,
    opts: { directUserId?: string; unread?: number } = {},
  ): RoomSummary {
    return {
      id,
      accountId,
      accountIds: [accountId],
      name: id,
      initial: id[1].toUpperCase(),
      avatarMxc: null,
      topic: '',
      memberCount: 0,
      encrypted: false,
      unreadCount: opts.unread ?? 0,
      highlightCount: 0,
      hasUnread: (opts.unread ?? 0) > 0,
      markedUnread: false,
      lastMessage: '',
      activityTs: 0,
      favourite: false,
      directUserId: opts.directUserId,
    };
  }

  function space(
    id: string,
    accountId: string,
    childRoomIds: string[] = [],
  ): SpaceSummary {
    return {
      id,
      accountId,
      name: id,
      initial: 'S',
      avatarMxc: null,
      childRoomIds,
    };
  }

  // Cross-account rooms the aggregator projects while "All accounts" is on: two plain
  // rooms, two DMs (one per account), and one non-DM room that is a child of @alt's space.
  const mixedRoomList = (): RoomSummary[] => [
    room('!mine:hs', '@me:hs'),
    room('!theirs:hs', '@alt:hs', { unread: 7 }),
    room('!dm-mine:hs', '@me:hs', { directUserId: '@x:hs' }),
    room('!dm-theirs:hs', '@alt:hs', { directUserId: '@y:hs', unread: 3 }),
    room('!child-theirs:hs', '@alt:hs', { unread: 5 }),
  ];

  let switchAccount: ReturnType<typeof vi.fn>;
  let setMixedRoomsAccounts: ReturnType<typeof vi.fn>;
  /** The picker's current selection, driven directly by the tests. */
  let shownAccounts: WritableSignal<ReadonlySet<string>>;
  let toggleAccount: ReturnType<typeof vi.fn>;

  function build(
    accountIds: string[],
    avatars: Record<string, string | null> = {},
  ) {
    switchAccount = vi.fn(() => of(undefined));
    setMixedRoomsAccounts = vi.fn();
    shownAccounts = signal<ReadonlySet<string>>(new Set(['@me:hs']));
    toggleAccount = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService, {
          rooms: signal([room('!mine:hs', '@me:hs')]),
          directRoomIds: signal<ReadonlySet<string>>(new Set()),
          revision: signal(0).asReadonly(),
        }),
        MockProvider(SpacesService, {
          spaces: signal([space('!s-mine:hs', '@me:hs')]),
          childRoomIds: vi.fn(() => []),
        }),
        MockProvider(AccountScopeService, {
          selected: shownAccounts.asReadonly(),
          mixing: computed(() => shownAccounts().size > 1),
          toggle: toggleAccount,
        }),
        MockProvider(MixedRoomsService, {
          rooms: signal(mixedRoomList()),
          setAccounts: setMixedRoomsAccounts,
        }),
        MockProvider(MixedSpacesService, {
          spaces: signal([
            space('!s-mine:hs', '@me:hs'),
            space('!s-alt:hs', '@alt:hs', ['!child-theirs:hs']),
          ]),
          setAccounts: vi.fn(),
        }),
        MockProvider(MixedInvitesService, {
          invites: signal<PendingInvite[]>([]),
          setAccounts: vi.fn(),
        }),
        MockProvider(TimelineService),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>(accountIds).asReadonly(),
          clientFor: (id: string) =>
            ({
              getUser: () => ({ avatarUrl: avatars[id] ?? null }),
            }) as never,
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map(),
          ).asReadonly(),
        }),
        MockProvider(ThreadsService),
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(MessageSearchService),
        MockProvider(AuthService, { switchAccount }),
        MockProvider(TrnDialogService),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  it('scopes Recent + rail spaces to the active account by default', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    // Default 'this' — the active account only.
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual(['!mine:hs']);
    expect(shell.vm.railSpaces().map((s) => s.id)).toEqual(['!s-mine:hs']);
    expect(shell.vm.accountBadges().size).toBe(0); // no badges outside mixed mode
  });

  it('Recent spans every account when the toggle is "All accounts"', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    TestBed.tick(); // run the enable effect

    // Recent lists every account's rooms unfiltered, in the aggregator's order.
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual([
      '!mine:hs',
      '!theirs:hs',
      '!dm-mine:hs',
      '!dm-theirs:hs',
      '!child-theirs:hs',
    ]);
    expect(shell.vm.railSpaces().map((s) => s.id)).toEqual([
      '!s-mine:hs',
      '!s-alt:hs',
    ]);
    expect(setMixedRoomsAccounts).toHaveBeenCalledWith(
      new Set(['@me:hs', '@alt:hs']),
    );
    expect(shell.vm.accountBadges().size).toBeGreaterThan(0);
  });

  it('carries each account’s real avatar into the badge lookup', () => {
    const shell = build(['@me:hs', '@alt:hs'], {
      '@alt:hs': 'mxc://hs/alt-avatar',
    });
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));

    // The badge exposes the account's own avatar (resolved to the real image downstream)…
    expect(shell.vm.accountBadges().get('@alt:hs')?.avatarMxc).toBe(
      'mxc://hs/alt-avatar',
    );
    // …and null for an account with no avatar, so the badge falls back to its initial.
    expect(shell.vm.accountBadges().get('@me:hs')?.avatarMxc).toBeNull();
  });

  it('Home shows every account’s DMs in mixed mode', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onSelectSpace(null); // Home — leaves Recent

    // Both accounts' DMs (classified by each row's own-account m.direct), nothing else.
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual([
      '!dm-mine:hs',
      '!dm-theirs:hs',
    ]);
    expect(shell.vm.sidebarTitle()).toBe('Direct Messages');
  });

  it('Rooms shows every account’s non-DM, non-space rooms in mixed mode', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onShowRooms();

    // Non-DM rooms from both accounts, excluding DMs and @alt's space child.
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual([
      '!mine:hs',
      '!theirs:hs',
    ]);
    expect(shell.vm.sidebarTitle()).toBe('Rooms');
  });

  it('switches to the owning account before opening a foreign room', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));

    shell.routing.onSelectRoomRow('!theirs:hs'); // belongs to @alt:hs
    expect(switchAccount).toHaveBeenCalledWith('@alt:hs');

    // A room on the active account opens without a switch.
    switchAccount.mockClear();
    shell.routing.onSelectRoomRow('!mine:hs');
    expect(switchAccount).not.toHaveBeenCalled();
    expect(shell.store.activeRoomId()).toBe('!mine:hs');
  });

  it('switches to the owning account before selecting a foreign space', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));

    shell.routing.onSelectSpaceRow('!s-alt:hs'); // belongs to @alt:hs
    expect(switchAccount).toHaveBeenCalledWith('@alt:hs');

    // The active account's own space selects without a switch; Home (null) too.
    switchAccount.mockClear();
    shell.routing.onSelectSpaceRow('!s-mine:hs');
    shell.routing.onSelectSpaceRow(null);
    expect(switchAccount).not.toHaveBeenCalled();
  });

  it('narrows the projections back down when an account is unticked', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    TestBed.tick();
    expect(setMixedRoomsAccounts).toHaveBeenLastCalledWith(
      new Set(['@me:hs', '@alt:hs']),
    );

    shownAccounts.set(new Set(['@me:hs']));
    TestBed.tick();
    // One account is not a mix — the projection is told so and empties itself.
    expect(setMixedRoomsAccounts).toHaveBeenLastCalledWith(new Set(['@me:hs']));
    // Recent falls back to the active account's rooms only.
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual(['!mine:hs']);
  });

  // The rail badges must count what their view renders: before this they summed the ACTIVE
  // account's rooms while the list below showed every mixed account's.
  it('sums the rail unread badges across the mixed accounts', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));

    expect(shell.vm.recentUnread()).toBe(15); // 7 + 3 + 5 across both accounts
    expect(shell.vm.homeUnread()).toBe(3); // the foreign account's DM
    expect(shell.vm.roomsUnread()).toBe(7); // non-DM, minus @alt's space child
    expect(shell.vm.spaceUnread()['!s-alt:hs']).toBe(5); // the foreign space's child

    // Unticking drops back to the active account's own totals (all zero here).
    shownAccounts.set(new Set(['@me:hs']));
    expect(shell.vm.recentUnread()).toBe(0);
  });

  // A shortcut/MRU target is routinely OUTSIDE the current view (Home lists DMs only, a
  // space lists its children), so resolving the owning account from visibleRooms() would
  // miss and open the room on whatever client happens to be active.
  it('resolves a foreign room’s account even when the current view filters it out', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onSelectSpace(null); // Home — DMs only, so '!theirs:hs' is not visible
    expect(shell.vm.visibleRooms().map((r) => r.id)).not.toContain(
      '!theirs:hs',
    );

    shell.routing.onSelectRoomRow('!theirs:hs');

    expect(switchAccount).toHaveBeenCalledWith('@alt:hs');
  });

  // The switcher searches every mixed account, so a jump can land on a room owned by an
  // account that isn't active — it must switch first, exactly like clicking the row.
  it('switches accounts when jumping to a foreign room from the quick switcher', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    TestBed.inject(QuickSwitcherService).pick = vi.fn(() =>
      Promise.resolve({ kind: 'room' as const, id: '!theirs:hs' }),
    );

    await shell.shortcuts.openSwitcher();
    TestBed.tick(); // the follow-up open is deferred past the re-projection render

    expect(switchAccount).toHaveBeenCalledWith('@alt:hs');
    expect(shell.store.activeRoomId()).toBe('!theirs:hs');
  });

  it('switches accounts when jumping to a foreign space from the quick switcher', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    TestBed.inject(QuickSwitcherService).pick = vi.fn(() =>
      Promise.resolve({ kind: 'space' as const, id: '!s-alt:hs' }),
    );

    await shell.shortcuts.openSwitcher();

    expect(switchAccount).toHaveBeenCalledWith('@alt:hs');
  });

  // A room that is top-level for the account you are ACTING AS must not vanish from the
  // Rooms view just because a different mixed account files it inside one of its spaces.
  it('keeps a room that only another account files under a space', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onShowRooms();

    // '!child-theirs:hs' is a child of @alt's space, so it is excluded for @alt…
    expect(shell.vm.visibleRooms().map((r) => r.id)).not.toContain(
      '!child-theirs:hs',
    );
    // …while @me's own spaceless room stays, even though @alt's space claims a room id.
    expect(shell.vm.visibleRooms().map((r) => r.id)).toContain('!mine:hs');
  });

  // The pill's unread badge is summed over the mixed union, so the space it opens must
  // list that same union — otherwise the badge counts rooms the view never renders.
  it('lists a mixed space’s children from the same union its badge counts', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onSelectSpace('!s-alt:hs');

    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual([
      '!child-theirs:hs',
    ]);
  });

  // The space scope belongs to the outgoing account; the Recent/DMs/Rooms filter does not.
  it('keeps the Rooms filter across an account switch but drops the space', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onShowRooms();

    shell.routing.onSelectRoomRow('!theirs:hs'); // switches to @alt

    expect(shell.store.roomsView()).toBe(true); // the user's filter survives
    expect(shell.store.activeSpaceId()).toBeNull();
  });

  it('returns to Recent when the switch happened from inside a space', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onSelectSpace('!s-mine:hs');

    shell.routing.onSelectRoomRow('!theirs:hs');

    expect(shell.store.activeSpaceId()).toBeNull();
    expect(shell.store.recentView()).toBe(true);
  });

  it('forwards a picker tick to the account scope', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shell.routing.onToggleAccountShown('@alt:hs');
    expect(toggleAccount).toHaveBeenCalledWith('@alt:hs');
  });
});
