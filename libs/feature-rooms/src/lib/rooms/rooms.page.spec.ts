import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  AuthService,
  CryptoService,
  InvitesService,
  MatrixClientService,
  MediaService,
  PinnedMessagesService,
  RoomsService,
  SpacesService,
  ThreadsService,
  TimelineService,
  type PendingInvite,
  type RoomSummary,
  type SpaceChildRoom,
  type SpaceSummary,
} from '@trinity/core';
import {
  TrnActionSheetService,
  TrnAlertService,
  TrnDialogService,
  TrnToastService,
} from '@trinity/helm/overlay';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RoomsPage } from './rooms.page';
import { ThreadPanelService } from '../thread/thread-panel.service';
import { PinnedPanelService } from '../pinned/pinned-panel.service';
import { UserPickerService } from '../user-picker/user-picker.service';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { MessageSearchService } from '../message-search/message-search.service';

/** Default InvitesService mock: empty model + join/leave stubs. */
function invitesProvider(over: Partial<Record<string, unknown>> = {}) {
  return {
    provide: InvitesService,
    useValue: {
      connect: vi.fn(),
      disconnect: vi.fn(),
      pendingInvites: signal<PendingInvite[]>([]),
      acceptInvite: vi.fn(() => of(undefined)),
      declineInvite: vi.fn(() => of(undefined)),
      ...over,
    },
  };
}

