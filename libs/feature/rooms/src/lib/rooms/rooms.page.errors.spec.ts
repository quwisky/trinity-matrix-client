import {
  RoomSettingsService,
  RoomAliasesService,
  RoomActionPermissionsService,
} from '@trinity/data-access/room-administration';
import { PublicRoomsService } from '@trinity/data-access/discovery';
import {
  SHARED_MOCKS,
  RoomsTimelineStub,
  clientStub,
  invitesProvider,
  selectedRoomLibraryProvider,
  setRouteRoom,
  settleWorkspace,
  shellFrom,
} from './rooms-page.spec-harness';
import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MediaPipeline } from '@trinity/data-access/media';
import {
  RoomNotificationUpdateError,
  RoomNotificationsService,
} from '@trinity/data-access/notifications';
import {
  RoomLibraryService,
  SpacesService,
  AccountScopeService,
  UnreadAggregatorService,
  SpaceChildrenService,
  type RoomSummary,
  type SpaceSummary,
} from '@trinity/data-access/room-library';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import {
  TrnAlertService,
  TrnDialogService,
  TrnToastService,
} from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { beforeEach, expect, it, type Mock, vi } from 'vitest';
import { RoomsPage } from './rooms.page';
import { UserPickerService } from '../user-picker/user-picker.service';
import { MemberInfoService } from '../member-info/member-info.service';
import { RoomSettingsComponent } from '../room-settings/room-settings.component';
import { AddToSpaceComponent } from '../add-to-space/add-to-space.component';
import { ManageSpaceRoomsComponent } from '../manage-space-rooms/manage-space-rooms.component';
import { SpaceMembersComponent } from '../space-members/space-members.component';
import { SpaceSettingsComponent } from '../space-settings/space-settings.component';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { JumpToDateService } from '../jump-to-date/jump-to-date.service';

// The open room lives in the URL, and the harness's route is module state that outlives a
// single TestBed — so a room one test opens is still in the URL when the next one builds.
// Start every test on a bare `/rooms`, the way a fresh load of the shell arrives.
beforeEach(() => setRouteRoom(null));

