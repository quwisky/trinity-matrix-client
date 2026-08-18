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
import {
  ThreadsService,
  TimelineActionsService,
  TimelineService,
} from '@trinity/data-access/timeline';
import {
  TrnAlertService,
  TrnDialogService,
  TrnToastService,
} from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError } from 'rxjs';
import { expect, it, type Mock, vi } from 'vitest';
import { RoomsPage } from './rooms.page';
import { ThreadPanelService } from '../thread/thread-panel.service';
import { PinnedPanelService } from '../pinned/pinned-panel.service';
import { UserPickerService } from '../user-picker/user-picker.service';
import { MemberInfoService } from '../member-info/member-info.service';
import { RoomSettingsComponent } from '../room-settings/room-settings.component';
import { RoomDirectoryComponent } from '../room-directory/room-directory.component';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { MessageSearchService } from '../message-search/message-search.service';
import { JumpToDateService } from '../jump-to-date/jump-to-date.service';

describe('RoomsPage panels, pins and media', () => {
  let edit: Mock;
  let toastShow: Mock;
  let sendMedia: Mock;
  let setNotifyMode: Mock;
  let leaveRoom: Mock;
  let alertConfirm: Mock;
  let roomsSignal: WritableSignal<RoomSummary[]>;
  let editableFields: Mock;
  let currentAccess: Mock;
  let canManageBans: Mock;
  let canManageAliases: Mock;
  let parentSpaceIds: Mock;
  let railSpacesSignal: ReturnType<typeof signal<SpaceSummary[]>>;
  let supportsRestricted: Mock;
  let canCurate: Mock;
  let spaceCanModerate: Mock;
  let spaceMemberInfoOpen: Mock;
  let createSpace: Mock;
  let addExistingRoom: Mock;
  let currentIdentity: Mock;
  let joinPublicRoom: Mock;
  let markReadFn: Mock;
  let setMarkedUnreadFn: Mock;
  let clearMarkedUnreadFn: Mock;

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
        MockProvider(TimelineService),
        MockProvider(TimelineActionsService, { edit, sendMedia }),
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
        lowPriority: false,
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
      lowPriority: false,
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
      lowPriority: false,
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
      lowPriority: false,
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

  it('jumpToDate scrolls to the event the date resolved to', async () => {
    const shell = build();
    shell.store.activeRoomId.set('!a:hs'); // jumpToDate is a no-op with no room open
    const picker = TestBed.inject(JumpToDateService);
    const timeline = TestBed.inject(TimelineService);
    vi.mocked(picker.pick).mockResolvedValue(1_700_000_000_000);
    vi.mocked(timeline.jumpToDate).mockReturnValue(
      of({ kind: 'found', eventId: '$day:hs' }),
    );

    await shell.messages.jumpToDate();

    expect(timeline.jumpToDate).toHaveBeenCalledWith(1_700_000_000_000);
    // Reuses the one definition of "scroll the list to this event".
    expect(shell.store.messageSearchTarget()).toBe('$day:hs');
    expect(shell.store.jumpRequest()).toBe(1);
  });

  it('jumpToDate does nothing at all when the picker is cancelled', async () => {
    const shell = build();
    shell.store.activeRoomId.set('!a:hs');
    const picker = TestBed.inject(JumpToDateService);
    const timeline = TestBed.inject(TimelineService);
    vi.mocked(picker.pick).mockResolvedValue(null);

    await shell.messages.jumpToDate();

    expect(timeline.jumpToDate).not.toHaveBeenCalled();
    expect(shell.store.jumpRequest()).toBe(0);
  });

  it('jumpToDate says something different for each way it can fail', async () => {
    // Collapsing these into one message would send someone hunting for a problem that is
    // not theirs: "too far back" is fixable by scrolling, "no messages" is a fact about
    // the room, and "unsupported" is their homeserver.
    const cases = [
      ['too-far', /further back/i],
      ['no-event', /No messages/i],
      ['unsupported', /homeserver/i],
    ] as const;

    for (const [kind, expected] of cases) {
      TestBed.resetTestingModule();
      const shell = build();
      shell.store.activeRoomId.set('!a:hs');
      const picker = TestBed.inject(JumpToDateService);
      const timeline = TestBed.inject(TimelineService);
      vi.mocked(picker.pick).mockResolvedValue(1_700_000_000_000);
      vi.mocked(timeline.jumpToDate).mockReturnValue(of({ kind }));

      await shell.messages.jumpToDate();

      expect(toastShow, kind).toHaveBeenCalledWith(
        expect.stringMatching(expected),
        expect.objectContaining({ variant: 'destructive' }),
      );
      // And it must NOT pretend the jump happened.
      expect(shell.store.jumpRequest(), kind).toBe(0);
    }
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
