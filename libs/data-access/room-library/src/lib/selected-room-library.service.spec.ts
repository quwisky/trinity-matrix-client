import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountScopeService } from './account-scope.service';
import { InvitesService, type PendingInvite } from './invites.service';
import { MixedInvitesService } from './mixed-invites.service';
import { MixedRoomsService } from './mixed-rooms.service';
import { MixedSpacesService } from './mixed-spaces.service';
import { RoomLibraryService, type RoomSummary } from './room-library.service';
import { SelectedRoomLibraryService } from './selected-room-library.service';
import { SpacesService, type SpaceSummary } from './spaces.service';

const ACTIVE_ROOM = room('!active:hs', '@active:hs');
const MIXED_ROOM = room('!mixed:hs', '@other:hs');
const ACTIVE_SPACE = space('!active-space:hs', '@active:hs');
const MIXED_SPACE = space('!mixed-space:hs', '@other:hs');
const ACTIVE_INVITE = invite('!active-invite:hs', '@active:hs');
const MIXED_INVITE = invite('!mixed-invite:hs', '@other:hs');
const MIXED_CHILDREN = new Map<string, ReadonlySet<string>>([
  ['@other:hs', new Set(['!mixed:hs'])],
]);

function setup(accountIds: ReadonlySet<string>) {
  const selected = signal(accountIds);
  const setSelected = vi.fn<AccountScopeService['setSelected']>(() =>
    of({ kind: 'completed' as const }),
  );
  const toggle = vi.fn<AccountScopeService['toggle']>(() =>
    of({ kind: 'completed' as const }),
  );
  const setRoomAccounts = vi.fn();
  const setSpaceAccounts = vi.fn();
  const setInviteAccounts = vi.fn();

  TestBed.configureTestingModule({
    providers: [
      SelectedRoomLibraryService,
      MockProvider(AccountScopeService, { selected, setSelected, toggle }),
      MockProvider(RoomLibraryService, { rooms: signal([ACTIVE_ROOM]) }),
      MockProvider(SpacesService, { spaces: signal([ACTIVE_SPACE]) }),
      MockProvider(InvitesService, {
        pendingInvites: signal([ACTIVE_INVITE]),
      }),
      MockProvider(MixedRoomsService, {
        rooms: signal([MIXED_ROOM]),
        setAccounts: setRoomAccounts,
      }),
      MockProvider(MixedSpacesService, {
        spaces: signal([MIXED_SPACE]),
        spaceChildRoomIdsByAccount: signal(MIXED_CHILDREN),
        setAccounts: setSpaceAccounts,
      }),
      MockProvider(MixedInvitesService, {
        invites: signal([MIXED_INVITE]),
        setAccounts: setInviteAccounts,
      }),
    ],
  });

  return {
    service: TestBed.inject(SelectedRoomLibraryService),
    selected: selected as WritableSignal<ReadonlySet<string>>,
    setSelected,
    toggle,
    setRoomAccounts,
    setSpaceAccounts,
    setInviteAccounts,
  };
}

describe('SelectedRoomLibraryService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('publishes the effective mixed Account set and all row kinds together', () => {
    const accounts = new Set(['@active:hs', '@other:hs']);
    const harness = setup(accounts);
    TestBed.flushEffects();

    expect(harness.service.view()).toEqual({
      accountIds: accounts,
      mode: 'mixed',
      rooms: [MIXED_ROOM],
      spaces: [MIXED_SPACE],
      spaceChildRoomIdsByAccount: MIXED_CHILDREN,
      invitations: [MIXED_INVITE],
    });
    expect(harness.setRoomAccounts).toHaveBeenCalledWith(accounts);
    expect(harness.setSpaceAccounts).toHaveBeenCalledWith(accounts);
    expect(harness.setInviteAccounts).toHaveBeenCalledWith(accounts);
  });

  it('uses active projections for one Account without reading empty mixed rows', () => {
    const harness = setup(new Set(['@active:hs', '@other:hs']));

    harness.selected.set(new Set(['@active:hs']));
    TestBed.flushEffects();

    expect(harness.service.view()).toMatchObject({
      mode: 'active',
      rooms: [ACTIVE_ROOM],
      spaces: [ACTIVE_SPACE],
      invitations: [ACTIVE_INVITE],
    });
  });

  it('keeps the preceding coherent view until the next selection publishes', () => {
    const harness = setup(new Set(['@active:hs']));
    const mixedAccounts = new Set(['@active:hs', '@other:hs']);

    harness.selected.set(mixedAccounts);

    expect(harness.service.view()).toMatchObject({
      accountIds: new Set(['@active:hs']),
      mode: 'active',
      rooms: [ACTIVE_ROOM],
    });

    TestBed.flushEffects();
    expect(harness.service.view()).toEqual({
      accountIds: mixedAccounts,
      mode: 'mixed',
      rooms: [MIXED_ROOM],
      spaces: [MIXED_SPACE],
      spaceChildRoomIdsByAccount: MIXED_CHILDREN,
      invitations: [MIXED_INVITE],
    });
  });

  it('keeps selection commands cold and returns typed unavailable recovery', async () => {
    const harness = setup(new Set(['@active:hs']));
    harness.setSelected.mockReturnValue(
      of({
        kind: 'unavailable',
        recovery: 'retry-storage',
        diagnostic: { code: 'preference-storage-write-failed' },
      }),
    );

    const command = harness.service.setAccountSelected('@other:hs', 'included');
    expect(harness.setSelected).not.toHaveBeenCalled();

    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'unavailable',
      recovery: 'retry-storage',
      diagnostic: { code: 'preference-storage-write-failed' },
    });
    expect(harness.setSelected).toHaveBeenCalledWith('@other:hs', true);
    expect(harness.service.view().accountIds).toEqual(new Set(['@active:hs']));
  });

  it('delegates toggle only on subscription', async () => {
    const harness = setup(new Set(['@active:hs']));
    const command = harness.service.toggleAccount('@other:hs');

    expect(harness.toggle).not.toHaveBeenCalled();
    await firstValueFrom(command);
    expect(harness.toggle).toHaveBeenCalledWith('@other:hs');
  });
});

function room(id: string, accountId: string): RoomSummary {
  return {
    id,
    accountId,
    accountIds: [accountId],
    name: id,
    initial: 'R',
    avatarMxc: null,
    topic: '',
    memberCount: 0,
    encrypted: false,
    unreadCount: 0,
    highlightCount: 0,
    hasUnread: false,
    markedUnread: false,
    lastMessage: '',
    activityTs: 0,
    favourite: false,
    lowPriority: false,
  };
}

function space(id: string, accountId: string): SpaceSummary {
  return {
    id,
    accountId,
    name: id,
    initial: 'S',
    avatarMxc: null,
    childRoomIds: [],
  };
}

function invite(roomId: string, accountId: string): PendingInvite {
  return {
    roomId,
    accountId,
    name: roomId,
    initial: 'I',
    avatarMxc: null,
    inviterName: 'Inviter',
    isSpace: false,
    isDirect: false,
  };
}
