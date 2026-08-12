import {
  SHARED_MOCKS,
  clientStub,
  invitesProvider,
  setRouteQueryParams,
  shellFrom,
  stubNarrowLayout,
} from './rooms-page.spec-harness';
import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { KeyboardShortcutsService } from '@trinity/platform-native';
import { AuthService } from '@trinity/data-access/auth';
import { type PendingInvite } from '@trinity/data-access/invites';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { AccountProfilesService } from '@trinity/data-access/profile';
import { MediaService } from '@trinity/data-access/media';
import { PinnedMessagesService } from '@trinity/data-access/pinned';
import {
  RoomsService,
  SpacesService,
  UnreadAggregatorService,
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
} from '@trinity/kit/overlay';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { RoomsPage } from './rooms.page';
import { UserPickerService } from '../user-picker/user-picker.service';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { MessageSearchService } from '../message-search/message-search.service';

// The quick switcher (Ctrl/Cmd+K) presents a modal and, on a selection, jumps per
// kind: room/dm open the room, space selects it in the rail, a directory person
// opens a DM, an invite runs the page's accept path.
describe('RoomsPage quick switcher', () => {
  let pick: Mock;
  let messageSearch: Mock;
  let createDirectMessage: Mock;
  let acceptInvite: Mock;
  let openSpace: Mock;
  let timelineOpen: Mock;
  let pending: WritableSignal<PendingInvite[]>;
  let dialogHasOpen: Mock;

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
        MockProvider(TimelineActionsService),
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
        accountId: '@me:hs',
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
  let timelineOpen: Mock;
  let threadsOpen: Mock;
  let releaseAll: Mock;

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
        MockProvider(TimelineActionsService),
        MockProvider(MediaService, { releaseAll }),
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

// The user-panel switcher summarises every signed-in account: each row is that account's
// profile (display name + avatar) from AccountProfilesService with a fallback to the raw
// MXID, plus its unread total — and it tolerates an account the projection has no entry
// for yet, which still shows as a row with a zero badge.
describe('RoomsPage account switcher summary', () => {
  const meAvatar = 'mxc://hs/me';

  function build() {
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService),
        MockProvider(SpacesService),
        MockProvider(TimelineService),
        MockProvider(TimelineActionsService),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>([
            '@me:hs',
            '@alt:hs',
          ]).asReadonly(),
          // Profiles come from the projection below, not from reading clients here.
          clientFor: () => null,
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map([['@me:hs', 4]]),
          ).asReadonly(),
        }),
        // '@me:hs' has a hydrated profile; '@alt:hs' is signed in but has no entry yet,
        // so its row falls back to the mxid.
        MockProvider(AccountProfilesService, {
          profiles: signal(
            new Map([
              [
                '@me:hs',
                {
                  userId: '@me:hs',
                  displayName: 'Me',
                  avatarMxc: meAvatar,
                },
              ],
            ]),
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

    // '@me:hs': hydrated profile (name + avatar) with its unread total from the
    // aggregator. '@alt:hs': no profile entry yet, so the name falls back to the MXID,
    // the avatar is null, and its unread defaults to 0 (absent from the map).
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
      accountId: '@me:hs',
      accountIds: ['@me:hs'],
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
      lowPriority: false,
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
        MockProvider(TimelineActionsService),
        MockProvider(MediaService, { releaseAll }),
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

// A notification tap (web Notification, Electron toast, or an FCM/APNs tap) navigates to
// `/rooms?room=<id>`; the shell is what has to turn that into an open room. These drive the
// real query param through to `activeRoomId` — the producer side was already asserted
// against a mocked Router in the notifications lib, which stayed green for the whole time
// nothing consumed the param.
describe('RoomsPage notification deep link', () => {
  let timelineOpen: Mock;

  function build() {
    timelineOpen = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService),
        MockProvider(SpacesService),
        MockProvider(TimelineService, { open: timelineOpen }),
        MockProvider(TimelineActionsService),
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
        MockProvider(AuthService),
        MockProvider(TrnDialogService),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  afterEach(() => setRouteQueryParams({})); // never leak a deep link into the next test

  it('opens the room named by ?room= when the page is created with it', () => {
    setRouteQueryParams({ room: '!notified:hs' });
    const shell = build();

    TestBed.tick(); // run the deep-link effect

    expect(shell.store.activeRoomId()).toBe('!notified:hs');
    expect(timelineOpen).toHaveBeenCalledWith('!notified:hs');
  });

  it('opens it when the param arrives on the already-active /rooms route', () => {
    // THE case: tapping a notification while the shell is open does not re-create the
    // component, so a route snapshot read sees nothing. Only the stream fires.
    const shell = build();
    TestBed.tick();
    expect(shell.store.activeRoomId()).toBeNull();

    setRouteQueryParams({ room: '!notified:hs' });
    TestBed.tick();

    expect(shell.store.activeRoomId()).toBe('!notified:hs');
    expect(timelineOpen).toHaveBeenCalledWith('!notified:hs');
  });

  it('strips the param with replaceUrl so Back does not re-open the room', () => {
    setRouteQueryParams({ room: '!notified:hs' });
    build();

    TestBed.tick();

    expect(TestBed.inject(Router).navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        queryParams: { room: null },
        replaceUrl: true,
      }),
    );
  });

  it('does not re-open the room that is already open', () => {
    const shell = build();
    shell.nav.onSelectRoom('!notified:hs');
    timelineOpen.mockClear();

    setRouteQueryParams({ room: '!notified:hs' });
    TestBed.tick();

    expect(shell.store.activeRoomId()).toBe('!notified:hs');
    expect(timelineOpen).not.toHaveBeenCalled();
  });

  it('ignores a route with no room param', () => {
    const shell = build();

    TestBed.tick();

    expect(shell.store.activeRoomId()).toBeNull();
    expect(TestBed.inject(Router).navigate).not.toHaveBeenCalled();
  });
});
