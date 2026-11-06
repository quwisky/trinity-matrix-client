import { effect, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import {
  MatrixClientService,
  type SyncState,
} from '@trinity/data-access/matrix-client';
import { MentionInboxPreferences } from '@trinity/data-access/notifications';
import {
  type MemberSummary,
  RoomActionPermissionsService,
  RoomMembersService,
} from '@trinity/data-access/room-administration';
import {
  AccountIdentitiesService,
  type AccountIdentity,
} from '@trinity/data-access/identity';
import {
  RoomLibraryService,
  SelectedRoomLibraryService,
  SpaceChildrenService,
  SpaceRoomOrderService,
  RailUnreadChatsPreference,
  UnreadAggregatorService,
  type RailUnreadChatMode,
  type RoomSummary,
  type SelectedRoomLibraryView,
  type UnreadRoom,
} from '@trinity/data-access/room-library';
import {
  TrustAccountStatusService,
  type AccountTrustSummary,
} from '@trinity/data-access/trust';
import { type AccountBadge } from '@trinity/components/generic-content';
import { AccountBadgesService } from '../shared/account-badges.service';
import { RoomShellStore } from './room-shell-store';
import { RoomShellViewModel } from './room-shell-view-model';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { roomSummary, spaceSummary } from '../testing/room-summary.fixture';

/**
 * The view model's own spec, for the two surfaces it derives from the projections this
 * branch introduced: the account chip (`AccountIdentitiesService`) and the member list
 * (`RoomMembersService.membersFor`).
 *
 * Its own file rather than an assertion on the page, because the page specs deliberately
 * never render (`shell-invariants.spec.ts`) and the harness says an assertion belongs to
 * the class that owns the logic. Nothing anywhere asserted these getters before — poisoning
 * all four of the profile ones left the whole feature suite green.
 */
function member(userId: string, name: string): MemberSummary {
  return {
    userId,
    roomDisplayName: name,
    roomInitial: name[0],
    roomAvatarMxc: null,
    powerLevel: 0,
    isCreator: false,
  };
}

function profile(
  userId: string,
  displayName: string,
  avatarMxc: string | null = null,
): AccountIdentity {
  return { userId, displayName, avatarMxc };
}

function build(
  opts: {
    members?: Record<string, MemberSummary[]>;
    selectedView?: SelectedRoomLibraryView;
  } = {},
) {
  const profiles = signal<ReadonlyMap<string, AccountIdentity>>(new Map());
  const activeUserId = signal<string | null>('@me:hs');
  const accountIds = signal<readonly string[]>(['@me:hs']);
  const restoringAccountIds = signal<ReadonlySet<string>>(new Set());
  const prepared = signal(true);
  const syncState = signal<SyncState | null>(null);
  const trustSummaries = signal<ReadonlyMap<string, AccountTrustSummary>>(
    new Map(),
  );
  const rosters = new Map(
    Object.entries(opts.members ?? {}).map(([roomId, list]) => [
      roomId,
      signal<readonly MemberSummary[]>(list),
    ]),
  );
  const empty = signal<readonly MemberSummary[]>([]).asReadonly();
  // Respects the room id, so a view model reading the wrong room fails instead of being
  // handed the fixture anyway.
  const membersFor = vi.fn(
    (roomId: string | null) => rosters.get(roomId ?? '')?.asReadonly() ?? empty,
  );
  // Workspace owns the semantic destination. This focused view-model test supplies only
  // its read model and mutates the backing signal as if a transition had committed.
  const activeRoomId = signal<string | null>(null);
  const unreadRooms = signal<readonly UnreadRoom[]>([]);
  const railMode = signal<RailUnreadChatMode>('up-to-5');
  const mixed = signal(false);
  const placement = signal<'list' | 'conversation' | 'split'>('split');
  const recentView = signal(true);
  const roomsView = signal(false);
  const inboxView = signal(false);
  const showInbox = signal(true);
  const activeSpaceId = signal<string | null>(null);
  const selectedView = signal<SelectedRoomLibraryView>(
    opts.selectedView ?? {
      accountIds: new Set(['@me:hs']),
      mode: 'active',
      rooms: [],
      spaces: [],
      spaceChildRoomIdsByAccount: new Map(),
      invitations: [],
    },
  );

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      RoomShellStore,
      RoomShellViewModel,
      MockProvider(RoomLibraryService),
      MockProvider(SelectedRoomLibraryService, {
        view: selectedView.asReadonly(),
      }),
      MockProvider(RoomMembersService, {
        membersFor,
        membersView: () => ({
          availability: 'coherent',
          current: membersFor(activeRoomId())(),
          stale: null,
        }),
      }),
      MockProvider(SpaceChildrenService),
      MockProvider(RoomActionPermissionsService, {
        room: () => ({
          invite: { available: true, reason: null },
          curateSpace: { available: true, reason: null },
        }),
      }),
      MockProvider(SpaceRoomOrderService),
      MockProvider(AccountBadgesService, {
        mixed: mixed.asReadonly(),
        everyAccount: signal<ReadonlyMap<string, AccountBadge>>(
          new Map([
            [
              '@me:hs',
              { id: '@me:hs', name: 'Me', initial: 'M', avatarMxc: null },
            ],
            [
              '@ben:hs',
              { id: '@ben:hs', name: 'Ben', initial: 'B', avatarMxc: null },
            ],
          ]),
        ).asReadonly(),
      }),
      MockProvider(RailUnreadChatsPreference, { mode: railMode.asReadonly() }),
      MockProvider(UnreadAggregatorService, {
        unreadRooms: unreadRooms.asReadonly(),
        unreadByAccount: signal<ReadonlyMap<string, number>>(
          new Map(),
        ).asReadonly(),
      }),
      MockProvider(MatrixClientService, {
        activeUserId: activeUserId.asReadonly(),
        accountIds: accountIds.asReadonly(),
        roomsPrepared: () => prepared(),
        syncState: syncState.asReadonly(),
      }),
      {
        provide: WorkspaceNavigationService,
        useValue: {
          activeAccountId: activeUserId.asReadonly(),
          activeSpaceId: activeSpaceId.asReadonly(),
          activeRoomId: activeRoomId.asReadonly(),
          recentView: recentView.asReadonly(),
          roomsView: roomsView.asReadonly(),
          inboxView: inboxView.asReadonly(),
          pane: signal<'list' | 'conversation'>('list').asReadonly(),
          placement: placement.asReadonly(),
        },
      },
      MockProvider(MentionInboxPreferences, {
        showInbox: showInbox.asReadonly(),
      }),
      MockProvider(AccountIdentitiesService, {
        identities: profiles.asReadonly(),
        identityOf: (userId: string) =>
          profiles().get(userId) ?? profile(userId, userId),
      }),
      MockProvider(TrustAccountStatusService, {
        summaries: trustSummaries.asReadonly(),
      }),
      MockProvider(AccountRuntimeService, {
        restoringAccountIds: restoringAccountIds.asReadonly(),
      }),
    ],
  });

  return {
    vm: TestBed.inject(RoomShellViewModel),
    openRoom: (roomId: string) => activeRoomId.set(roomId),
    unreadRooms,
    railMode,
    mixed,
    placement,
    profiles,
    activeUserId,
    accountIds,
    restoringAccountIds,
    prepared,
    syncState,
    trustSummaries,
    rosters,
    membersFor,
    selectedView,
    showInbox,
    openInbox: () => {
      recentView.set(false);
      inboxView.set(true);
    },
    showRooms: () => {
      recentView.set(false);
      roomsView.set(true);
    },
    selectSpace: (spaceId: string) => {
      recentView.set(false);
      activeSpaceId.set(spaceId);
    },
  };
}

