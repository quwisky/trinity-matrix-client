import {
  SHARED_MOCKS,
  clientStub,
  invitesProvider,
  shellFrom,
} from './rooms-page.spec-harness';
import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '@trinity/data-access/auth';
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
  UnreadAggregatorService,
  SpaceChildrenService,
  type RoomSummary,
  type SpaceSummary,
} from '@trinity/data-access/rooms';
import { ThreadsService, TimelineService } from '@trinity/data-access/timeline';
import {
  TrnAlertService,
  TrnDialogService,
  TrnToastService,
} from '@trinity/helm/overlay';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { expect, it, vi } from 'vitest';
import { RoomsPage } from './rooms.page';
import { UserPickerService } from '../user-picker/user-picker.service';
import { MemberInfoService } from '../member-info/member-info.service';
import { RoomSettingsComponent } from '../room-settings/room-settings.component';
import { AddToSpaceComponent } from '../add-to-space/add-to-space.component';
import { ManageSpaceRoomsComponent } from '../manage-space-rooms/manage-space-rooms.component';
import { SpaceMembersComponent } from '../space-members/space-members.component';
import { SpaceSettingsComponent } from '../space-settings/space-settings.component';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { MessageSearchService } from '../message-search/message-search.service';
import { JumpToDateService } from '../jump-to-date/jump-to-date.service';

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
          clientFor: () => clientStub(),
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
        MockProvider(JumpToDateService),
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
});
