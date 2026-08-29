import {
  SHARED_MOCKS,
  RoomsTimelineStub,
  clientStub,
  flushPanelJump,
  invitesProvider,
  setRouteRoom,
  shellFrom,
} from './rooms-page.spec-harness';
import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MediaService } from '@trinity/data-access/media';
import { RoomNotificationsService } from '@trinity/data-access/notifications';
import { PinnedMessagesService } from '@trinity/data-access/pinned';
import {
  RoomsService,
  RoomSettingsService,
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
import { UserPickerService } from '../user-picker/user-picker.service';
import { MemberInfoService } from '../member-info/member-info.service';
import { RoomSettingsComponent } from '../room-settings/room-settings.component';
import { RoomDirectoryComponent } from '../room-directory/room-directory.component';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { JumpToDateService } from '../jump-to-date/jump-to-date.service';

// The open room is the URL now, and the route the store reads outlives any one TestBed —
// it is one stream in the harness, shared by every test in this file. Without this reset a
// test that opens a room hands it to the next one, where "no room is open" then silently
// asserts against the previous test's room.
beforeEach(() => setRouteRoom(null));

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
    spaceMemberInfoOpen = vi.fn().mockResolvedValue(null);
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
        MockProvider(MemberInfoService, { open: spaceMemberInfoOpen }),
        MockProvider(RoomAliasesService, { canManageAliases }),
        MockProvider(PublicRoomsService, { join: joinPublicRoom }),
        MockProvider(SpacesService, {
          parentSpaceIds,
          spaces: railSpacesSignal,
          createSpace,
        }),
        // `selected` as well as `mixing`: the page's cross-account effect reads it and
        // hands the result to `MixedRoomsService.setAccounts`, which dereferences `.size`.
        // ng-mocks does not invent signal members, so an unstubbed one arrives as
        // `undefined` — invisible until something in this file actually flushes effects.
        MockProvider(AccountScopeService, {
          mixing: signal(false),
          selected: signal(new Set(['@me:hs'])),
        }),
        MockProvider(SpaceChildrenService, { canCurate, addExistingRoom }),
        MockProvider(TrnAlertService, { confirm: alertConfirm }),
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
        MockProvider(JumpToDateService),
        MockProvider(AccountRuntimeService),
        MockProvider(TrnDialogService),
        MockProvider(TrnToastService, { show: toastShow }),
        MockProvider(RoomNotificationsService, {
          connect: vi.fn(),
          setModeForAccounts: setNotifyMode,
        }),
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
    setRouteRoom('!r:hs'); // the open room comes from /rooms/:roomId now
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
    // The clear is wired to the room BECOMING OPEN rather than to the focus-gated ack, so
    // every opener goes through it — a permalink hop included, and equally a notification
    // tap or a pasted link, neither of which calls `onSelectRoom` at all.
    //
    // Flushed between the two: opening is a navigation now, and two navigations issued in
    // one tick coalesce in the real router as well, so a room that was never actually
    // shown is not a room that was opened.
    const shell = build();

    shell.nav.onSelectRoom('!r:hs');
    TestBed.tick();
    shell.nav.onSelectRoom('!h:hs', 'hop');
    TestBed.tick();

    expect(clearMarkedUnreadFn).toHaveBeenCalledWith('!r:hs');
    expect(clearMarkedUnreadFn).toHaveBeenCalledWith('!h:hs');
  });

  // The half `onSelectRoom` cannot cover, and the reason the clear moved: these arrive as
  // a URL change with no call into the shell at all.
  it('clears the flag for a room opened by URL alone', () => {
    const shell = build();

    setRouteRoom('!tapped:hs');
    TestBed.tick();

    expect(shell.store.activeRoomId()).toBe('!tapped:hs');
    expect(clearMarkedUnreadFn).toHaveBeenCalledWith('!tapped:hs');
  });

  it('applies a notification level on every account joined to a merged row', () => {
    const shell = build();

    shell.readState.onSetNotifyMode({
      roomId: '!r:hs',
      mode: 'mute',
      accountIds: ['@me:hs', '@alt:hs'],
    });

    expect(setNotifyMode).toHaveBeenCalledWith('!r:hs', 'mute', [
      '@me:hs',
      '@alt:hs',
    ]);
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
    setRouteRoom('!r:hs');

    shell.messages.openThreadsList();

    // The slot itself, not a spy on a service that no longer exists: the shell's one
    // right-hand slot IS the presentation now, so this is what the user sees. Asserting a
    // call would still pass if the value never reached the layout.
    expect(shell.store.rightPanel()).toEqual({ kind: 'threads' });
  });

  it('does not open the threads-list panel without an active room', () => {
    const shell = build();
    setRouteRoom(null);
    // Whatever the slot was showing before the press (the member list, seeded at this
    // width). Identity, so "opened threads" and "re-opened members" both fail: nothing at
    // all may be written when there is no room for the list to be about.
    const before = shell.store.rightPanel();

    shell.messages.openThreadsList();

    expect(shell.store.rightPanel()).toBe(before);
  });

  it('drops a room-scoped panel when the open room changes', () => {
    // Four of the six surfaces are ABOUT a room — a thread root, a pinned/search hit, a
    // member from their room — while the template binds each of
    // them to the room that is open NOW. Left to persist across a switch they describe one
    // room beside another room's timeline. Back to what this width shows by default.
    const shell = build();
    setRouteRoom('!a:hs');
    shell.messages.onOpenThread('$root');
    expect(shell.store.rightPanel()).toEqual({
      kind: 'thread',
      rootEventId: '$root',
    });

    setRouteRoom('!b:hs');

    expect(shell.store.rightPanel()).toEqual({ kind: 'members' });
  });

  it('carries the roster — and a closed slot — across a room change', () => {
    // The other half, and why this is not just `set(null)` on every switch: whether the
    // member column is up is a preference the user owns, and the list re-projects itself
    // onto the new room. Closing it and switching rooms must not reopen it.
    const shell = build();
    setRouteRoom('!a:hs');
    shell.page.closeRightPanel();

    setRouteRoom('!b:hs');
    expect(shell.store.rightPanel()).toBeNull();

    shell.store.rightPanel.set({ kind: 'members' });
    setRouteRoom('!c:hs');
    expect(shell.store.rightPanel()).toEqual({ kind: 'members' });
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

  it('openPinnedPanel jumps the timeline to the chosen pinned message', () => {
    // Two steps rather than one awaited dialog result: the panel goes into the slot, and a
    // picked row comes back through `onPanelJump` — which is what the template binds the
    // panel's (selected) output to.
    const shell = build();

    shell.messages.openPinnedPanel();
    expect(shell.store.rightPanel()).toEqual({ kind: 'pinned' });

    shell.messages.onPanelJump('$evt:hs');

    flushPanelJump();

    expect(shell.store.messageSearchTarget()).toBe('$evt:hs');
    expect(shell.store.jumpRequest()).toBe(1);
    // And the slot closes, exactly as the dialog it replaced did. Below the `members`
    // breakpoint the slot is a full-width drawer over the timeline, so jumping with it open
    // scrolls to a message the user cannot see — `pin-messages.spec.mts` pins this in a real
    // browser and caught it when this briefly stayed open.
    expect(shell.store.rightPanel()).toBeNull();
  });

  it('jumpToDate scrolls to the event the date resolved to', async () => {
    const shell = build();
    setRouteRoom('!a:hs'); // jumpToDate is a no-op with no room open
    const picker = TestBed.inject(JumpToDateService);
    const timeline = TestBed.inject(RoomsTimelineStub);
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
    setRouteRoom('!a:hs');
    const picker = TestBed.inject(JumpToDateService);
    const timeline = TestBed.inject(RoomsTimelineStub);
    vi.mocked(picker.pick).mockResolvedValue(null);
    vi.mocked(timeline.jumpToDate).mockClear();

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
      setRouteRoom('!a:hs');
      const picker = TestBed.inject(JumpToDateService);
      const timeline = TestBed.inject(RoomsTimelineStub);
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

  it('openPinnedPanel bumps jumpRequest again when the SAME message is re-picked', () => {
    // The bug: re-selecting the same pinned row must still re-trigger a jump —
    // messageSearchTarget alone is a no-op signal write (Object.is), so the list
    // only re-fires because jumpRequest keeps incrementing. Re-picking is cheaper to do
    // now than it was against a dialog, not rarer: the panel never closed.
    const shell = build();
    shell.messages.openPinnedPanel();

    shell.messages.onPanelJump('$evt:hs');

    flushPanelJump();
    expect(shell.store.jumpRequest()).toBe(1);

    shell.messages.onPanelJump('$evt:hs');

    flushPanelJump();

    expect(shell.store.messageSearchTarget()).toBe('$evt:hs');
    expect(shell.store.jumpRequest()).toBe(2);
  });

  it('openPinnedPanel does not jump when the panel is dismissed without a pick', () => {
    // "Cancelled" is a dismissal now — the panel's (dismissed) output, which the page
    // handles by emptying the slot. Opening and closing it must leave the timeline exactly
    // where it was: no target, no bump.
    const shell = build();
    shell.messages.openPinnedPanel();

    shell.page.closeRightPanel();

    expect(shell.store.rightPanel()).toBeNull();
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

    const outcomes: unknown[] = [];
    shell.messages.onSendMedia({
      items: [{ id: 'a', file: pngFile() }],
      caption: '',
      onOutcomes: (result) => outcomes.push(...result),
    });
    // Which file of how many, not a bare fraction — a send is a batch now.
    expect(shell.messages.uploadProgress()).toEqual({
      index: 1,
      total: 1,
      fraction: 0,
    });

    progressCb?.(0.5);
    expect(shell.messages.uploadProgress()?.fraction).toBe(0.5);

    stream.next();
    stream.complete();
    expect(shell.messages.uploadProgress()).toBeNull(); // cleared when the batch ends
    expect(outcomes).toEqual([{ id: 'a', failed: false }]);
    expect(toastShow).not.toHaveBeenCalled(); // no error toast
  });

  it('ignores stale progress and cleanup from an older room batch', () => {
    const shell = build();
    const streams = [new Subject<void>(), new Subject<void>()] as const;
    const reports: (((fraction: number) => void) | undefined)[] = [];
    let streamIndex = 0;
    sendMedia.mockImplementation(
      (_file: File, _caption: string, report?: (fraction: number) => void) => {
        reports.push(report);
        return streams[streamIndex++]?.asObservable() ?? of(undefined);
      },
    );

    shell.messages.onSendMedia({
      items: [{ id: 'old', file: pngFile() }],
      caption: '',
      onOutcomes: () => undefined,
    });
    shell.messages.onSendMedia({
      items: [{ id: 'new', file: pngFile() }],
      caption: '',
      onOutcomes: () => undefined,
    });
    reports[1]?.(0.6);
    expect(shell.messages.uploadProgress()?.fraction).toBe(0.6);

    reports[0]?.(0.9);
    expect(shell.messages.uploadProgress()?.fraction).toBe(0.6);

    streams[0].next();
    streams[0].complete();
    expect(shell.messages.uploadProgress()?.fraction).toBe(0.6);

    reports[1]?.(0.75);
    expect(shell.messages.uploadProgress()?.fraction).toBe(0.75);
    streams[1].next();
    streams[1].complete();
    expect(shell.messages.uploadProgress()).toBeNull();

    reports[1]?.(0.95);
    expect(shell.messages.uploadProgress()).toBeNull();
  });

  it('hands a single file its caption, and a batch none', () => {
    // Every other host fixture sends `caption: ''`, so nothing checked that the caption
    // survives the host at all — and a caption swallowed here is destroyed outright, since
    // the composer emptied the box at dispatch and only restores it when NOTHING landed.
    const shell = build();
    sendMedia.mockReturnValue(of(undefined));

    shell.messages.onSendMedia({
      items: [{ id: 'a', file: pngFile() }],
      caption: "here's the receipt",
      onOutcomes: () => undefined,
    });
    expect(sendMedia.mock.calls[0]?.[1]).toBe("here's the receipt");

    sendMedia.mockClear();
    shell.messages.onSendMedia({
      items: [
        { id: 'a', file: pngFile() },
        { id: 'b', file: pngFile() },
      ],
      caption: 'both of these',
      onOutcomes: () => undefined,
    });
    // A batch caption has no file to belong to; the composer posts it as its own message.
    expect(sendMedia.mock.calls.map((call) => call[1])).toEqual(['', '']);
  });

  it('reports outcomes even when every send completes synchronously', () => {
    // What `TimelineActionsService.sendMedia` returns for a 0-byte file or a closed room
    // context: `of(void 0)`, completing inside the subscribe — so `uploadProgress` goes
    // non-null and back before anything downstream can observe it. `onOutcomes` is what
    // releases the composer's send latch, and it has to arrive on this path too, or the
    // composer is left unable to send anything for the rest of the room.
    const shell = build();
    sendMedia.mockReturnValue(of(undefined));
    let outcomes: readonly { id: string; failed: boolean }[] | null = null;

    shell.messages.onSendMedia({
      items: [{ id: 'a', file: pngFile() }],
      caption: '',
      onOutcomes: (result) => (outcomes = result),
    });

    expect(outcomes).toEqual([{ id: 'a', failed: false }]);
    expect(shell.messages.uploadProgress()).toBeNull();
  });

  it('tells apart an upload that failed from one abandoned by leaving the room', () => {
    // Both happen in the same batch, and they have different remedies: one file is still in
    // the composer to retry, the other is gone with the staging the room change cleared.
    const shell = build();
    const timeline = TestBed.inject(RoomsTimelineStub);
    timeline.openRoomId = '!first:hs';
    let sent = 0;
    sendMedia.mockImplementation(() => {
      sent++;
      if (sent === 1) {
        return throwError(() => new Error('upload failed')); // a genuine failure
      }
      timeline.openRoomId = '!second:hs';
      return of(undefined);
    });

    shell.messages.onSendMedia({
      items: [
        { id: 'a', file: pngFile() },
        { id: 'b', file: pngFile() },
        { id: 'c', file: pngFile() },
        { id: 'd', file: pngFile() },
      ],
      caption: '',
      onOutcomes: () => undefined,
    });

    const message = String(toastShow.mock.calls[0]?.[0] ?? '');
    // Asymmetric on purpose: with one of each, "failed" and "failed - abandoned" read the
    // same, and the split that exists to keep them apart could be deleted unnoticed.
    expect(message).toMatch(/2 attachments not sent — you left the room/);
    expect(message).toMatch(/1 could not be uploaded/);
  });

  it('does not mention an upload failure when the batch was only abandoned', () => {
    const shell = build();
    const timeline = TestBed.inject(RoomsTimelineStub);
    timeline.openRoomId = '!first:hs';
    sendMedia.mockImplementation(() => {
      timeline.openRoomId = '!second:hs';
      return of(undefined);
    });

    shell.messages.onSendMedia({
      items: [
        { id: 'a', file: pngFile() },
        { id: 'b', file: pngFile() },
      ],
      caption: '',
      onOutcomes: () => undefined,
    });

    expect(String(toastShow.mock.calls[0]?.[0] ?? '')).not.toContain(
      'could not be uploaded',
    );
  });

  it('abandons the rest of a batch when the room changes under it, and says so', () => {
    // `sendMedia` resolves the open room on SUBSCRIBE, and a batch subscribes its Nth item
    // long after the press. This service belongs to the page and survives a room switch, so
    // without the pin the remaining files would be delivered into whatever room is open now.
    const shell = build();
    const timeline = TestBed.inject(RoomsTimelineStub);
    timeline.openRoomId = '!first:hs';
    sendMedia.mockImplementation(() => {
      timeline.openRoomId = '!second:hs';
      return of(undefined); // the first file goes out, then the user navigates
    });

    let outcomes: readonly { id: string; failed: boolean }[] = [];
    shell.messages.onSendMedia({
      items: [
        { id: 'a', file: pngFile() },
        { id: 'b', file: pngFile() },
      ],
      caption: '',
      onOutcomes: (result) => (outcomes = result),
    });

    expect(sendMedia).toHaveBeenCalledTimes(1); // the second was never attempted
    expect(outcomes).toEqual([
      { id: 'a', failed: false },
      { id: 'b', failed: true },
    ]);
    // Not "still in the composer" — the composer drops its staging on a room change, so
    // that wording would send the user looking for a file that is not there.
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('you left the room'),
      expect.anything(),
    );
  });

  it('clears uploadProgress and toasts when a media send fails', () => {
    const shell = build();
    const stream = new Subject<void>();
    sendMedia.mockReturnValue(stream.asObservable());

    const outcomes: { id: string; failed: boolean }[] = [];
    shell.messages.onSendMedia({
      items: [{ id: 'a', file: pngFile() }],
      caption: '',
      onOutcomes: (result) => outcomes.push(...result),
    });
    expect(shell.messages.uploadProgress()?.index).toBe(1);

    stream.error(new Error('upload failed'));

    expect(shell.messages.uploadProgress()).toBeNull(); // cleared when the batch ends
    // Reported per item rather than thrown, so the composer can keep it staged for a retry.
    expect(outcomes).toEqual([{ id: 'a', failed: true }]);
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });
});