function room(
  id: string,
  accountId: string,
  accountIds: readonly string[] = [accountId],
): RoomSummary {
  return roomSummary({
    id,
    accountId,
    accountIds,
    name: id,
    initial: 'R',
    memberCount: 2,
  });
}

describe('RoomShellViewModel inbox', () => {
  const rooms = [
    room('!a:hs', '@me:hs'),
    { ...room('!b:hs', '@me:hs'), name: 'bravo' },
  ];
  const view = (): SelectedRoomLibraryView => ({
    accountIds: new Set(['@me:hs']),
    mode: 'active',
    rooms,
    spaces: [],
    spaceChildRoomIdsByAccount: new Map(),
    invitations: [],
  });

  it('labels the back arrow by where it goes: the inbox, else the rooms', () => {
    const { vm, openInbox } = build();
    expect(vm.backLabel()).toBe('Back to rooms');

    openInbox();

    expect(vm.backLabel()).toBe('Back to inbox');
  });

  it('follows the show-the-inbox switch', () => {
    const { vm, showInbox } = build();
    expect(vm.inboxShown()).toBe(true);

    showInbox.set(false);

    expect(vm.inboxShown()).toBe(false);
  });

  it('walks every room in Recent order while the inbox shows, ignoring a hidden filter', () => {
    const { vm, openInbox } = build({ selectedView: view() });
    expect(vm.filteredRooms()).toHaveLength(2);

    openInbox();

    expect(vm.visibleRooms().map((r) => r.id)).toEqual(['!a:hs', '!b:hs']);
    expect(vm.filteredRooms().map((r) => r.id)).toEqual(['!a:hs', '!b:hs']);
  });
});