// Instantiate the page through DI without rendering (the shell template pulls in
// many child components); we only exercise the action handlers' error feedback.
describe('RoomsPage action error feedback', () => {
  let edit: ReturnType<typeof vi.fn>;
  let toastShow: ReturnType<typeof vi.fn>;
  let sendMedia: ReturnType<typeof vi.fn>;

  function build(): RoomsPage {
    toastShow = vi.fn();
    edit = vi.fn();
    sendMedia = vi.fn(() => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        { provide: RoomsService, useValue: { connect: vi.fn() } },
        {
          provide: SpacesService,
          useValue: { connect: vi.fn(), openSpace: vi.fn() },
        },
        {
          provide: TimelineService,
          useValue: {
            edit,
            sendMedia,
            redact: vi.fn(() => of(undefined)),
            toggleReaction: vi.fn(() => of(undefined)),
            reply: vi.fn(() => of(undefined)),
            close: vi.fn(),
          },
        },
        {
          provide: MatrixClientService,
          useValue: {
            isInitialized: true,
            instance: { getUserId: () => '@me:hs' },
          },
        },
        {
          provide: CryptoService,
          useValue: { connect: vi.fn(), status: signal('ready') },
        },
        {
          provide: ThreadsService,
          useValue: {
            open: vi.fn(),
            close: vi.fn(),
            closeThread: vi.fn(),
            summaries: signal({}),
          },
        },
        {
          provide: ThreadPanelService,
          useValue: { open: vi.fn(), openList: vi.fn() },
        },
        {
          provide: PinnedMessagesService,
          useValue: {
            open: vi.fn(),
            close: vi.fn(),
            isPinned: vi.fn(() => false),
            pin: vi.fn(),
            unpin: vi.fn(),
            canPin: signal(false),
            pinnedEventIds: signal<string[]>([]),
            pinnedMessages: signal([]),
          },
        },
        {
          provide: PinnedPanelService,
          useValue: { openPanel: vi.fn(async () => null) },
        },
        invitesProvider(),
        { provide: UserPickerService, useValue: { pick: vi.fn() } },
        { provide: QuickSwitcherService, useValue: { pick: vi.fn() } },
        { provide: MessageSearchService, useValue: { search: vi.fn() } },
        { provide: TrnActionSheetService, useValue: { open: vi.fn() } },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: TrnDialogService, useValue: { hasOpen: () => false } },
        { provide: TrnToastService, useValue: { show: toastShow } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  it('shows a danger toast when an edit fails', () => {
    const page = build();
    edit.mockReturnValue(throwError(() => new Error('nope')));

    page.onEdit({ id: '$1', body: 'x' });

    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('does not toast when the action succeeds', () => {
    const page = build();
    edit.mockReturnValue(of(undefined));

    page.onEdit({ id: '$1', body: 'x' });

    expect(toastShow).not.toHaveBeenCalled();
  });

  it('onSetFavourite favourites a room by delegating to RoomsService.setFavourite', () => {
    const page = build();
    const rooms = TestBed.inject(RoomsService);
    const setFavourite = vi.fn();
    (rooms as unknown as { setFavourite: typeof setFavourite }).setFavourite =
      setFavourite;

    page.onSetFavourite({ id: '!r:hs', favourite: true });

    expect(setFavourite).toHaveBeenCalledWith('!r:hs', true);
  });

  it('onSetFavourite unfavourites a room by delegating to RoomsService.setFavourite', () => {
    const page = build();
    const rooms = TestBed.inject(RoomsService);
    const setFavourite = vi.fn();
    (rooms as unknown as { setFavourite: typeof setFavourite }).setFavourite =
      setFavourite;

    page.onSetFavourite({ id: '!r:hs', favourite: false });

    expect(setFavourite).toHaveBeenCalledWith('!r:hs', false);
  });

  it('opens the threads-list panel for the active room', () => {
    const page = build();
    page.activeRoomId.set('!r:hs');
    const panel = TestBed.inject(ThreadPanelService);

    page.openThreadsList();

    expect(panel.openList).toHaveBeenCalledWith('!r:hs');
  });

  it('does not open the threads-list panel without an active room', () => {
    const page = build();
    page.activeRoomId.set(null);
    const panel = TestBed.inject(ThreadPanelService);

    page.openThreadsList();

    expect(panel.openList).not.toHaveBeenCalled();
  });

  it('onTogglePin pins an unpinned message', () => {
    const page = build();
    const pinned = TestBed.inject(PinnedMessagesService);
    (pinned.isPinned as ReturnType<typeof vi.fn>).mockReturnValue(false);

    page.onTogglePin('$1');

    expect(pinned.pin).toHaveBeenCalledWith('$1');
    expect(pinned.unpin).not.toHaveBeenCalled();
  });

  it('onTogglePin unpins an already-pinned message', () => {
    const page = build();
    const pinned = TestBed.inject(PinnedMessagesService);
    (pinned.isPinned as ReturnType<typeof vi.fn>).mockReturnValue(true);

    page.onTogglePin('$1');

    expect(pinned.unpin).toHaveBeenCalledWith('$1');
    expect(pinned.pin).not.toHaveBeenCalled();
  });

  it('openPinnedPanel jumps the timeline to the chosen pinned message', async () => {
    const page = build();
    const panel = TestBed.inject(PinnedPanelService);
    (panel.openPanel as ReturnType<typeof vi.fn>).mockResolvedValue('$evt:hs');

    await page.openPinnedPanel();

    expect(panel.openPanel).toHaveBeenCalled();
    expect(page.messageSearchTarget()).toBe('$evt:hs');
    expect(page.jumpRequest()).toBe(1);
  });

  it('openPinnedPanel bumps jumpRequest again when the SAME message is re-picked', async () => {
    // The bug: re-selecting the same pinned row must still re-trigger a jump —
    // messageSearchTarget alone is a no-op signal write (Object.is), so the list
    // only re-fires because jumpRequest keeps incrementing.
    const page = build();
    const panel = TestBed.inject(PinnedPanelService);
    (panel.openPanel as ReturnType<typeof vi.fn>).mockResolvedValue('$evt:hs');

    await page.openPinnedPanel();
    expect(page.jumpRequest()).toBe(1);

    await page.openPinnedPanel();

    expect(page.messageSearchTarget()).toBe('$evt:hs');
    expect(page.jumpRequest()).toBe(2);
  });

  it('openPinnedPanel does not jump when the panel is cancelled', async () => {
    const page = build();
    const panel = TestBed.inject(PinnedPanelService);
    (panel.openPanel as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await page.openPinnedPanel();

    expect(page.messageSearchTarget()).toBeNull();
    expect(page.jumpRequest()).toBe(0);
  });

  const pngFile = () =>
    new File([new Uint8Array([1])], 'pic.png', { type: 'image/png' });

  it('drives uploadProgress 0 → fraction → null over a successful media send', () => {
    const page = build(); // build() (re)creates the sendMedia mock — set it after
    const stream = new Subject<void>();
    let progressCb: ((fraction: number) => void) | undefined;
    sendMedia.mockImplementation(
      (_file: File, _caption: string, cb?: (fraction: number) => void) => {
        progressCb = cb;
        return stream.asObservable();
      },
    );

    page.onSendMedia({ file: pngFile(), caption: '' });
    expect(page.uploadProgress()).toBe(0); // reset to 0 on start

    progressCb?.(0.5);
    expect(page.uploadProgress()).toBe(0.5); // tracks the upload fraction

    stream.complete();
    expect(page.uploadProgress()).toBeNull(); // cleared by finalize on success
    expect(toastShow).not.toHaveBeenCalled(); // no error toast
  });

  it('clears uploadProgress and toasts when a media send fails', () => {
    const page = build();
    const stream = new Subject<void>();
    sendMedia.mockReturnValue(stream.asObservable());

    page.onSendMedia({ file: pngFile(), caption: '' });
    expect(page.uploadProgress()).toBe(0);

    stream.error(new Error('upload failed'));

    expect(page.uploadProgress()).toBeNull(); // finalize clears on error too
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
      name,
      initial: name[0].toUpperCase(),
      avatarMxc: null,
      topic: '',
      memberCount: 0,
      encrypted: false,
      unreadCount: unread,
      highlightCount: 0,
      hasUnread: unread > 0,
      lastMessage: '',
      activityTs: 0,
      favourite: false,
    };
  }

  function spaceSummary(id: string, childRoomIds: string[]): SpaceSummary {
    return { id, name: id, initial: 'S', avatarMxc: null, childRoomIds };
  }

  function build(): RoomsPage {
    // Home recency order is c, a, b; the space orders its children a, b.
    const rooms = [
      roomSummary('!c:hs', 'charlie', 2),
      roomSummary('!a:hs', 'alpha', 5),
      roomSummary('!b:hs', 'bravo', 3),
    ];
    const childRoomIds = vi.fn((id: string | null) =>
      id === '!s:hs' ? ['!a:hs', '!b:hs'] : [],
    );
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        {
          provide: RoomsService,
          useValue: {
            connect: vi.fn(),
            rooms: signal(rooms),
            directRoomIds: signal(new Set(['!a:hs'])), // '!a:hs' is a DM
            revision: signal(0),
            membersOf: () => [],
          },
        },
        {
          provide: SpacesService,
          useValue: {
            connect: vi.fn(),
            openSpace: vi.fn(),
            spaces: signal([spaceSummary('!s:hs', ['!a:hs', '!b:hs'])]),
            childRoomIds,
          },
        },
        { provide: TimelineService, useValue: { close: vi.fn() } },
        {
          provide: MatrixClientService,
          useValue: {
            isInitialized: true,
            instance: { getUserId: () => '@me:hs', getUser: () => null },
          },
        },
        { provide: CryptoService, useValue: { connect: vi.fn() } },
        {
          provide: ThreadsService,
          useValue: { close: vi.fn(), closeThread: vi.fn() },
        },
        {
          provide: ThreadPanelService,
          useValue: { open: vi.fn(), openList: vi.fn() },
        },
        {
          provide: PinnedMessagesService,
          useValue: {
            open: vi.fn(),
            close: vi.fn(),
            isPinned: vi.fn(() => false),
            pin: vi.fn(),
            unpin: vi.fn(),
            canPin: signal(false),
            pinnedEventIds: signal<string[]>([]),
            pinnedMessages: signal([]),
          },
        },
        {
          provide: PinnedPanelService,
          useValue: { openPanel: vi.fn(async () => null) },
        },
        invitesProvider(),
        { provide: UserPickerService, useValue: { pick: vi.fn() } },
        { provide: QuickSwitcherService, useValue: { pick: vi.fn() } },
        { provide: MessageSearchService, useValue: { search: vi.fn() } },
        { provide: TrnActionSheetService, useValue: { open: vi.fn() } },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: TrnDialogService, useValue: { hasOpen: () => false } },
        { provide: TrnToastService, useValue: { show: vi.fn() } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  it('Home (no space) shows only direct messages', () => {
    const page = build();
    page.activeSpaceId.set(null);

    // Only '!a:hs' is a DM (see directRoomIds in build()).
    expect(page.visibleRooms().map((r) => r.id)).toEqual(['!a:hs']);
    expect(page.sidebarTitle()).toBe('Direct Messages');
  });

  it('a selected space shows only its joined children, in space order', () => {
    const page = build();
    page.activeSpaceId.set('!s:hs');

    // '!c:hs' is excluded (not a child); a/b appear in the space's order.
    expect(page.visibleRooms().map((r) => r.id)).toEqual(['!a:hs', '!b:hs']);
    expect(page.activeSpaceName()).toBe('!s:hs');
  });

  it('the Rooms view shows non-DM rooms that do not belong to a space', () => {
    const page = build();
    page.onShowRooms();

    expect(page.roomsView()).toBe(true);
    // Only the spaceless non-DM room '!c:hs': the DM '!a:hs' and the space child
    // '!b:hs' (owned by '!s:hs') are both excluded.
    expect(page.visibleRooms().map((r) => r.id)).toEqual(['!c:hs']);
    expect(page.sidebarTitle()).toBe('Rooms');
  });

  it('showing Rooms clears the active space', () => {
    const page = build();
    page.activeSpaceId.set('!s:hs'); // a space is selected…
    page.onShowRooms(); // …switching to Rooms leaves it

    expect(page.activeSpaceId()).toBeNull();
    expect(page.visibleRooms().map((r) => r.id)).toEqual(['!c:hs']);
  });

  it('selecting a space leaves the Rooms view', () => {
    const page = build();
    page.onShowRooms();
    expect(page.roomsView()).toBe(true);

    page.onSelectSpace('!s:hs');
    expect(page.roomsView()).toBe(false);
    expect(page.visibleRooms().map((r) => r.id)).toEqual(['!a:hs', '!b:hs']);
    expect(page.sidebarTitle()).toBe('!s:hs');
  });

  it('Home returns to direct messages from the Rooms view', () => {
    const page = build();
    page.onShowRooms();
    expect(page.roomsView()).toBe(true);

    page.onSelectSpace(null); // clicking Home
    expect(page.roomsView()).toBe(false);
    expect(page.visibleRooms().map((r) => r.id)).toEqual(['!a:hs']); // DMs
    expect(page.sidebarTitle()).toBe('Direct Messages');
  });

  it('sums unread notifications for the Home (DMs) and Rooms rail badges', () => {
    const page = build();
    // directRoomIds = {!a:hs}; DMs: a(5). Rooms view (non-DM, spaceless): c(2).
    // b(3) is a child of '!s:hs' → counted on the space pill, not the Rooms badge.
    expect(page.homeUnread()).toBe(5);
    expect(page.roomsUnread()).toBe(2);
  });

  it('sums unread notifications per space for the space-pill badges', () => {
    const page = build();
    // space !s:hs children [a, b] → a(5) + b(3) = 8.
    expect(page.spaceUnread()['!s:hs']).toBe(8);
  });

  it('re-derives homeUnread/roomsUnread when a room unreadCount changes underneath', () => {
    const page = build();
    expect(page.homeUnread()).toBe(5); // a(5)
    expect(page.roomsUnread()).toBe(2); // c(2); b is a space child → excluded

    const rooms = TestBed.inject(RoomsService)
      .rooms as unknown as WritableSignal<RoomSummary[]>;
    rooms.update((list) =>
      list.map((r) => (r.id === '!c:hs' ? { ...r, unreadCount: 20 } : r)),
    );

    expect(page.roomsUnread()).toBe(20); // c(20); b still excluded
    expect(page.homeUnread()).toBe(5); // DM total untouched
  });

  it('re-derives spaceUnread when a room is added to the tracked room list', () => {
    const page = build();
    expect(page.spaceUnread()['!s:hs']).toBe(8); // a(5) + b(3)

    const rooms = TestBed.inject(RoomsService)
      .rooms as unknown as WritableSignal<RoomSummary[]>;
    // A new message pushes bravo's unread up, as would a real sync refresh.
    rooms.update((list) =>
      list.map((r) => (r.id === '!b:hs' ? { ...r, unreadCount: 30 } : r)),
    );

    expect(page.spaceUnread()['!s:hs']).toBe(35); // a(5) + b(30)
  });

  it('re-derives the aggregates when a room is removed from the list', () => {
    const page = build();
    expect(page.spaceUnread()['!s:hs']).toBe(8);
    expect(page.roomsUnread()).toBe(2); // c(2); b is a space child → excluded

    const rooms = TestBed.inject(RoomsService)
      .rooms as unknown as WritableSignal<RoomSummary[]>;
    rooms.update((list) => list.filter((r) => r.id !== '!b:hs'));

    expect(page.spaceUnread()['!s:hs']).toBe(5); // only a(5) remains
    expect(page.roomsUnread()).toBe(2); // still just c(2) — b was already excluded
  });

  it('a spaceless room disappears from the Rooms view once a space claims it', () => {
    const page = build();
    page.onShowRooms();
    // Before: only '!c:hs' is spaceless non-DM.
    expect(page.visibleRooms().map((r) => r.id)).toEqual(['!c:hs']);
    expect(page.roomsUnread()).toBe(2);

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

    expect(page.visibleRooms()).toEqual([]); // '!c:hs' is now space-owned
    expect(page.roomsUnread()).toBe(0); // its unread leaves the Rooms badge too
  });

  it('a space child reappears in the Rooms view once its space no longer lists it', () => {
    const page = build();
    page.onShowRooms();
    // '!b:hs' is owned by '!s:hs' — hidden from the Rooms view.
    expect(page.visibleRooms().map((r) => r.id)).toEqual(['!c:hs']);
    expect(page.roomsUnread()).toBe(2);

    const spaces = TestBed.inject(SpacesService)
      .spaces as unknown as WritableSignal<SpaceSummary[]>;
    // The space is removed entirely (as leaving it would surface via sync).
    spaces.set([]);

    expect(page.visibleRooms().map((r) => r.id)).toEqual(['!c:hs', '!b:hs']);
    expect(page.roomsUnread()).toBe(5); // c(2) + b(3), now both spaceless
  });

  it('a room owned by two spaces is still excluded once it is dropped from only one', () => {
    const page = build();
    const spaces = TestBed.inject(SpacesService)
      .spaces as unknown as WritableSignal<SpaceSummary[]>;
    // '!b:hs' is now a child of both '!s:hs' and a second space '!t:hs'.
    spaces.update((list) => [...list, spaceSummary('!t:hs', ['!b:hs'])]);
    page.onShowRooms();
    expect(page.visibleRooms().map((r) => r.id)).toEqual(['!c:hs']); // b still hidden

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

    expect(page.visibleRooms().map((r) => r.id)).toEqual(['!c:hs']); // still hidden
    expect(page.roomsUnread()).toBe(2); // b's unread stays off the Rooms badge
  });
});

// A mixed scenario exercising several distinct spaces (each with its own unread
// total) alongside a DM/non-DM split in the same room set, all in one pass.
describe('RoomsPage unread aggregation: multiple spaces + DM split', () => {
  function roomSummary(id: string, name: string, unread = 0): RoomSummary {
    return {
      id,
      name,
      initial: name[0].toUpperCase(),
      avatarMxc: null,
      topic: '',
      memberCount: 0,
      encrypted: false,
      unreadCount: unread,
      highlightCount: 0,
      hasUnread: unread > 0,
      lastMessage: '',
      activityTs: 0,
      favourite: false,
    };
  }

  function spaceSummary(id: string, childRoomIds: string[]): SpaceSummary {
    return { id, name: id, initial: 'S', avatarMxc: null, childRoomIds };
  }

  function build(): RoomsPage {
    const rooms = [
      roomSummary('!dm:hs', 'dm-with-bob', 4), // a direct message
      roomSummary('!a:hs', 'alpha', 5), // space 1's only child
      roomSummary('!b:hs', 'bravo', 3), // space 2's child
      roomSummary('!c:hs', 'charlie', 7), // space 2's other child
      roomSummary('!free:hs', 'freestanding', 6), // non-DM, in no space
    ];
    const childRoomIds = vi.fn((id: string | null) => {
      if (id === '!s1:hs') return ['!a:hs'];
      if (id === '!s2:hs') return ['!b:hs', '!c:hs'];
      return [];
    });
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        {
          provide: RoomsService,
          useValue: {
            connect: vi.fn(),
            rooms: signal(rooms),
            directRoomIds: signal(new Set(['!dm:hs'])),
            revision: signal(0),
            membersOf: () => [],
          },
        },
        {
          provide: SpacesService,
          useValue: {
            connect: vi.fn(),
            openSpace: vi.fn(),
            spaces: signal([
              spaceSummary('!s1:hs', ['!a:hs']),
              spaceSummary('!s2:hs', ['!b:hs', '!c:hs']),
            ]),
            childRoomIds,
          },
        },
        { provide: TimelineService, useValue: { close: vi.fn() } },
        {
          provide: MatrixClientService,
          useValue: {
            isInitialized: true,
            instance: { getUserId: () => '@me:hs', getUser: () => null },
          },
        },
        { provide: CryptoService, useValue: { connect: vi.fn() } },
        {
          provide: ThreadsService,
          useValue: { close: vi.fn(), closeThread: vi.fn() },
        },
        {
          provide: ThreadPanelService,
          useValue: { open: vi.fn(), openList: vi.fn() },
        },
        {
          provide: PinnedMessagesService,
          useValue: {
            open: vi.fn(),
            close: vi.fn(),
            isPinned: vi.fn(() => false),
            pin: vi.fn(),
            unpin: vi.fn(),
            canPin: signal(false),
            pinnedEventIds: signal<string[]>([]),
            pinnedMessages: signal([]),
          },
        },
        {
          provide: PinnedPanelService,
          useValue: { openPanel: vi.fn(async () => null) },
        },
        invitesProvider(),
        { provide: UserPickerService, useValue: { pick: vi.fn() } },
        { provide: QuickSwitcherService, useValue: { pick: vi.fn() } },
        { provide: MessageSearchService, useValue: { search: vi.fn() } },
        { provide: TrnActionSheetService, useValue: { open: vi.fn() } },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: TrnDialogService, useValue: { hasOpen: () => false } },
        { provide: TrnToastService, useValue: { show: vi.fn() } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  it('keeps each space total independent and splits DM vs non-DM totals', () => {
    const page = build();

    expect(page.spaceUnread()).toEqual({
      '!s1:hs': 5, // alpha only
      '!s2:hs': 10, // bravo(3) + charlie(7)
    });
    expect(page.homeUnread()).toBe(4); // the DM only
    // The Rooms view is spaceless non-DM rooms only: just freestanding(6).
    // a/b/c belong to spaces (counted on their pills) and the DM is excluded.
    expect(page.roomsUnread()).toBe(6);
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

  function build(): RoomsPage {
    alertPrompt = vi.fn().mockResolvedValue(null);
    alertConfirm = vi.fn().mockResolvedValue(false);
    createSpace = vi.fn(() => of('!new:hs'));
    createRoomInSpace = vi.fn(() => of('!room:hs'));
    leaveSpace = vi.fn(() => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        { provide: RoomsService, useValue: { connect: vi.fn() } },
        {
          provide: SpacesService,
          useValue: {
            connect: vi.fn(),
            openSpace: vi.fn(),
            spaces: signal<SpaceSummary[]>([]),
            childRoomIds: () => [],
            createSpace,
            createRoomInSpace,
            leaveSpace,
          },
        },
        { provide: TimelineService, useValue: { close: vi.fn() } },
        {
          provide: MatrixClientService,
          useValue: {
            isInitialized: true,
            instance: { getUserId: () => '@me:hs', getUser: () => null },
          },
        },
        { provide: CryptoService, useValue: { connect: vi.fn() } },
        {
          provide: ThreadsService,
          useValue: { close: vi.fn(), closeThread: vi.fn() },
        },
        {
          provide: ThreadPanelService,
          useValue: { open: vi.fn(), openList: vi.fn() },
        },
        {
          provide: PinnedMessagesService,
          useValue: {
            open: vi.fn(),
            close: vi.fn(),
            isPinned: vi.fn(() => false),
            pin: vi.fn(),
            unpin: vi.fn(),
            canPin: signal(false),
            pinnedEventIds: signal<string[]>([]),
            pinnedMessages: signal([]),
          },
        },
        {
          provide: PinnedPanelService,
          useValue: { openPanel: vi.fn(async () => null) },
        },
        invitesProvider(),
        { provide: UserPickerService, useValue: { pick: vi.fn() } },
        { provide: QuickSwitcherService, useValue: { pick: vi.fn() } },
        { provide: MessageSearchService, useValue: { search: vi.fn() } },
        { provide: TrnActionSheetService, useValue: { open: vi.fn() } },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: TrnDialogService, useValue: { hasOpen: () => false } },
        {
          provide: TrnAlertService,
          useValue: { confirm: alertConfirm, prompt: alertPrompt },
        },
        { provide: TrnToastService, useValue: { show: vi.fn() } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  it('creates a space and selects it on success', async () => {
    const page = build();
    alertPrompt.mockResolvedValue('My Space');

    await page.onCreateSpace();

    expect(createSpace).toHaveBeenCalledWith({ name: 'My Space' });
    expect(page.activeSpaceId()).toBe('!new:hs');
  });

  it('does not create a space for an empty name', async () => {
    const page = build();
    alertPrompt.mockResolvedValue('   ');

    await page.onCreateSpace();

    expect(createSpace).not.toHaveBeenCalled();
  });

  it('does not create a space when the prompt is cancelled', async () => {
    const page = build();
    alertPrompt.mockResolvedValue(null);

    await page.onCreateSpace();

    expect(createSpace).not.toHaveBeenCalled();
  });

  it('surfaces a create-space failure in spaceError', async () => {
    const page = build();
    alertPrompt.mockResolvedValue('My Space');
    createSpace.mockReturnValue(throwError(() => new Error('boom')));

    await page.onCreateSpace();

    expect(page.spaceError()).toBe('boom');
    expect(page.activeSpaceId()).toBeNull(); // not selected on failure
  });

  it('creates a channel in the active space', async () => {
    const page = build();
    page.activeSpaceId.set('!s:hs');
    alertPrompt.mockResolvedValue('general');

    await page.onCreateChannel();

    expect(createRoomInSpace).toHaveBeenCalledWith('!s:hs', {
      name: 'general',
    });
  });

  it('does not prompt to create a channel on Home (no active space)', async () => {
    const page = build();
    page.activeSpaceId.set(null);

    await page.onCreateChannel();

    expect(alertPrompt).not.toHaveBeenCalled();
    expect(createRoomInSpace).not.toHaveBeenCalled();
  });

  it('leaves the active space and returns to Home on success', async () => {
    const page = build();
    page.activeSpaceId.set('!s:hs');
    alertConfirm.mockResolvedValue(true);

    await page.onLeaveSpace();

    expect(leaveSpace).toHaveBeenCalledWith('!s:hs');
    expect(page.activeSpaceId()).toBeNull();
  });

  it('does not leave when the confirm is cancelled', async () => {
    const page = build();
    page.activeSpaceId.set('!s:hs');
    alertConfirm.mockResolvedValue(false);

    await page.onLeaveSpace();

    expect(leaveSpace).not.toHaveBeenCalled();
  });

  it('does not prompt to leave on Home (no active space)', async () => {
    const page = build();
    page.activeSpaceId.set(null);

    await page.onLeaveSpace();

    expect(alertConfirm).not.toHaveBeenCalled();
    expect(leaveSpace).not.toHaveBeenCalled();
  });

  it('logs out and navigates to /login after confirming', async () => {
    const page = build();
    alertConfirm.mockResolvedValue(true);
    const auth = TestBed.inject(AuthService);
    const router = TestBed.inject(Router);

    await page.logout();

    expect(alertConfirm).toHaveBeenCalled();
    expect(auth.logout).toHaveBeenCalled();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/login', {
      replaceUrl: true,
    });
  });

  it('does not log out when the confirm is cancelled', async () => {
    const page = build();
    alertConfirm.mockResolvedValue(false);
    const auth = TestBed.inject(AuthService);

    await page.logout();

    expect(auth.logout).not.toHaveBeenCalled();
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
  let createDirectMessage: ReturnType<typeof vi.fn>;
  let inviteUser: ReturnType<typeof vi.fn>;
  let acceptInvite: ReturnType<typeof vi.fn>;
  let declineInvite: ReturnType<typeof vi.fn>;
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

  function build(): RoomsPage {
    alertPrompt = vi.fn().mockResolvedValue(null);
    toastShow = vi.fn();
    pick = vi.fn();
    createRoom = vi.fn(() => of('!room:hs'));
    createDirectMessage = vi.fn(() => of('!dm:hs'));
    inviteUser = vi.fn(() => of(undefined));
    acceptInvite = vi.fn(() => of(undefined));
    declineInvite = vi.fn(() => of(undefined));
    pending = signal<PendingInvite[]>([]);
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        {
          provide: RoomsService,
          useValue: {
            connect: vi.fn(),
            rooms: signal<RoomSummary[]>([]),
            revision: signal(0),
            membersOf: () => [],
            createRoom,
            createDirectMessage,
            inviteUser,
          },
        },
        {
          provide: SpacesService,
          useValue: {
            connect: vi.fn(),
            openSpace: vi.fn(),
            spaces: signal<SpaceSummary[]>([]),
            childRoomIds: () => [],
          },
        },
        invitesProvider({
          pendingInvites: pending,
          acceptInvite,
          declineInvite,
        }),
        { provide: UserPickerService, useValue: { pick } },
        { provide: QuickSwitcherService, useValue: { pick: vi.fn() } },
        { provide: MessageSearchService, useValue: { search: vi.fn() } },
        {
          provide: TimelineService,
          useValue: { open: vi.fn(), close: vi.fn() },
        },
        { provide: MediaService, useValue: { releaseAll: vi.fn() } },
        {
          provide: MatrixClientService,
          useValue: {
            isInitialized: true,
            instance: { getUserId: () => '@me:hs', getUser: () => null },
          },
        },
        { provide: CryptoService, useValue: { connect: vi.fn() } },
        {
          provide: ThreadsService,
          useValue: { open: vi.fn(), close: vi.fn(), closeThread: vi.fn() },
        },
        {
          provide: ThreadPanelService,
          useValue: { open: vi.fn(), openList: vi.fn() },
        },
        {
          provide: PinnedMessagesService,
          useValue: {
            open: vi.fn(),
            close: vi.fn(),
            isPinned: vi.fn(() => false),
            pin: vi.fn(),
            unpin: vi.fn(),
            canPin: signal(false),
            pinnedEventIds: signal<string[]>([]),
            pinnedMessages: signal([]),
          },
        },
        {
          provide: PinnedPanelService,
          useValue: { openPanel: vi.fn(async () => null) },
        },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: TrnDialogService, useValue: { hasOpen: () => false } },
        {
          provide: TrnAlertService,
          useValue: { confirm: vi.fn(), prompt: alertPrompt },
        },
        { provide: TrnActionSheetService, useValue: { open: vi.fn() } },
        { provide: TrnToastService, useValue: { show: toastShow } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  it('creates an encrypted room from the name prompt and selects it', async () => {
    const page = build();
    alertPrompt.mockResolvedValue('general');

    await page.onCreateRoom();

    expect(createRoom).toHaveBeenCalledWith({ name: 'general' });
    expect(page.activeRoomId()).toBe('!room:hs');
  });

  it('does not create a room for an empty name', async () => {
    const page = build();
    alertPrompt.mockResolvedValue('   ');

    await page.onCreateRoom();

    expect(createRoom).not.toHaveBeenCalled();
  });

  it('starts a DM with the picked user and selects the DM room', async () => {
    const page = build();
    pick.mockResolvedValue('@bob:hs');

    await page.onStartDm();

    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(page.activeRoomId()).toBe('!dm:hs');
  });

  it('does not start a DM when the picker is cancelled', async () => {
    const page = build();
    pick.mockResolvedValue(null);

    await page.onStartDm();

    expect(createDirectMessage).not.toHaveBeenCalled();
  });

  it('invites the picked user to the active room and toasts success', async () => {
    const page = build();
    page.activeRoomId.set('!r:hs');
    pick.mockResolvedValue('@bob:hs');

    await page.onInviteToRoom();

    expect(inviteUser).toHaveBeenCalledWith('!r:hs', '@bob:hs');
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('captures an invite failure in spaceError without a success toast', async () => {
    const page = build();
    page.activeRoomId.set('!r:hs');
    pick.mockResolvedValue('@bob:hs');
    inviteUser.mockReturnValue(throwError(() => new Error('forbidden')));

    await page.onInviteToRoom();

    // runWithBusy records the message in spaceError (the shell's effect toasts it,
    // like the create-space path); no success toast on failure.
    expect(page.spaceError()).toBe('forbidden');
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('does not invite when the picker is cancelled', async () => {
    const page = build();
    page.activeRoomId.set('!r:hs');
    pick.mockResolvedValue(null);

    await page.onInviteToRoom();

    expect(inviteUser).not.toHaveBeenCalled();
  });

  it('invites to the active space from the sidebar action', async () => {
    const page = build();
    page.activeSpaceId.set('!s:hs');
    pick.mockResolvedValue('@bob:hs');

    await page.onInviteToSpace();

    expect(inviteUser).toHaveBeenCalledWith('!s:hs', '@bob:hs');
  });

  it('accepts a room invite (joins) and selects the joined room', () => {
    const page = build();
    pending.set([pendingInvite({ roomId: '!i:hs', isSpace: false })]);

    page.onAcceptInvite('!i:hs');

    expect(acceptInvite).toHaveBeenCalledWith('!i:hs');
    expect(page.activeSpaceId()).toBeNull();
    expect(page.activeRoomId()).toBe('!i:hs');
  });

  it('accepts a space invite without auto-selecting a room', () => {
    const page = build();
    pending.set([pendingInvite({ roomId: '!s:hs', isSpace: true })]);

    page.onAcceptInvite('!s:hs');

    expect(acceptInvite).toHaveBeenCalledWith('!s:hs');
    expect(page.activeRoomId()).toBeNull(); // a space lands in the rail, not selected
  });

  it('declines an invite (leaves)', () => {
    const page = build();

    page.onDeclineInvite('!i:hs');

    expect(declineInvite).toHaveBeenCalledWith('!i:hs');
  });

  it('opens the new-chat action sheet on Home', async () => {
    const page = build();
    const sheetOpen = TestBed.inject(TrnActionSheetService).open as ReturnType<
      typeof vi.fn
    >;

    page.onNewChat();

    expect(sheetOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: expect.arrayContaining([
          expect.objectContaining({ text: 'Create a room' }),
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

  function build(): RoomsPage {
    alertConfirm = vi.fn().mockResolvedValue(false);
    openSpace = vi.fn();
    joinRoom = vi.fn(() => of(undefined));
    removeRoomFromSpace = vi.fn(() => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        {
          provide: RoomsService,
          useValue: {
            connect: vi.fn(),
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
                lastMessage: '',
                activityTs: 0,
                favourite: false,
              },
            ]),
            revision: signal(0),
            membersOf: () => [],
          },
        },
        {
          provide: SpacesService,
          useValue: {
            connect: vi.fn(),
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
            childRoomIds: () => [],
            notJoinedRooms: signal<SpaceChildRoom[]>([]),
            childSpaces: signal<SpaceChildRoom[]>([]),
            childrenLoading: signal(false),
            childrenError: signal<string | null>(null),
          },
        },
        { provide: TimelineService, useValue: { close: vi.fn() } },
        {
          provide: MatrixClientService,
          useValue: {
            isInitialized: true,
            instance: { getUserId: () => '@me:hs', getUser: () => null },
          },
        },
        { provide: CryptoService, useValue: { connect: vi.fn() } },
        {
          provide: ThreadsService,
          useValue: { close: vi.fn(), closeThread: vi.fn() },
        },
        {
          provide: ThreadPanelService,
          useValue: { open: vi.fn(), openList: vi.fn() },
        },
        {
          provide: PinnedMessagesService,
          useValue: {
            open: vi.fn(),
            close: vi.fn(),
            isPinned: vi.fn(() => false),
            pin: vi.fn(),
            unpin: vi.fn(),
            canPin: signal(false),
            pinnedEventIds: signal<string[]>([]),
            pinnedMessages: signal([]),
          },
        },
        {
          provide: PinnedPanelService,
          useValue: { openPanel: vi.fn(async () => null) },
        },
        invitesProvider(),
        { provide: UserPickerService, useValue: { pick: vi.fn() } },
        { provide: QuickSwitcherService, useValue: { pick: vi.fn() } },
        { provide: MessageSearchService, useValue: { search: vi.fn() } },
        { provide: TrnActionSheetService, useValue: { open: vi.fn() } },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: TrnDialogService, useValue: { hasOpen: () => false } },
        {
          provide: TrnAlertService,
          useValue: { confirm: alertConfirm, prompt: vi.fn() },
        },
        { provide: TrnToastService, useValue: { show: vi.fn() } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  it('loads the hierarchy when a space is selected (and clears it for Home)', () => {
    const page = build();

    page.onSelectSpace('!s:hs');
    expect(page.activeSpaceId()).toBe('!s:hs');
    expect(openSpace).toHaveBeenCalledWith('!s:hs');

    page.onSelectSpace(null);
    expect(openSpace).toHaveBeenLastCalledWith(null);
  });

  it('joins a not-yet-joined child through its via servers', () => {
    const page = build();

    page.onJoinChild(childRoom({ roomId: '!x:hs', via: ['hs.example'] }));

    expect(joinRoom).toHaveBeenCalledWith('!x:hs', ['hs.example']);
  });

  it('confirms then removes a joined child from the active space', async () => {
    const page = build();
    page.activeSpaceId.set('!s:hs');
    alertConfirm.mockResolvedValue(true);

    await page.onRemoveFromSpace('!c:hs');

    // The confirmation names the channel and the space.
    expect(alertConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ header: 'Remove from space' }),
    );
    expect(removeRoomFromSpace).toHaveBeenCalledWith('!s:hs', '!c:hs');
  });

  it('does not remove when the confirm is cancelled', async () => {
    const page = build();
    page.activeSpaceId.set('!s:hs');
    alertConfirm.mockResolvedValue(false);

    await page.onRemoveFromSpace('!c:hs');

    expect(removeRoomFromSpace).not.toHaveBeenCalled();
  });

  it('does not prompt to remove on Home (no active space)', async () => {
    const page = build();
    page.activeSpaceId.set(null);

    await page.onRemoveFromSpace('!c:hs');

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

  function build(): RoomsPage {
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
        {
          provide: RoomsService,
          useValue: {
            connect: vi.fn(),
            rooms: signal<RoomSummary[]>([]),
            revision: signal(0),
            membersOf: () => [],
            createDirectMessage,
          },
        },
        {
          provide: SpacesService,
          useValue: {
            connect: vi.fn(),
            openSpace,
            spaces: signal<SpaceSummary[]>([]),
            childRoomIds: () => [],
          },
        },
        invitesProvider({
          pendingInvites: pending,
          acceptInvite,
        }),
        { provide: UserPickerService, useValue: { pick: vi.fn() } },
        { provide: QuickSwitcherService, useValue: { pick } },
        {
          provide: MessageSearchService,
          useValue: { search: messageSearch },
        },
        {
          provide: TimelineService,
          useValue: { open: timelineOpen, close: vi.fn() },
        },
        { provide: MediaService, useValue: { releaseAll: vi.fn() } },
        {
          provide: MatrixClientService,
          useValue: {
            isInitialized: true,
            instance: { getUserId: () => '@me:hs', getUser: () => null },
          },
        },
        { provide: CryptoService, useValue: { connect: vi.fn() } },
        {
          provide: ThreadsService,
          useValue: { open: vi.fn(), close: vi.fn(), closeThread: vi.fn() },
        },
        {
          provide: ThreadPanelService,
          useValue: { open: vi.fn(), openList: vi.fn() },
        },
        {
          provide: PinnedMessagesService,
          useValue: {
            open: vi.fn(),
            close: vi.fn(),
            isPinned: vi.fn(() => false),
            pin: vi.fn(),
            unpin: vi.fn(),
            canPin: signal(false),
            pinnedEventIds: signal<string[]>([]),
            pinnedMessages: signal([]),
          },
        },
        {
          provide: PinnedPanelService,
          useValue: { openPanel: vi.fn(async () => null) },
        },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: TrnDialogService, useValue: { hasOpen: dialogHasOpen } },
        {
          provide: TrnAlertService,
          useValue: { confirm: vi.fn(), prompt: vi.fn() },
        },
        { provide: TrnActionSheetService, useValue: { open: vi.fn() } },
        { provide: TrnToastService, useValue: { show: vi.fn() } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  it('opens the selected room', async () => {
    const page = build();
    pick.mockResolvedValue({ kind: 'room', id: '!r:hs' });

    await page.openSwitcher();

    expect(page.activeRoomId()).toBe('!r:hs');
    expect(timelineOpen).toHaveBeenCalledWith('!r:hs');
  });

  it('opens a DM result like a room', async () => {
    const page = build();
    pick.mockResolvedValue({ kind: 'dm', id: '!d:hs' });

    await page.openSwitcher();

    expect(page.activeRoomId()).toBe('!d:hs');
  });

  it('selects a space in the rail (loading its hierarchy)', async () => {
    const page = build();
    pick.mockResolvedValue({ kind: 'space', id: '!s:hs' });

    await page.openSwitcher();

    expect(page.activeSpaceId()).toBe('!s:hs');
    expect(openSpace).toHaveBeenCalledWith('!s:hs');
    expect(page.activeRoomId()).toBeNull();
  });

  it('opens (or reuses) a DM for a directory person', async () => {
    const page = build();
    pick.mockResolvedValue({ kind: 'user', id: '@bob:hs' });

    await page.openSwitcher();

    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(page.activeRoomId()).toBe('!dm:hs');
  });

  it('runs the accept path for an invite result', async () => {
    const page = build();
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

    await page.openSwitcher();

    expect(acceptInvite).toHaveBeenCalledWith('!i:hs');
    expect(page.activeRoomId()).toBe('!i:hs');
  });

  it('does nothing when the switcher is cancelled', async () => {
    const page = build();
    pick.mockResolvedValue(null);

    await page.openSwitcher();

    expect(page.activeRoomId()).toBeNull();
    expect(timelineOpen).not.toHaveBeenCalled();
  });

  it('Ctrl/Cmd+K prevents default and opens the switcher', async () => {
    const page = build();
    pick.mockResolvedValue(null);
    const preventDefault = vi.fn();

    page.onQuickSwitch({ preventDefault } as unknown as KeyboardEvent);

    expect(preventDefault).toHaveBeenCalled(); // sync — stops the browser's Cmd+K
    await new Promise((resolve) => setTimeout(resolve)); // settle the async openSwitcher()
    expect(pick).toHaveBeenCalled();
  });

  it('does not open the switcher over an existing overlay', async () => {
    const page = build();
    dialogHasOpen.mockReturnValue(true);

    await page.openSwitcher();

    // A thread/search/verification modal owns the screen — the switcher must not
    // stack over it (picking a result would releaseAll() its pinned media).
    expect(pick).not.toHaveBeenCalled();
  });

  it('opens in-room message search for the active room and jumps to the hit', async () => {
    const page = build();
    page.onSelectRoom('!r:hs');
    messageSearch.mockResolvedValue('$evt:hs');

    await page.openMessageSearch();

    expect(messageSearch).toHaveBeenCalledWith('!r:hs');
    expect(page.messageSearchTarget()).toBe('$evt:hs');
    expect(page.jumpRequest()).toBe(1);
  });

  it('in-room search bumps jumpRequest again when the SAME hit is re-picked', async () => {
    // Same crux as the pinned panel: picking the identical hit twice must still
    // re-fire the jump, which only happens because jumpRequest keeps incrementing.
    const page = build();
    page.onSelectRoom('!r:hs');
    messageSearch.mockResolvedValue('$evt:hs');

    await page.openMessageSearch();
    expect(page.jumpRequest()).toBe(1);

    await page.openMessageSearch();

    expect(page.messageSearchTarget()).toBe('$evt:hs');
    expect(page.jumpRequest()).toBe(2);
  });

  it('does not jump when in-room search is cancelled', async () => {
    const page = build();
    page.onSelectRoom('!r:hs');
    messageSearch.mockResolvedValue(null);

    await page.openMessageSearch();

    expect(page.messageSearchTarget()).toBeNull();
    expect(page.jumpRequest()).toBe(0);
  });

  it('does not open in-room search when no room is active', async () => {
    const page = build();
    messageSearch.mockResolvedValue('$evt:hs');

    await page.openMessageSearch();

    expect(messageSearch).not.toHaveBeenCalled();
    expect(page.messageSearchTarget()).toBeNull();
  });
});

// The channel sidebar renders as a static column at md+ and an overlay drawer
// below that breakpoint. `drawerOpen` tracks the overlay's visibility; picking a
// room (mobile's primary path to the sidebar) should collapse it again.
describe('RoomsPage mobile nav drawer', () => {
  let timelineOpen: ReturnType<typeof vi.fn>;
  let threadsOpen: ReturnType<typeof vi.fn>;
  let releaseAll: ReturnType<typeof vi.fn>;

  function build(): RoomsPage {
    timelineOpen = vi.fn();
    threadsOpen = vi.fn();
    releaseAll = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        {
          provide: RoomsService,
          useValue: {
            connect: vi.fn(),
            rooms: signal<RoomSummary[]>([]),
            revision: signal(0),
            membersOf: () => [],
          },
        },
        {
          provide: SpacesService,
          useValue: {
            connect: vi.fn(),
            openSpace: vi.fn(),
            spaces: signal<SpaceSummary[]>([]),
            childRoomIds: () => [],
          },
        },
        {
          provide: TimelineService,
          useValue: { open: timelineOpen, close: vi.fn() },
        },
        { provide: MediaService, useValue: { releaseAll } },
        {
          provide: MatrixClientService,
          useValue: {
            isInitialized: true,
            instance: { getUserId: () => '@me:hs', getUser: () => null },
          },
        },
        { provide: CryptoService, useValue: { connect: vi.fn() } },
        {
          provide: ThreadsService,
          useValue: { open: threadsOpen, close: vi.fn(), closeThread: vi.fn() },
        },
        {
          provide: ThreadPanelService,
          useValue: { open: vi.fn(), openList: vi.fn() },
        },
        {
          provide: PinnedMessagesService,
          useValue: {
            open: vi.fn(),
            close: vi.fn(),
            isPinned: vi.fn(() => false),
            pin: vi.fn(),
            unpin: vi.fn(),
            canPin: signal(false),
            pinnedEventIds: signal<string[]>([]),
            pinnedMessages: signal([]),
          },
        },
        {
          provide: PinnedPanelService,
          useValue: { openPanel: vi.fn(async () => null) },
        },
        invitesProvider(),
        { provide: UserPickerService, useValue: { pick: vi.fn() } },
        { provide: QuickSwitcherService, useValue: { pick: vi.fn() } },
        { provide: MessageSearchService, useValue: { search: vi.fn() } },
        { provide: TrnActionSheetService, useValue: { open: vi.fn() } },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: TrnDialogService, useValue: { hasOpen: () => false } },
        { provide: TrnToastService, useValue: { show: vi.fn() } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  it('starts closed', () => {
    const page = build();

    expect(page.drawerOpen()).toBe(false);
  });

  it('toggleDrawer flips the open state', () => {
    const page = build();

    page.toggleDrawer();
    expect(page.drawerOpen()).toBe(true);

    page.toggleDrawer();
    expect(page.drawerOpen()).toBe(false);
  });

  it('closeDrawer forces the drawer closed regardless of its current state', () => {
    const page = build();
    page.toggleDrawer();
    expect(page.drawerOpen()).toBe(true);

    page.closeDrawer();

    expect(page.drawerOpen()).toBe(false);
  });

  it('closeDrawer is a no-op when already closed', () => {
    const page = build();

    page.closeDrawer();

    expect(page.drawerOpen()).toBe(false);
  });

  it('shows the member list by default and toggleMembers flips it', () => {
    const page = build();
    expect(page.membersOpen()).toBe(true);

    page.toggleMembers();
    expect(page.membersOpen()).toBe(false);

    page.toggleMembers();
    expect(page.membersOpen()).toBe(true);
  });

  it('closeMembers hides the member list', () => {
    const page = build();

    page.closeMembers();

    expect(page.membersOpen()).toBe(false);
  });

  it('onSelectRoom collapses an open drawer after picking a room', () => {
    const page = build();
    page.toggleDrawer();
    expect(page.drawerOpen()).toBe(true);

    page.onSelectRoom('!r:hs');

    expect(page.drawerOpen()).toBe(false);
    // The existing room-switch behavior keeps working alongside the new collapse.
    expect(page.activeRoomId()).toBe('!r:hs');
    expect(timelineOpen).toHaveBeenCalledWith('!r:hs');
    expect(threadsOpen).toHaveBeenCalledWith('!r:hs');
    expect(releaseAll).toHaveBeenCalled();
  });
});