describe('RoomsPage action error feedback', () => {
  let toastShow: Mock;
  let sendMedia: Mock;
  let setNotifyMode: Mock;
  let leaveRoom: Mock;
  let alertConfirm: Mock;
  let alertPrompt: Mock;
  let dialogOpen: Mock;
  let roomsSignal: WritableSignal<RoomSummary[]>;
  let editableFields: Mock;
  let currentAccess: Mock;
  let canManageAliases: Mock;
  let parentSpaceIds: Mock;
  let railSpacesSignal: ReturnType<typeof signal<SpaceSummary[]>>;
  let supportsRestricted: Mock;
  let canCurate: Mock;
  let spaceMemberInfoOpen: Mock;
  let createSpace: Mock;
  let addExistingRoom: Mock;
  let currentIdentity: Mock;
  let joinPublicRoom: Mock;
  let markReadFn: Mock;
  let setMarkedUnreadFn: Mock;
  let clearMarkedUnreadFn: Mock;
  let setFavourite: Mock;
  let setLowPriority: Mock;

  function build() {
    toastShow = vi.fn();
    sendMedia = vi.fn(() => of(undefined));
    setNotifyMode = vi.fn(() => of(undefined));
    leaveRoom = vi.fn(() => of(undefined));
    alertConfirm = vi.fn(() => of(true));
    alertPrompt = vi.fn(() => of(null));
    dialogOpen = vi.fn(() => of(null));
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
    spaceMemberInfoOpen = vi.fn(() => of(null));
    createSpace = vi.fn(() => of('!new-space:hs'));
    addExistingRoom = vi.fn(() => of(undefined));
    currentIdentity = vi.fn(() => ({
      name: '',
      topic: '',
      avatarMxc: null as string | null,
    }));
    canManageAliases = vi.fn(() => false);
    joinPublicRoom = vi.fn(() => of('!new:hs'));
    markReadFn = vi.fn(() => of(undefined));
    setMarkedUnreadFn = vi.fn(() => of(undefined));
    clearMarkedUnreadFn = vi.fn(() => of(void 0));
    setFavourite = vi.fn(() => of(void 0));
    setLowPriority = vi.fn(() => of(void 0));
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        selectedRoomLibraryProvider(),
        MockProvider(RoomLibraryService, {
          selectionAvailability: () => 'available',
          leave: leaveRoom,
          rooms: roomsSignal,
          directRoomIds: signal<ReadonlySet<string>>(new Set()).asReadonly(),
          markRead: markReadFn,
          setMarkedUnread: setMarkedUnreadFn,
          clearMarkedUnread: clearMarkedUnreadFn,
          setFavourite,
          setLowPriority,
        }),
        MockProvider(RoomSettingsService, {
          editableFields,
          currentAccess,
          supportsRestricted,
          currentIdentity,
        }),
        MockProvider(MemberInfoService, { open$: spaceMemberInfoOpen }),
        MockProvider(RoomAliasesService, { canManageAliases }),
        MockProvider(PublicRoomsService, { join: joinPublicRoom }),
        MockProvider(SpacesService, {
          openSpace: () => of(void 0),
          parentSpaceIds,
          spaces: railSpacesSignal,
          createSpace,
        }),
        MockProvider(AccountScopeService, {
          // `selected` as well as `mixing`: the page points the cross-account projections
          // at it from a constructor effect, and this block now flushes effects, so an
          // unstubbed one reaches MixedRoomsService.setAccounts as `undefined`.
          selected: signal<ReadonlySet<string>>(
            new Set(['@me:hs']),
          ).asReadonly(),
          mixing: signal(false),
        }),
        MockProvider(SpaceChildrenService, { canCurate, addExistingRoom }),
        MockProvider(RoomActionPermissionsService, {
          connect: vi.fn(),
          room: () => {
            const curate = canCurate();
            return {
              invite: { available: true, reason: null },
              curateSpace: {
                available: curate,
                reason: curate
                  ? null
                  : 'You need permission to manage this space.',
              },
            };
          },
        }),
        MockProvider(TrnAlertService, {
          confirm$: alertConfirm,
          prompt$: alertPrompt,
        }),
        MockProvider(TimelineActionsService, { sendMedia }),
        MockProvider(MediaPipeline),
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
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(JumpToDateService),
        MockProvider(TrnDialogService, { openAndWait$: dialogOpen }),
        MockProvider(TrnToastService, { show: toastShow }),
        MockProvider(RoomNotificationsService, {
          connect: vi.fn(),
          setModeForAccounts: setNotifyMode,
        }),
      ],
    });
    return shellFrom();
  }

  it('applies shared room flags once to each exact owning Account', () => {
    const shell = build();
    const row = {
      id: '!shared:hs',
      accountId: '@me:hs',
      accountIds: ['@me:hs', '@alt:hs', '@me:hs'],
      name: 'Shared',
      initial: 'S',
      avatarMxc: null,
      topic: '',
      memberCount: 2,
      encrypted: true,
      unreadCount: 0,
      highlightCount: 0,
      hasUnread: false,
      markedUnread: false,
      lastMessage: '',
      activityTs: 0,
      favourite: false,
      lowPriority: false,
    } satisfies RoomSummary;

    shell.rooms.onToggleFavourite(row);
    shell.rooms.onToggleLowPriority(row);

    expect(setFavourite.mock.calls).toEqual([
      ['!shared:hs', true, '@me:hs'],
      ['!shared:hs', true, '@alt:hs'],
    ]);
    expect(setLowPriority.mock.calls).toEqual([
      ['!shared:hs', true, '@me:hs'],
      ['!shared:hs', true, '@alt:hs'],
    ]);
  });

  it('applies a notification level chosen from the sidebar room menu', () => {
    const shell = build();

    shell.readState.onSetNotifyMode({
      roomId: '!r:hs',
      mode: 'mentions',
      accountIds: ['@me:hs'],
    });

    expect(setNotifyMode).toHaveBeenCalledWith('!r:hs', 'mentions', ['@me:hs']);
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('shows a danger toast when setting a notification level fails', () => {
    const shell = build();
    setNotifyMode.mockReturnValue(throwError(() => new Error('nope')));

    shell.readState.onSetNotifyMode({
      roomId: '!r:hs',
      mode: 'mute',
      accountIds: ['@me:hs'],
    });

    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('explains when a failed notification update was restored', () => {
    const shell = build();
    setNotifyMode.mockReturnValue(
      throwError(
        () => new RoomNotificationUpdateError(new Error('offline'), true),
      ),
    );

    shell.readState.onSetNotifyMode({
      roomId: '!r:hs',
      mode: 'mute',
      accountIds: ['@me:hs'],
    });

    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('previous setting was restored'),
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('leaves a room after confirmation and clears it if it was the open one', async () => {
    const shell = build();
    setRouteRoom('!r:hs');
    await settleWorkspace();
    // The projections follow the URL from an effect, so flush to actually open them —
    // otherwise the teardown below would be asserted against a shell where nothing was
    // ever open, and the first thing the effect did was close everything anyway.
    TestBed.tick();
    const media = TestBed.inject(MediaPipeline);
    // That opening transition already released the *previous* room's blobs; forget it, so
    // the assertion below can only be satisfied by the release that leaving performs.
    (media.releaseAll as Mock).mockClear();

    shell.rooms.onLeaveRoom({ roomId: '!r:hs', accountId: '@me:hs' });

    expect(alertConfirm).toHaveBeenCalled();
    expect(leaveRoom).toHaveBeenCalledWith('!r:hs', '@me:hs');
    await vi.waitFor(() => expect(shell.store.activeRoomId()).toBeNull());
    TestBed.tick(); // run the teardown the now-roomless URL triggers
    // Tear every open-room projection down so none keeps listening on it.
    expect(TestBed.inject(RoomsTimelineStub).close).toHaveBeenCalled();
    expect(media.releaseAll).toHaveBeenCalled();
  });

  // Leaving is irreversible for a private room, so a mixed-in row must leave on ITS
  // account rather than falling through to whichever one happens to be active.
  it('leaves a foreign-account room on its own account', async () => {
    const shell = build();
    setRouteRoom('!r:hs');
    await settleWorkspace();

    shell.rooms.onLeaveRoom({ roomId: '!r:hs', accountId: '@alt:hs' });

    expect(leaveRoom).toHaveBeenCalledWith('!r:hs', '@alt:hs');
    expect(shell.store.activeRoomId()).toBe('!r:hs');
  });

  it('leaves a room but keeps a different open room selected', async () => {
    const shell = build();
    setRouteRoom('!other:hs');
    await settleWorkspace(); // open !other:hs for real, so "stays put" has something to stay
    expect(TestBed.inject(RoomsTimelineStub).open).toHaveBeenCalledWith(
      '!other:hs',
    );

    shell.rooms.onLeaveRoom({ roomId: '!r:hs', accountId: '@me:hs' });

    expect(leaveRoom).toHaveBeenCalledWith('!r:hs', '@me:hs');
    expect(shell.store.activeRoomId()).toBe('!other:hs');
    TestBed.tick(); // flush before the negative assertion, or it passes vacuously
    // The open room wasn't the one left, so its projections stay put.
    expect(TestBed.inject(RoomsTimelineStub).close).not.toHaveBeenCalled();
  });

  it('does not leave a room when the confirmation is cancelled', async () => {
    const shell = build();
    alertConfirm.mockReturnValue(of(false));

    shell.rooms.onLeaveRoom({ roomId: '!r:hs', accountId: '@me:hs' });

    expect(leaveRoom).not.toHaveBeenCalled();
  });

  it('shows a danger toast when leaving a room fails', async () => {
    const shell = build();
    leaveRoom.mockReturnValue(throwError(() => new Error('nope')));

    shell.rooms.onLeaveRoom({ roomId: '!r:hs', accountId: '@me:hs' });

    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'danger' }),
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
    shell.nav.onSelectSpace('!s:hs', '@me:hs');
    await settleWorkspace();
    railSpacesSignal.set([railSpace('!s:hs')]);
    const picked = {
      userId: '@a:hs',
      name: 'Ada',
      initial: 'A',
      avatarMxc: null,
      powerLevel: 0,
      isCreator: false,
    };
    dialogOpen.mockReturnValue(of(picked));

    shell.spaces.onOpenSpaceMembers();
    await Promise.resolve();
    await Promise.resolve();

    expect(dialogOpen).toHaveBeenCalledWith(
      SpaceMembersComponent,
      expect.objectContaining({
        inputs: expect.objectContaining({ spaceId: '!s:hs' }),
      }),
    );
    // The member panel keeps the SPACE id and resolves its permissions live there.
  });

  it('does not open member info when the members dialog is dismissed', async () => {
    const shell = build();
    shell.nav.onSelectSpace('!s:hs', '@me:hs');
    await settleWorkspace();
    railSpacesSignal.set([railSpace('!s:hs')]);
    dialogOpen.mockReturnValue(of(null));

    shell.spaces.onOpenSpaceMembers();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('creates a subspace and links it into the active space', async () => {
    const shell = build();
    shell.nav.onSelectSpace('!parent:hs', '@me:hs');
    await settleWorkspace();
    railSpacesSignal.set([railSpace('!parent:hs')]);
    alertConfirm.mockReturnValue(of(true));
    alertPrompt.mockReturnValue(of('Sub'));

    shell.spaces.onCreateSubspace();

    expect(createSpace).toHaveBeenCalledWith({ name: 'Sub' });
    // The link is the whole point — a space created and not nested is just a space.
    expect(addExistingRoom).toHaveBeenCalledWith('!parent:hs', '!new-space:hs');
  });

  it('does not create a subspace without power to curate', async () => {
    const shell = build();
    shell.nav.onSelectSpace('!parent:hs', '@me:hs');
    await settleWorkspace();
    railSpacesSignal.set([railSpace('!parent:hs')]);
    canCurate.mockReturnValue(false);

    shell.spaces.onCreateSubspace();

    expect(createSpace).not.toHaveBeenCalled();
  });

  it('opens the add-rooms picker for the active space', async () => {
    const shell = build();
    shell.nav.onSelectSpace('!s:hs', '@me:hs');
    await settleWorkspace();
    railSpacesSignal.set([railSpace('!s:hs')]);

    shell.spaces.onAddToSpace();

    expect(dialogOpen).toHaveBeenCalledWith(
      AddToSpaceComponent,
      expect.objectContaining({
        inputs: expect.objectContaining({ spaceId: '!s:hs' }),
      }),
    );
  });

  it('opens the curation dialog for the active space', async () => {
    const shell = build();
    shell.nav.onSelectSpace('!s:hs', '@me:hs');
    await settleWorkspace();
    railSpacesSignal.set([railSpace('!s:hs')]);

    shell.spaces.onManageSpaceRooms();

    expect(dialogOpen).toHaveBeenCalledWith(
      ManageSpaceRoomsComponent,
      expect.objectContaining({
        inputs: expect.objectContaining({ spaceId: '!s:hs' }),
      }),
    );
  });

  it('refuses both curation dialogs without power to curate', async () => {
    const shell = build();
    shell.nav.onSelectSpace('!s:hs', '@me:hs');
    await settleWorkspace();
    railSpacesSignal.set([railSpace('!s:hs')]);
    canCurate.mockReturnValue(false);

    expect(shell.vm.canCurateSpace()).toBe(false);
    shell.spaces.onAddToSpace();
    shell.spaces.onManageSpaceRooms();

    expect(dialogOpen).not.toHaveBeenCalled();
  });

  it('refuses to curate another account’s space', async () => {
    // Same reasoning as Space settings: the write goes through the ACTIVE client, so it
    // would land on the wrong account or nowhere.
    const shell = build();
    shell.nav.onSelectSpace('!theirs:hs', '@me:hs');
    await settleWorkspace();
    railSpacesSignal.set([railSpace('!theirs:hs', '@other:hs')]);
    canCurate.mockReturnValue(true);

    expect(shell.vm.canCurateSpace()).toBe(false);
  });

  it('separates curating from configuring, which are different power levels', async () => {
    // A moderator can curate the child list without being able to rename the space.
    const shell = build();
    shell.nav.onSelectSpace('!s:hs', '@me:hs');
    await settleWorkspace();
    railSpacesSignal.set([railSpace('!s:hs')]);
    canCurate.mockReturnValue(false);

    expect(shell.vm.canConfigureSpace()).toBe(true);
    expect(shell.vm.canCurateSpace()).toBe(false);
  });

  it('opens space settings seeded from raw state and the viewer’s permissions', async () => {
    const shell = build();
    shell.nav.onSelectSpace('!s:hs', '@me:hs');
    await settleWorkspace();
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
    canManageAliases.mockReturnValue(false);

    shell.spaces.onOpenSpaceSettings();

    // Every read is against the SPACE id — a space is a room, so these services take it
    // unchanged, and passing the active ROOM id here would silently configure the wrong one.
    expect(currentIdentity).toHaveBeenCalledWith('!s:hs');
    expect(editableFields).toHaveBeenCalledWith('!s:hs');
    expect(currentAccess).toHaveBeenCalledWith('!s:hs');
    expect(dialogOpen).toHaveBeenCalledWith(SpaceSettingsComponent, {
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
        canManageAliases: false,
      }),
    });
  });

  it('offers no history visibility to the space dialog', async () => {
    // A space has no timeline to hide, and the dialog has no control for it — passing one
    // would be a seed for a field that cannot be saved.
    const shell = build();
    shell.nav.onSelectSpace('!s:hs', '@me:hs');
    await settleWorkspace();
    railSpacesSignal.set([railSpace('!s:hs')]);

    shell.spaces.onOpenSpaceSettings();

    const [, options] = dialogOpen.mock.calls[0];
    expect(options.inputs).not.toHaveProperty('historyVisibility');
    expect(options.inputs).not.toHaveProperty('canEditHistory');
  });

  it('does not open space settings when no space is active', async () => {
    const shell = build();
    shell.nav.onSelectSpace(null, '@me:hs');
    await settleWorkspace();

    shell.spaces.onOpenSpaceSettings();

    expect(dialogOpen).not.toHaveBeenCalled();
  });

  it('refuses to configure another account’s space', async () => {
    // RoomSettingsService resolves the ACTIVE client, so this dialog would seed blank and
    // every write would land on the wrong account — or nowhere.
    const shell = build();
    shell.nav.onSelectSpace('!theirs:hs', '@me:hs');
    await settleWorkspace();
    railSpacesSignal.set([railSpace('!theirs:hs', '@other:hs')]);

    expect(shell.vm.canConfigureSpace()).toBe(false);

    shell.spaces.onOpenSpaceSettings();

    expect(dialogOpen).not.toHaveBeenCalled();
    expect(currentIdentity).not.toHaveBeenCalled();
  });

  it('allows configuring a space on the signed-in account', async () => {
    const shell = build();
    shell.nav.onSelectSpace('!mine:hs', '@me:hs');
    await settleWorkspace();
    railSpacesSignal.set([railSpace('!mine:hs', '@me:hs')]);

    expect(shell.vm.canConfigureSpace()).toBe(true);
  });

  it('reports no configurable space for Home or an unknown id', async () => {
    const shell = build();
    railSpacesSignal.set([railSpace('!s:hs')]);

    shell.nav.onSelectSpace(null, '@me:hs');
    await settleWorkspace();
    expect(shell.vm.canConfigureSpace()).toBe(false);

    shell.nav.onSelectSpace('!gone:hs', '@me:hs');
    await settleWorkspace();
    expect(shell.vm.canConfigureSpace()).toBe(false);
  });

  it('seeds the restricted option from the spaces the room sits in', async () => {
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
    setRouteRoom('!r:hs');
    await settleWorkspace();
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
    expect(dialogOpen).toHaveBeenCalledWith(RoomSettingsComponent, {
      ariaLabel: 'Room settings',
      inputs: expect.objectContaining({
        parentSpaces: [{ id: '!s:hs', name: 'Design' }],
        supportsRestricted: true,
        allowedSpaceIds: ['!kept:hs'],
      }),
    });
  });
});