describe('RoomShellViewModel room list loading', () => {
  // #1868: "No rooms here yet." flashed between sign-in and the first sync.
  it('is loading until the account has prepared its rooms, then stays settled', () => {
    const { vm, prepared } = build();

    prepared.set(false);
    expect(vm.roomListLoading()).toBe(true);
    prepared.set(true);
    expect(vm.roomListLoading()).toBe(false);
  });

  it('does not go back to loading when sync errors after the rooms were prepared', () => {
    const { vm, syncState } = build();

    syncState.set('ERROR' as SyncState);
    expect(vm.roomListLoading()).toBe(false);
  });
});

describe('RoomShellViewModel selected space', () => {
  const team = spaceSummary({
    id: '!s:hs',
    accountId: '@me:hs',
    name: 'Team',
    initial: 'T',
  });

  // #1401: a restored space can be named before the account's sync lists it.
  it("titles a selected space it cannot list yet 'Loading space…', never 'Direct messages'", () => {
    const { vm, selectSpace, selectedView } = build();

    selectSpace('!s:hs');
    expect(vm.activeSpacePending()).toBe(true);
    expect(vm.sidebarTitle()).toBe('Loading space…');

    selectedView.update((view) => ({ ...view, spaces: [team] }));
    expect(vm.activeSpacePending()).toBe(false);
    expect(vm.sidebarTitle()).toBe('Team');
  });

  it('lists the selected space only once the selected view does', () => {
    const { vm, selectSpace, selectedView } = build({
      selectedView: {
        accountIds: new Set(['@me:hs']),
        mode: 'active',
        rooms: [],
        spaces: [team],
        spaceChildRoomIdsByAccount: new Map(),
        invitations: [],
      },
    });
    expect(vm.activeSpaceListed()).toBe(false); // Recent activity

    selectSpace('!s:hs');
    expect(vm.activeSpaceListed()).toBe(true);
    expect(vm.activeSpacePending()).toBe(false);

    selectedView.update((view) => ({ ...view, spaces: [] }));
    expect(vm.activeSpaceListed()).toBe(false);
    expect(vm.activeSpacePending()).toBe(true);
  });
});

