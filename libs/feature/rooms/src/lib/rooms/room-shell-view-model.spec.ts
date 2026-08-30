import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  type MemberSummary,
  RoomActionPermissionsService,
  RoomMembersService,
} from '@trinity/data-access/room-administration';
import {
  AccountProfilesService,
  type AccountProfile,
} from '@trinity/data-access/profile';
import {
  AccountScopeService,
  MixedRoomsService,
  MixedSpacesService,
  RoomLibraryService,
  SpaceChildrenService,
  SpaceRoomOrderService,
  SpacesService,
  UnreadAggregatorService,
} from '@trinity/data-access/room-library';
import { AccountBadgesService } from '../shared/account-badges.service';
import { RoomShellStore } from './room-shell-store';
import { RoomShellViewModel } from './room-shell-view-model';
import { WorkspaceService } from './workspace.service';

/**
 * The view model's own spec, for the two surfaces it derives from the projections this
 * branch introduced: the account chip (`AccountProfilesService`) and the member list
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
    name,
    initial: name[0],
    avatarMxc: null,
    powerLevel: 0,
    isCreator: false,
  };
}

function profile(
  userId: string,
  displayName: string,
  avatarMxc: string | null = null,
): AccountProfile {
  return { userId, displayName, avatarMxc };
}

function build(opts: { members?: Record<string, MemberSummary[]> } = {}) {
  const profiles = signal<ReadonlyMap<string, AccountProfile>>(new Map());
  const activeUserId = signal<string | null>('@me:hs');
  const accountIds = signal<readonly string[]>(['@me:hs']);
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

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      RoomShellStore,
      RoomShellViewModel,
      MockProvider(RoomLibraryService),
      MockProvider(RoomMembersService, { membersFor }),
      MockProvider(SpacesService),
      MockProvider(SpaceChildrenService),
      MockProvider(RoomActionPermissionsService, {
        room: () => ({
          invite: { available: true, reason: null },
          curateSpace: { available: true, reason: null },
        }),
      }),
      MockProvider(MixedRoomsService),
      MockProvider(MixedSpacesService),
      MockProvider(AccountScopeService),
      MockProvider(SpaceRoomOrderService),
      MockProvider(AccountBadgesService),
      MockProvider(UnreadAggregatorService, {
        unreadByAccount: signal<ReadonlyMap<string, number>>(
          new Map(),
        ).asReadonly(),
      }),
      MockProvider(MatrixClientService, {
        activeUserId: activeUserId.asReadonly(),
        accountIds: accountIds.asReadonly(),
      }),
      {
        provide: WorkspaceService,
        useValue: {
          activeAccountId: activeUserId.asReadonly(),
          activeSpaceId: signal<string | null>(null).asReadonly(),
          activeRoomId: activeRoomId.asReadonly(),
          recentView: signal(true).asReadonly(),
          roomsView: signal(false).asReadonly(),
          pane: signal<'list' | 'conversation'>('list').asReadonly(),
          placement: signal<'list' | 'conversation' | 'split'>(
            'split',
          ).asReadonly(),
        },
      },
      MockProvider(AccountProfilesService, {
        profiles: profiles.asReadonly(),
        profileOf: (userId: string) =>
          profiles().get(userId) ?? profile(userId, userId),
      }),
    ],
  });

  return {
    vm: TestBed.inject(RoomShellViewModel),
    openRoom: (roomId: string) => activeRoomId.set(roomId),
    profiles,
    activeUserId,
    accountIds,
    rosters,
    membersFor,
  };
}

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
