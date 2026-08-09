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
import {
  RoomsService,
  SpacesService,
  UnreadAggregatorService,
  SpaceRoomOrderService,
  TRINITY_ROOM_SORTS,
  type RoomSortMode,
  type RoomSummary,
  type SpaceSummary,
} from '@trinity/data-access/rooms';
import { ThreadsService, TimelineService } from '@trinity/data-access/timeline';
import { TrnDialogService, TrnToastService } from '@trinity/helm/overlay';
import { MockProvider } from 'ng-mocks';

import { describe, expect, it, vi } from 'vitest';
import { RoomsPage } from './rooms.page';
import { UserPickerService } from '../user-picker/user-picker.service';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { MessageSearchService } from '../message-search/message-search.service';

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
      lowPriority: false,
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

  // The sidebar's filter box writes `store.roomFilter`, and the shell — not the sidebar —
  // applies it. That split exists so the Alt+Arrow room walk steps through exactly what is
  // on screen; the tests below are what hold the two halves together.
  it('narrows the rendered list without touching what actions operate on', () => {
    const shell = build();

    shell.store.roomFilter.set('l'); // matches "charlie" and "alpha", not "bravo"

    expect(shell.vm.filteredRooms().map((r) => r.id)).toEqual([
      '!c:hs',
      '!a:hs',
    ]);
    // `visibleRooms` is what "mark all as read" and name lookups read — a filter is a view
    // over the list, not a change to which rooms exist.
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual([
      '!c:hs',
      '!a:hs',
      '!b:hs',
    ]);
  });

  it('hands back the very same array when nothing is typed', () => {
    const shell = build();

    // Identity, not just equality: an unfiltered shell must not allocate a new array on
    // every sync, or every downstream computed would invalidate for nothing.
    expect(shell.vm.filteredRooms()).toBe(shell.vm.visibleRooms());
  });

  it('walks the FILTERED list with Alt+Arrow, so the keyboard cannot land off-screen', () => {
    const shell = build();
    shell.nav.onSelectRoom('!c:hs');
    // "charlie" and "bravo" match; "alpha" does not. The hidden room has to sit BETWEEN
    // the active one and the next visible one (list order is c, a, b) or the filtered and
    // unfiltered walks would step to the same room and prove nothing.
    shell.store.roomFilter.set('r');
    expect(shell.vm.filteredRooms().map((r) => r.id)).toEqual([
      '!c:hs',
      '!b:hs',
    ]);

    shell.shortcuts.onGlobalKeydown({
      key: 'ArrowDown',
      code: '',
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    // Unfiltered, c → a. Filtered, a is off screen, so the walk steps c → b.
    expect(shell.store.activeRoomId()).toBe('!b:hs');
  });

  it('jumps to the next unread room within the filter, not past it', () => {
    const shell = build();
    shell.nav.onSelectRoom('!c:hs');
    // All three are unread, so the only thing that can move the target is the filter.
    shell.store.roomFilter.set('r'); // c, b on screen; a hidden between them

    shell.shortcuts.onGlobalKeydown({
      key: 'ArrowDown',
      code: '',
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: true,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    // Unfiltered the next unread after c is a; filtered it is b.
    expect(shell.store.activeRoomId()).toBe('!b:hs');
  });

  it('keeps the unread flag on the unfiltered list', () => {
    const shell = build();

    // Every seeded room is unread, so a filter matching NOTHING is what separates "is
    // anything unread" from "is anything unread on screen".
    shell.store.roomFilter.set('zzz');
    expect(shell.vm.filteredRooms()).toEqual([]);

    // "Mark all as read" marks every room, so it must stay offered.
    expect(shell.vm.anyRoomUnread()).toBe(true);
  });

  it('drops the filter when the shell switches to another list', () => {
    const shell = build();
    shell.store.roomFilter.set('alpha');

    shell.nav.onSelectSpace('!s:hs');

    // A filter typed in one view must not silently narrow the next one.
    expect(shell.store.roomFilter()).toBe('');
  });

  it('treats an all-whitespace query as no filter', () => {
    const shell = build();

    shell.store.roomFilter.set('   ');

    expect(shell.vm.filteredRooms()).toBe(shell.vm.visibleRooms());
  });
});

// Inside a space the list is ordered by the mode that space resolves to. The fixture below
// makes the three orderings disagree pairwise, so no assertion can pass under the wrong one.

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
      lowPriority: false,
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
      lowPriority: false,
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