describe('RoomShellViewModel selected hierarchy', () => {
  it('uses the winning Account hierarchy for a shared Room', () => {
    const shared = room('!shared:hs', '@a:hs', ['@a:hs', '@b:hs']);
    const { vm, selectedView, showRooms } = build({
      selectedView: {
        accountIds: new Set(['@a:hs', '@b:hs']),
        mode: 'mixed',
        rooms: [shared],
        spaces: [],
        spaceChildRoomIdsByAccount: new Map([
          ['@a:hs', new Set()],
          ['@b:hs', new Set(['!shared:hs'])],
        ]),
        invitations: [],
      },
    });
    showRooms();

    expect(vm.visibleRooms()).toEqual([shared]);

    selectedView.update((view) => ({
      ...view,
      spaceChildRoomIdsByAccount: new Map([
        ['@a:hs', new Set(['!shared:hs'])],
        ['@b:hs', new Set()],
      ]),
    }));

    expect(vm.visibleRooms()).toEqual([]);
  });
});

describe('RoomShellViewModel.listsShowing', () => {
  const dm = { ...room('!dm:hs', '@me:hs'), directUserId: '@ben:hs' };
  const group = room('!group:hs', '@me:hs');
  const child = room('!child:hs', '@me:hs');
  const space = spaceSummary({
    id: '!s:hs',
    accountId: '@me:hs',
    name: 'Space',
    childRoomIds: ['!child:hs', '!dm:hs'],
  });
  const lists = (selection: { accountId: string; roomId: string }) =>
    build({
      selectedView: {
        accountIds: new Set(['@me:hs']),
        mode: 'active',
        rooms: [dm, group, child],
        spaces: [space],
        spaceChildRoomIdsByAccount: new Map([
          ['@me:hs', new Set(['!child:hs'])],
        ]),
        invitations: [],
      },
    }).vm.listsShowing(selection);

  it('lists a direct message in Recent and Home, and in a space that files it', () => {
    expect(lists({ accountId: '@me:hs', roomId: '!dm:hs' })).toEqual([
      { kind: 'recent' },
      { kind: 'home' },
      { kind: 'space', spaceId: '!s:hs' },
    ]);
  });

  it('lists a room outside spaces in Recent and Rooms', () => {
    expect(lists({ accountId: '@me:hs', roomId: '!group:hs' })).toEqual([
      { kind: 'recent' },
      { kind: 'rooms' },
    ]);
  });

  it('lists a space child in Recent and its space, since Rooms leaves it under its space', () => {
    expect(lists({ accountId: '@me:hs', roomId: '!child:hs' })).toEqual([
      { kind: 'recent' },
      { kind: 'space', spaceId: '!s:hs' },
    ]);
  });

  // The resolver keeps a listed space for any account, so a row must not be claimed for an
  // account it does not carry: Workspace would repair that space and drop the chat.
  it('claims only Recent for an account the row does not carry', () => {
    expect(lists({ accountId: '@other:hs', roomId: '!child:hs' })).toEqual([
      { kind: 'recent' },
    ]);
  });

  it('claims only Recent for a room the selected library does not hold', () => {
    expect(lists({ accountId: '@me:hs', roomId: '!gone:hs' })).toEqual([
      { kind: 'recent' },
    ]);
  });
});

