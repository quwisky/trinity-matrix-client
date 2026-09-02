import {
  SHARED_MOCKS,
  clientStub,
  invitesProvider,
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
import {
  MixedInvitesService,
  type PendingInvite,
} from '@trinity/data-access/room-library';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import {
  RoomLibraryService,
  SpacesService,
  AccountScopeService,
  MixedRoomsService,
  MixedSpacesService,
  UnreadAggregatorService,
  type RoomSummary,
  type SpaceSummary,
} from '@trinity/data-access/room-library';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { of, switchMap } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { RoomsPage } from './rooms.page';
import { UserPickerService } from '../user-picker/user-picker.service';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';

// The route outlives any one TestBed — it is one stream in the harness, shared by every
// block in this file. Without the reset a test that opens a room hands it to the next one,
// where "no room is open" would then assert against the previous test's room.
beforeEach(() => setRouteRoom(null));

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
// docs/reference/troubleshooting.md before splitting anything else — both halves of this
// one landed on the floor, so there is nothing further to win here.

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
      lowPriority: false,
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

  let switchAccount: Mock;
  let setMixedRoomsAccounts: Mock;
  /** The picker's current selection, driven directly by the tests. */
  let shownAccounts: WritableSignal<ReadonlySet<string>>;
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
              metrics: {
                durationMs: 0,
                projectionDurationMs: 0,
                projectionCount: 0,
              },
            });
          }),
        ),
    );
    setMixedRoomsAccounts = vi.fn();
    shownAccounts = signal<ReadonlySet<string>>(new Set(['@me:hs']));
    toggleAccount = vi.fn(() => of(void 0));
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
        MockProvider(TimelineActionsService),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: activeUserId.asReadonly(),
          accountIds: signal<readonly string[]>(accountIds).asReadonly(),
          clientFor: (id: string) =>
            clientStub({
              getUser: () => ({ avatarUrl: avatars[id] ?? null }),
            }),
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map(),
          ).asReadonly(),
        }),
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

  it('Home shows every account’s DMs in mixed mode', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onSelectSpace(null); // Home — leaves Recent
    await settleWorkspace();

    // Both accounts' DMs (classified by each row's own-account m.direct), nothing else.
    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual([
      '!dm-mine:hs',
      '!dm-theirs:hs',
    ]);
    expect(shell.vm.sidebarTitle()).toBe('Direct Messages');
  });

  it('Rooms shows every account’s non-DM, non-space rooms in mixed mode', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
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

    shell.routing.onSelectRoomRow('!theirs:hs'); // belongs to @alt:hs
    await vi.waitFor(() =>
      expect(switchAccount).toHaveBeenCalledWith(
        '@alt:hs',
        expect.objectContaining({ prepare: expect.any(Function) }),
      ),
    );
    await settleWorkspace();

    // Returning to the first Account is another atomic Workspace switch.
    switchAccount.mockClear();
    shell.routing.onSelectRoomRow('!mine:hs');
    await settleWorkspace();
    expect(switchAccount).toHaveBeenCalledWith(
      '@me:hs',
      expect.objectContaining({ prepare: expect.any(Function) }),
    );
    expect(shell.store.activeRoomId()).toBe('!mine:hs');
  });

  it('switches to the owning account before selecting a foreign space', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));

    shell.routing.onSelectSpaceRow('!s-alt:hs'); // belongs to @alt:hs
    await vi.waitFor(() =>
      expect(switchAccount).toHaveBeenCalledWith(
        '@alt:hs',
        expect.objectContaining({ prepare: expect.any(Function) }),
      ),
    );
    await settleWorkspace();

    // Returning to the first Account switches once; Home then stays on it.
    switchAccount.mockClear();
    shell.routing.onSelectSpaceRow('!s-mine:hs');
    await settleWorkspace();
    shell.routing.onSelectSpaceRow(null);
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
  it('resolves a foreign room’s account even when the current view filters it out', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onSelectSpace(null); // Home — DMs only, so '!theirs:hs' is not visible
    await settleWorkspace();
    expect(shell.vm.visibleRooms().map((r) => r.id)).not.toContain(
      '!theirs:hs',
    );

    shell.routing.onSelectRoomRow('!theirs:hs');

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
    shell.nav.onSelectSpace('!s-alt:hs');
    await settleWorkspace();

    expect(shell.vm.visibleRooms().map((r) => r.id)).toEqual([
      '!child-theirs:hs',
    ]);
  });

  // The space scope belongs to the outgoing account; the Recent/DMs/Rooms filter does not.
  it('keeps the Rooms filter across an account switch but drops the space', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onShowRooms();
    await settleWorkspace();

    shell.routing.onSelectRoomRow('!theirs:hs'); // switches to @alt
    await settleWorkspace();

    expect(shell.store.roomsView()).toBe(true); // the user's filter survives
    expect(shell.store.activeSpaceId()).toBeNull();
  });

  it('returns to Recent when the switch happened from inside a space', async () => {
    const shell = build(['@me:hs', '@alt:hs']);
    shownAccounts.set(new Set(['@me:hs', '@alt:hs']));
    shell.nav.onSelectSpace('!s-mine:hs');
    await settleWorkspace();

    shell.routing.onSelectRoomRow('!theirs:hs');
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
