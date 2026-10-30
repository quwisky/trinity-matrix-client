import {
  SHARED_MOCKS,
  UNREAD_AGGREGATOR_PROVIDER,
  clientStub,
  invitesProvider,
  sessionStateProvider,
  setRouteRoom,
  settleWorkspace,
  shellFrom,
} from './rooms-page.spec-harness';
import { computed, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  AccountRuntimeService,
  type AccountSwitchCoordination,
} from '@trinity/data-access/accounts';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import {
  RoomLibraryService,
  SelectedRoomLibraryService,
  SpaceRoomOrderService,
  SpacesService,
  AccountScopeService,
  type RoomSummary,
  type SpaceSummary,
} from '@trinity/data-access/room-library';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import {
  TrnAlertService,
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { of, switchMap } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { RoomsPage } from './rooms.page';
import { UserPickerService } from '../user-picker/user-picker.service';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { desktopBridgeFixture } from '@trinity/testing';
import { roomSummary, spaceSummary } from '../testing/room-summary.fixture';

// The route outlives any one TestBed — it is one stream in the harness, shared by every
// block in this file. Without the reset a test that opens a room hands it to the next one,
// where "no room is open" would then assert against the previous test's room.
beforeEach(() => setRouteRoom(null));
afterEach(() => {
  delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
});

// Mixed-account view (issue #10): the global "All accounts" scope spans every signed-in
// account across ALL surfaces — Recent, Home's DMs, the Rooms list and the rail spaces —
// and opening a foreign-account item switches to that account first.
//
// Split out of rooms.page.navigation.spec.ts, whose worker fork was being OOM-killed
// mid-run on a loaded machine — surfacing as a different failing test each run with the
// executed-test count silently short, which reads exactly like an ordinary flake.
//
// The split was worth making because that file measured 1298 MB against a ~950 MB floor,
// NOT because it had 49 tests: peak RSS tracks the component a file mounts, not its test
// count (a 24-test spec here costs the same as a 116-test one). See the measurements in
// the developer diagnostics guide before splitting anything else — both halves of this
// one landed on the floor, so there is nothing further to win here.

describe('RoomsPage mixed-account view', () => {
  function room(
    id: string,
    accountId: string,
    opts: { directUserId?: string; unread?: number } = {},
  ): RoomSummary {
    return roomSummary({
      id,
      accountId,
      accountIds: [accountId],
      name: id,
      initial: id[1].toUpperCase(),
      unreadCount: opts.unread ?? 0,
      hasUnread: (opts.unread ?? 0) > 0,
      directUserId: opts.directUserId,
    });
  }

  function space(
    id: string,
    accountId: string,
    childRoomIds: string[] = [],
  ): SpaceSummary {
    return spaceSummary({
      id,
      accountId,
      name: id,
      childRoomIds,
    });
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

  let switchAccount: Mock;
  /** The picker's current selection, driven directly by the tests. */
  let shownAccounts: WritableSignal<ReadonlySet<string>>;
  let mixedRooms: WritableSignal<RoomSummary[]>;
  /** What @me's own space lists in the mixed view; empty unless a test files rooms in it. */
  let mineSpaceChildren: WritableSignal<string[]>;
  let leaveSpace: Mock;
  let toggleAccount: Mock;

  function build(
    accountIds: string[],
    avatars: Record<string, string | null> = {},
  ) {
    const activeUserId = signal<string | null>('@me:hs');
    switchAccount = vi.fn(
      (accountId: string, coordination: AccountSwitchCoordination) =>
        coordination.prepare().pipe(
          switchMap(() => {
            coordination.onCommitStarted?.();
            activeUserId.set(accountId);
            return of({
              kind: 'ready' as const,
              accountId,
            });
          }),
        ),
    );
    shownAccounts = signal<ReadonlySet<string>>(new Set(['@me:hs']));
    mixedRooms = signal(mixedRoomList());
    mineSpaceChildren = signal<string[]>([]);
    leaveSpace = vi.fn(() => of(void 0));
    toggleAccount = vi.fn(() => of({ kind: 'completed' as const }));
    const selectedView = computed(() => {
      const accountIds = shownAccounts();
      const mixing = accountIds.size > 1;
      return {
        accountIds,
        mode: mixing ? ('mixed' as const) : ('active' as const),
        rooms: mixing ? mixedRooms() : [room('!mine:hs', '@me:hs')],
        spaces: mixing
          ? [
              space('!s-mine:hs', '@me:hs', mineSpaceChildren()),
              space('!s-alt:hs', '@alt:hs', ['!child-theirs:hs']),
            ]
          : [space('!s-mine:hs', '@me:hs')],
        spaceChildRoomIdsByAccount: mixing
          ? new Map([
              ['@me:hs', new Set<string>(mineSpaceChildren())],
              ['@alt:hs', new Set(['!child-theirs:hs'])],
            ])
          : new Map([['@me:hs', new Set<string>()]]),
        invitations: [],
      };
    });
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomLibraryService, {
          selectionAvailability: () => 'available',
          clearMarkedUnread: () => of(void 0),
          rooms: signal([room('!mine:hs', '@me:hs')]),
          directRoomIds: signal<ReadonlySet<string>>(new Set()),
        }),
        MockProvider(SpacesService, {
          openSpace: () => of(void 0),
          spaces: signal([space('!s-mine:hs', '@me:hs')]),
          childRoomIds: vi.fn(() => []),
          leaveSpace,
        }),
        MockProvider(AccountScopeService, {
          selected: shownAccounts.asReadonly(),
          mixing: computed(() => shownAccounts().size > 1),
          toggle: toggleAccount,
        }),
        MockProvider(SelectedRoomLibraryService, {
          view: selectedView,
          // Each space's own account holds it; the mixed view lists it for every selected one.
          spaceAvailability: (accountId: string, spaceId: string) => {
            const view = selectedView();
            return view.spaces.some(
              (candidate) =>
                candidate.id === spaceId &&
                (candidate.accountId === accountId ||
                  (view.mode === 'mixed' && view.accountIds.has(accountId))),
            )
              ? 'available'
              : 'unavailable';
          },
          toggleAccount,
        }),
        MockProvider(TimelineActionsService),
        sessionStateProvider({
          activeAccountId: activeUserId.asReadonly(),
          accountIds,
        }),
        MockProvider(MatrixClientService, {
          activeUserId: activeUserId.asReadonly(),
          accountIds: signal<readonly string[]>(accountIds).asReadonly(),
          clientFor: (id: string) =>
            clientStub({
              getUser: () => ({ avatarUrl: avatars[id] ?? null }),
            }),
        }),
        UNREAD_AGGREGATOR_PROVIDER,
        // Profiles come from the projection now, not from reading each client here.
        MockProvider(AccountIdentitiesService, {
          identities: signal(
            new Map(
              accountIds.map((id) => [
                id,
                { userId: id, displayName: id, avatarMxc: avatars[id] ?? null },
              ]),
            ),
          ).asReadonly(),
        }),
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(AccountRuntimeService, {
          activeAccountId: activeUserId.asReadonly(),
          switchActiveAccount: switchAccount,
        }),
        MockProvider(TrnSurfaceService),
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
    expect(shell.vm.accountBadges().size).toBeGreaterThan(0);
  });

  it('carries each account’s real avatar into the badge lookup', () => {
    const shell = build(['@me:hs', '@alt:hs'], {
      '@alt:hs': 'mxc://hs/alt-avatar',
    });
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    TestBed.tick();

    // The badge exposes the account's own avatar (resolved to the real image downstream)…
    expect(shell.vm.accountBadges().get('@alt:hs')?.avatarMxc).toBe(
      'mxc://hs/alt-avatar',
    );
    // …and null for an account with no avatar, so the badge falls back to its initial.
    expect(shell.vm.accountBadges().get('@me:hs')?.avatarMxc).toBeNull();
  });

  it('Home shows every account’s DMs in mixed mode', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    TestBed.tick();
    shell.nav.onSelectSpace({ spaceId: null, accountId: '@me:hs' }); // Home — leaves Recent
    await settleWorkspace();

    // Both accounts' DMs (classified by each row's own-account m.direct), nothing else.
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual([
      '!dm-mine:hs',
      '!dm-theirs:hs',
    ]);
    expect(shell.vm.sidebarTitle()).toBe('Direct messages');
  });

  it('Rooms shows every account’s non-DM, non-space rooms in mixed mode', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    TestBed.tick();
    shell.nav.onShowRooms();
    await settleWorkspace();

    // Non-DM rooms from both accounts, excluding DMs and @alt's space child.
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual([
      '!mine:hs',
      '!theirs:hs',
    ]);
    expect(shell.vm.sidebarTitle()).toBe('Rooms');
  });

  it('switches to the owning account before opening a foreign room', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    TestBed.tick();

    shell.routing.openLinkedRoom('!theirs:hs'); // belongs to @alt:hs
    await vi.waitFor(() =>
      expect(switchAccount).toHaveBeenCalledWith(
        '@alt:hs',
        expect.objectContaining({ prepare: expect.any(Function) }),
      ),
    );
    await settleWorkspace();

    // Returning to the first Account is another atomic Workspace switch.
    switchAccount.mockClear();
    shell.routing.openLinkedRoom('!mine:hs');
    await settleWorkspace();
    expect(switchAccount).toHaveBeenCalledWith(
      '@me:hs',
      expect.objectContaining({ prepare: expect.any(Function) }),
    );
    expect(shell.store.activeRoomId()).toBe('!mine:hs');
  });

  it('opens a selected row with the exact Account identity emitted by that row', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));

    shell.routing.onSelectRoomSelection(
      {
        roomId: '!theirs:hs',
        accountId: '@alt:hs',
      },
      'room-list',
    );

    await vi.waitFor(() =>
      expect(switchAccount).toHaveBeenCalledWith(
        '@alt:hs',
        expect.objectContaining({ prepare: expect.any(Function) }),
      ),
    );
    await settleWorkspace();
    expect(shell.store.activeRoomId()).toBe('!theirs:hs');
  });

  it('keeps an exact MRU owner when a mixed row is shared by two accounts', async () => {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture();
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    mixedRooms.update((rooms) => [
      ...rooms,
      {
        ...room('!shared:hs', '@me:hs'),
        accountIds: ['@me:hs', '@alt:hs'],
      },
    ]);
    shell.routing.onSelectRoomSelection(
      {
        accountId: '@alt:hs',
        roomId: '!shared:hs',
      },
      'room-list',
    );
    await settleWorkspace();
    shell.routing.onSelectRoomSelection(
      {
        accountId: '@me:hs',
        roomId: '!mine:hs',
      },
      'room-list',
    );
    await settleWorkspace();
    switchAccount.mockClear();

    shell.shortcuts.onGlobalKeydown({
      code: 'Digit1',
      key: '1',
      ctrlKey: true,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    await vi.waitFor(() =>
      expect(switchAccount).toHaveBeenCalledWith(
        '@alt:hs',
        expect.objectContaining({ prepare: expect.any(Function) }),
      ),
    );
    await settleWorkspace();
    expect(shell.store.activeRoomId()).toBe('!shared:hs');
  });

  it('switches to the owning account before selecting a foreign space', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    TestBed.tick();

    shell.routing.onSelectSpaceRow({
      spaceId: '!s-alt:hs',
      accountId: '@alt:hs',
    });
    await vi.waitFor(() =>
      expect(switchAccount).toHaveBeenCalledWith(
        '@alt:hs',
        expect.objectContaining({ prepare: expect.any(Function) }),
      ),
    );
    await settleWorkspace();

    // Returning to the first Account switches once; Home then stays on it.
    switchAccount.mockClear();
    shell.routing.onSelectSpaceRow({
      spaceId: '!s-mine:hs',
      accountId: '@me:hs',
    });
    await settleWorkspace();
    shell.routing.onSelectSpaceRow({ spaceId: null, accountId: '@me:hs' });
    await settleWorkspace();
    expect(switchAccount).toHaveBeenCalledOnce();
    expect(switchAccount).toHaveBeenCalledWith(
      '@me:hs',
      expect.objectContaining({ prepare: expect.any(Function) }),
    );
  });

  it('narrows the projections back down when an account is unticked', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    TestBed.tick();
    expect(shell.vm.visibleRooms().length).toBeGreaterThan(1);

    shownAccounts.set(new Set(['@me:hs']));
    TestBed.tick();
    // Recent falls back to the active Account projection only.
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual(['!mine:hs']);
  });

  // The rail badges must count what their view renders: before this they summed the ACTIVE
  // account's rooms while the list below showed every mixed account's.
  it('sums the rail unread badges across the mixed accounts', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    TestBed.tick();

    expect(shell.vm.recentUnread()).toBe(15); // 7 + 3 + 5 across both accounts
    expect(shell.vm.homeUnread()).toBe(3); // the foreign account's DM
    expect(shell.vm.roomsUnread()).toBe(7); // non-DM, minus @alt's space child
    expect(shell.vm.spaceUnread()['!s-alt:hs']).toBe(5); // the foreign space's child

    // Unticking drops back to the active account's own totals (all zero here).
    shownAccounts.set(new Set(['@me:hs']));
    TestBed.tick();
    expect(shell.vm.recentUnread()).toBe(0);
  });

  // A shortcut/MRU target is routinely OUTSIDE the current view (Home lists DMs only, a
  // space lists its children), so resolving the owning account from visibleRooms() would
  // miss and open the room on whatever client happens to be active.
  it('resolves a foreign room’s account even when the current view filters it out', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onSelectSpace({ spaceId: null, accountId: '@me:hs' }); // Home — DMs only, so '!theirs:hs' is not visible
    await settleWorkspace();
    expect(shell.vm.visibleRooms().map((r) => r.id)).not.toContain(
      '!theirs:hs',
    );

    shell.routing.openLinkedRoom('!theirs:hs');

    await vi.waitFor(() =>
      expect(switchAccount).toHaveBeenCalledWith(
        '@alt:hs',
        expect.objectContaining({ prepare: expect.any(Function) }),
      ),
    );
  });

  // The switcher searches every mixed account, so a jump can land on a room owned by an
  // account that isn't active — it must switch first, exactly like clicking the row.
  it('switches accounts when jumping to a foreign room from the quick switcher', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    TestBed.inject(QuickSwitcherService).pick$ = vi.fn(() =>
      of({
        kind: 'conversation' as const,
        accountId: '@alt:hs',
        roomId: '!theirs:hs',
      }),
    );

    await shell.shortcuts.openSwitcher();
    TestBed.tick(); // the follow-up open is deferred past the re-projection render
    await settleWorkspace();

    expect(switchAccount).toHaveBeenCalledWith(
      '@alt:hs',
      expect.objectContaining({ prepare: expect.any(Function) }),
    );
    expect(shell.store.activeRoomId()).toBe('!theirs:hs');
  });

  it('switches accounts when jumping to a foreign space from the quick switcher', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    TestBed.inject(QuickSwitcherService).pick$ = vi.fn(() =>
      of({
        kind: 'space' as const,
        accountId: '@alt:hs',
        spaceId: '!s-alt:hs',
      }),
    );

    await shell.shortcuts.openSwitcher();

    expect(switchAccount).toHaveBeenCalledWith(
      '@alt:hs',
      expect.objectContaining({ prepare: expect.any(Function) }),
    );
  });

  // A room that is top-level for the account you are ACTING AS must not vanish from the
  // Rooms view just because a different mixed account files it inside one of its spaces.
  it('keeps a room that only another account files under a space', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onShowRooms();
    await settleWorkspace();

    // '!child-theirs:hs' is a child of @alt's space, so it is excluded for @alt…
    expect(shell.vm.visibleRooms().map((r) => r.id)).not.toContain(
      '!child-theirs:hs',
    );
    // …while @me's own spaceless room stays, even though @alt's space claims a room id.
    expect(shell.vm.visibleRooms().map((r) => r.id)).toContain('!mine:hs');
  });

  // The pill's unread badge is summed over the mixed union, so the space it opens must
  // list that same union — otherwise the badge counts rooms the view never renders.
  it('lists a mixed space’s children from the same union its badge counts', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onSelectSpace({ spaceId: '!s-alt:hs', accountId: '@me:hs' });
    await settleWorkspace();

    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual([
      '!child-theirs:hs',
    ]);
  });

  // #1369 in the mixed view: a space's row can belong to an account that does not hold the
  // space. A space lists the rooms its holders joined, so with two accounts only a rail chat
  // gets here; with three, a holder that is not on screen can file a room @alt joined.
  // Opening it acts as @alt and keeps the space, which the mixed view lists for @me.
  it('keeps the space for a row of an account that does not hold it', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    mineSpaceChildren.set(['!theirs:hs']); // @me's space files a room whose row is @alt's
    // @me orders the space alphabetically; @alt has no ordering of its own for it.
    vi.spyOn(
      TestBed.inject(SpaceRoomOrderService),
      'snapshotFor',
    ).mockImplementation((accountId) => ({
      defaultMode: 'recent',
      overrideMode: accountId === '@me:hs' ? 'alphabetical' : null,
      effectiveMode: accountId === '@me:hs' ? 'alphabetical' : 'recent',
    }));
    shell.nav.onSelectSpace({ spaceId: '!s-mine:hs', accountId: '@me:hs' });
    await settleWorkspace();
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual(['!theirs:hs']);
    expect(shell.vm.spaceSortMode()).toBe('alphabetical');

    // What the sidebar's `(selectRoom)` binding calls for the clicked row.
    shell.routing.onSelectRoomSelection(
      { roomId: '!theirs:hs', accountId: '@alt:hs' },
      'room-list',
    );
    await settleWorkspace();

    expect(switchAccount).toHaveBeenCalledWith(
      '@alt:hs',
      expect.objectContaining({ prepare: expect.any(Function) }),
    );
    expect(shell.store.activeAccountId()).toBe('@alt:hs');
    expect(shell.store.activeRoomId()).toBe('!theirs:hs');
    expect(shell.store.activeSpaceId()).toBe('!s-mine:hs');
    expect(shell.store.recentView()).toBe(false);
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual(['!theirs:hs']);
    // The list keeps the ordering of the account that holds the space, so the switch does
    // not reorder it under the pointer.
    expect(shell.vm.spaceOrderAccountId()).toBe('@me:hs');
    expect(shell.vm.spaceSortMode()).toBe('alphabetical');
  });

  // #1402: unticking the account that holds the space leaves no shown account holding it.
  it('unticking the account that holds the selected space returns to Recent with the room open', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    mineSpaceChildren.set(['!theirs:hs']);
    shell.nav.onSelectSpace({ spaceId: '!s-mine:hs', accountId: '@me:hs' });
    await settleWorkspace();
    shell.routing.onSelectRoomSelection(
      { roomId: '!theirs:hs', accountId: '@alt:hs' },
      'room-list',
    );
    await settleWorkspace();
    expect(shell.store.activeSpaceId()).toBe('!s-mine:hs');

    shownAccounts.set(new Set(['@alt:hs']));

    await vi.waitFor(() => {
      TestBed.tick();
      expect(shell.store.recentView()).toBe(true);
    });
    expect(shell.store.activeAccountId()).toBe('@alt:hs');
    expect(shell.store.activeRoomId()).toBe('!theirs:hs');
  });

  it('keeps the space when the opened row belongs to an account that holds it', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onSelectSpace({ spaceId: '!s-alt:hs', accountId: '@me:hs' });
    await settleWorkspace();

    shell.routing.onSelectRoomSelection(
      { roomId: '!child-theirs:hs', accountId: '@alt:hs' },
      'room-list',
    );
    await settleWorkspace();

    expect(shell.store.activeAccountId()).toBe('@alt:hs');
    expect(shell.store.activeRoomId()).toBe('!child-theirs:hs');
    expect(shell.store.activeSpaceId()).toBe('!s-alt:hs');
    expect(shell.vm.spaceOrderAccountId()).toBe('@alt:hs');
  });

  // Clicking the highlighted pill again, to get back to the list, stays on the account on
  // screen and its room rather than switching to the account that holds the space.
  it('keeps the account and its room when the selected space pill is clicked again', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    mineSpaceChildren.set(['!theirs:hs']);
    shell.nav.onSelectSpace({ spaceId: '!s-mine:hs', accountId: '@me:hs' });
    await settleWorkspace();
    shell.routing.onSelectRoomSelection(
      { roomId: '!theirs:hs', accountId: '@alt:hs' },
      'room-list',
    );
    await settleWorkspace();
    expect(shell.store.activeAccountId()).toBe('@alt:hs');
    switchAccount.mockClear();

    // The pill names the account that holds the space.
    shell.routing.onSelectSpaceRow({
      spaceId: '!s-mine:hs',
      accountId: '@me:hs',
    });
    await settleWorkspace();

    expect(switchAccount).not.toHaveBeenCalled();
    expect(shell.store.activeAccountId()).toBe('@alt:hs');
    expect(shell.store.activeRoomId()).toBe('!theirs:hs');
    expect(shell.store.activeSpaceId()).toBe('!s-mine:hs');
  });

  // Leave and Members act as the active account, which here does not hold the space.
  it('offers Leave and Members only as the account that holds the space', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    mineSpaceChildren.set(['!theirs:hs']);
    shell.nav.onSelectSpace({ spaceId: '!s-mine:hs', accountId: '@me:hs' });
    await settleWorkspace();
    expect(shell.vm.spaceMembershipPermission().available).toBe(true);

    shell.routing.onSelectRoomSelection(
      { roomId: '!theirs:hs', accountId: '@alt:hs' },
      'room-list',
    );
    await settleWorkspace();

    expect(shell.vm.spaceMembershipPermission()).toEqual({
      available: false,
      reason: 'Switch to the account that owns this space.',
    });
    const confirm = vi.spyOn(TestBed.inject(TrnAlertService), 'confirm$');
    const surfaces = TestBed.inject(TrnSurfaceService);
    shell.spaces.onLeaveSpace();
    shell.spaces.onOpenSpaceMembers();
    expect(confirm).not.toHaveBeenCalled();
    expect(leaveSpace).not.toHaveBeenCalled();
    expect(surfaces.openAndWait$).not.toHaveBeenCalled();
  });

  // The space scope belongs to the outgoing account; the Recent/DMs/Rooms filter does not.
  it('keeps the Rooms filter across an account switch but drops the space', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onShowRooms();
    await settleWorkspace();

    shell.routing.openLinkedRoom('!theirs:hs'); // switches to @alt
    await settleWorkspace();

    expect(shell.store.roomsView()).toBe(true); // the user's filter survives
    expect(shell.store.activeSpaceId()).toBeNull();
  });

  it('returns to Recent when the switch happened from inside a space', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onSelectSpace({ spaceId: '!s-mine:hs', accountId: '@me:hs' });
    await settleWorkspace();

    shell.routing.openLinkedRoom('!theirs:hs');
    await settleWorkspace();

    expect(shell.store.activeSpaceId()).toBeNull();
    expect(shell.store.recentView()).toBe(true);
  });

  it('forwards a picker tick to the account scope', () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shell.routing.onToggleAccountShown('@alt:hs');
    expect(toggleAccount).toHaveBeenCalledWith('@alt:hs');
  });
});