describe('RoomShellViewModel account profile', () => {
  it('shows the mxid until the profile hydrates, then the name', () => {
    // The consumer half of the defect this branch already hit once at the service: the own
    // account's profile arrives on the first sync, not at startup, so anything that read it
    // once would show a raw mxid for the whole session.
    const { vm, profiles } = build();
    expect(vm.userName()).toBe('@me:hs');
    expect(vm.userAvatarMxc()).toBeNull();
    expect(vm.userInitial()).toBe('M');

    profiles.set(
      new Map([['@me:hs', profile('@me:hs', 'Ada', 'mxc://hs/ada')]]),
    );

    expect(vm.userName()).toBe('Ada');
    expect(vm.userAvatarMxc()).toBe('mxc://hs/ada');
    expect(vm.userInitial()).toBe('A');
    expect(vm.userProfile()).toEqual({
      userId: '@me:hs',
      displayName: 'Ada',
      avatarMxc: 'mxc://hs/ada',
    });
  });

  it('follows the account that is switched to', () => {
    const { vm, profiles, activeUserId } = build();
    profiles.set(
      new Map([
        ['@me:hs', profile('@me:hs', 'Ada')],
        ['@alt:hs', profile('@alt:hs', 'Bo')],
      ]),
    );
    expect(vm.userName()).toBe('Ada');

    activeUserId.set('@alt:hs');

    expect(vm.userName()).toBe('Bo');
  });

  it('falls back to the mxid for an account whose display name is empty', () => {
    // Synapse hands back '' for a user with no displayname, so `??` would render a blank
    // row where `||` renders the mxid.
    const { vm, profiles, accountIds } = build();
    accountIds.set(['@alt:hs']);
    profiles.set(new Map([['@alt:hs', profile('@alt:hs', '')]]));

    expect(vm.accounts()[0].displayName).toBe('@alt:hs');
  });

  it('marks each account with its device trust, unknown until Trust has read it', () => {
    const { vm, accountIds, trustSummaries } = build();
    accountIds.set(['@me:hs', '@alt:hs']);
    trustSummaries.set(new Map([['@alt:hs', 'unverified']]));

    expect(vm.accounts().map((account) => account.trust)).toEqual([
      'unknown',
      'unverified',
    ]);
  });
});

it('lists an account still restoring in the background as restoring until it settles', () => {
  const { vm, accountIds, restoringAccountIds } = build();
  restoringAccountIds.set(new Set(['@late:hs']));

  expect(
    vm.accounts().map(({ userId, restoring }) => [userId, restoring]),
  ).toEqual([
    ['@me:hs', false],
    ['@late:hs', true],
  ]);

  accountIds.set(['@me:hs', '@late:hs']);
  restoringAccountIds.set(new Set());

  expect(
    vm.accounts().map(({ userId, restoring }) => [userId, restoring]),
  ).toEqual([
    ['@me:hs', false],
    ['@late:hs', false],
  ]);
});

describe('RoomShellViewModel members', () => {
  it('reads the open room, and follows it without the room changing', () => {
    const { vm, openRoom, rosters, membersFor } = build({
      members: { '!a:hs': [member('@a:hs', 'Ada')] },
    });
    openRoom('!a:hs');
    expect(vm.members().map((m) => m.userId)).toEqual(['@a:hs']);

    rosters.get('!a:hs')?.set([member('@a:hs', 'Ada'), member('@b:hs', 'Bo')]);

    expect(vm.members().map((m) => m.userId)).toEqual(['@a:hs', '@b:hs']);
    expect(membersFor).toHaveBeenCalledWith('!a:hs');
  });

  it('switches to the room that becomes active', () => {
    const { vm, openRoom } = build({
      members: {
        '!a:hs': [member('@a:hs', 'Ada')],
        '!b:hs': [member('@b:hs', 'Bo')],
      },
    });
    openRoom('!a:hs');
    expect(vm.members().map((m) => m.userId)).toEqual(['@a:hs']);

    openRoom('!b:hs');

    expect(vm.members().map((m) => m.userId)).toEqual(['@b:hs']);
  });
});

describe('RoomShellViewModel rail unread chats', () => {
  const unread = (
    roomId: string,
    accountId = '@me:hs',
    activityTs = 0,
  ): UnreadRoom => ({
    accountId,
    roomId,
    name: roomId,
    initial: 'R',
    avatarMxc: null,
    direct: false,
    unreadCount: 1,
    markedUnread: false,
    activityTs,
  });

  it('lists every account’s unread chats, newest first, without the open one', () => {
    const { vm, unreadRooms, openRoom } = build();
    unreadRooms.set([
      unread('!a:hs', '@me:hs', 1),
      unread('!b:hs', '@ben:hs', 3),
      unread('!open:hs', '@me:hs', 9),
    ]);
    openRoom('!open:hs');

    expect(vm.railUnreadChats().entries.map((e) => e.selection.roomId)).toEqual(
      ['!b:hs', '!a:hs'],
    );
  });

  it('keeps a remembered chat listed while the compact list is showing', () => {
    const { vm, unreadRooms, openRoom, placement } = build();
    unreadRooms.set([unread('!open:hs')]);
    openRoom('!open:hs');
    placement.set('list');

    expect(vm.railUnreadChats().entries).toHaveLength(1);
  });

  it('follows the space rail setting', () => {
    const { vm, unreadRooms, railMode } = build();
    unreadRooms.set([unread('!a:hs')]);
    railMode.set('off');

    expect(vm.railUnreadChats().entries).toEqual([]);
  });

  it('badges every entry in a mixed view', () => {
    const { vm, unreadRooms, mixed } = build();
    unreadRooms.set([
      unread('!a:hs', '@me:hs', 1),
      unread('!b:hs', '@ben:hs', 2),
    ]);
    mixed.set(true);

    expect(vm.railUnreadChats().entries.map((e) => e.accountBadge?.id)).toEqual(
      ['@ben:hs', '@me:hs'],
    );
  });

  it('badges only another account’s entry with one account selected', () => {
    const { vm, unreadRooms } = build();
    unreadRooms.set([
      unread('!a:hs', '@me:hs', 1),
      unread('!b:hs', '@ben:hs', 2),
    ]);

    expect(vm.railUnreadChats().entries.map((e) => e.accountBadge?.id)).toEqual(
      ['@ben:hs', undefined],
    );
  });
});

describe('RoomShellViewModel rail badges', () => {
  const team = spaceSummary({ id: '!s:hs', childRoomIds: ['!c:hs'] });
  const view = (rooms: RoomSummary[]): SelectedRoomLibraryView => ({
    accountIds: new Set(['@me:hs']),
    mode: 'active',
    rooms,
    spaces: [team],
    spaceChildRoomIdsByAccount: new Map([['@me:hs', new Set(['!c:hs'])]]),
    invitations: [],
  });
  const child = (over: Partial<RoomSummary> = {}) =>
    roomSummary({ id: '!c:hs', accountId: '@me:hs', unreadCount: 2, ...over });
  const other = (over: Partial<RoomSummary> = {}) =>
    roomSummary({ id: '!o:hs', accountId: '@me:hs', ...over });

  /** Counts how often a rail computed hands its consumers a new value. */
  function watch(vm: RoomShellViewModel) {
    const seen = { railUnread: 0 };
    TestBed.runInInjectionContext(() =>
      effect(() => {
        vm.railUnread();
        seen.railUnread += 1;
      }),
    );
    TestBed.tick();
    return seen;
  }

  it('keeps every badge object when only an unrelated room’s name changes', () => {
    const { vm, selectedView } = build({
      selectedView: view([child(), other()]),
    });
    const seen = watch(vm);
    const before = [vm.spaceUnread(), vm.spaceMentions(), vm.railUnread()];

    selectedView.set(view([child(), other({ name: 'renamed' })]));
    TestBed.tick();

    expect([vm.spaceUnread(), vm.spaceMentions(), vm.railUnread()]).toEqual(
      before,
    );
    expect(vm.spaceUnread()).toBe(before[0]);
    expect(vm.spaceMentions()).toBe(before[1]);
    expect(vm.railUnread()).toBe(before[2]);
    expect(seen.railUnread).toBe(1);
  });

  it('emits a new badge object when a relevant count changes', () => {
    const { vm, selectedView } = build({ selectedView: view([child()]) });
    const before = vm.railUnread();

    selectedView.set(view([child({ unreadCount: 3, highlightCount: 1 })]));

    expect(vm.spaceUnread()).toEqual({ '!s:hs': 3 });
    expect(vm.spaceMentions()).toEqual({ '!s:hs': 1 });
    expect(vm.railUnread()).not.toBe(before);
    expect(vm.railUnread().perSpace['!s:hs']).toEqual({
      unread: 3,
      mentions: 1,
    });
  });
});
