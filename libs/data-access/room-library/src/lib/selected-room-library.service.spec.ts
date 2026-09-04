import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  NotificationCountType,
  RoomEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { AccountScopeService } from './account-scope.service';
import { InvitesService, type PendingInvite } from './invites.service';
import { RoomLibraryService, type RoomSummary } from './room-library.service';
import { SelectedRoomLibraryService } from './selected-room-library.service';
import { SpacesService, type SpaceSummary } from './spaces.service';

type Listener = (...args: unknown[]) => void;

interface FakeRoomOptions {
  readonly kind?: 'room' | 'space' | 'invite';
  readonly name?: string;
  readonly children?: readonly string[];
  readonly unread?: number;
  readonly highlight?: number;
  readonly markedUnread?: boolean;
  readonly favourite?: boolean;
  readonly lowPriority?: boolean;
}

function fakeRoom(id: string, options: FakeRoomOptions = {}) {
  const kind = options.kind ?? 'room';
  return {
    roomId: id,
    name: options.name ?? id,
    isSpaceRoom: () => kind === 'space',
    getMyMembership: () => (kind === 'invite' ? 'invite' : 'join'),
    getMxcAvatarUrl: () => null,
    getAvatarFallbackMember: () => undefined,
    getJoinedMemberCount: () => 1,
    hasEncryptionStateEvent: () => false,
    getAccountData: (type: string) =>
      options.markedUnread && type === 'm.marked_unread'
        ? { getContent: () => ({ unread: true }) }
        : undefined,
    getUnreadNotificationCount: (type?: unknown) =>
      type === NotificationCountType.Highlight
        ? (options.highlight ?? 0)
        : (options.unread ?? 0),
    getLastActiveTimestamp: () => 0,
    getLiveTimeline: () => ({
      getEvents: () => [],
      getState: () => ({
        getStateEvents: (type: string, stateKey?: string) =>
          type === 'm.space.child'
            ? (options.children ?? []).map((childId) => ({
                getStateKey: () => childId,
                getContent: () => ({ via: ['hs'] }),
              }))
            : stateKey === undefined
              ? []
              : undefined,
      }),
    }),
    tags: {
      ...(options.favourite ? { 'm.favourite': {} } : {}),
      ...(options.lowPriority ? { 'm.lowpriority': {} } : {}),
    },
    getMember: (userId: string) =>
      userId.startsWith('@inviter')
        ? { name: 'Inviter' }
        : {
            name: userId,
            events: {
              member: {
                getSender: () => '@inviter:hs',
                getContent: () => ({ is_direct: false }),
              },
            },
          },
  };
}

function fakeClient(
  userId: string,
  rooms: ReturnType<typeof fakeRoom>[],
  directRoomIds: readonly string[] = [],
) {
  const handlers = new Map<string, Set<Listener>>();
  const getRooms = vi.fn(() => rooms);
  let attachmentCount = 0;
  let detachmentCount = 0;
  return {
    getUserId: () => userId,
    getRooms,
    getRoom: (roomId: string) =>
      rooms.find((room) => room.roomId === roomId) ?? {
        roomId,
        name: roomId,
        getMyMembership: () => 'join',
      },
    getAccountData: (type: string) =>
      type === 'm.direct'
        ? { getContent: () => ({ '@peer:hs': directRoomIds }) }
        : undefined,
    on(event: string, handler: Listener) {
      attachmentCount++;
      (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(
        handler,
      );
    },
    off(event: string, handler: Listener) {
      if (handlers.get(event)?.delete(handler)) detachmentCount++;
    },
    emit(event: string) {
      handlers.get(event)?.forEach((handler) => handler());
    },
    listenerCount(event?: string) {
      if (event) return handlers.get(event)?.size ?? 0;
      return [...handlers.values()].reduce((sum, set) => sum + set.size, 0);
    },
    attachmentCount: () => attachmentCount,
    detachmentCount: () => detachmentCount,
  };
}

type FakeClient = ReturnType<typeof fakeClient>;

const ACTIVE_ROOM = roomSummary('!active:hs', '@active:hs');
const ACTIVE_SPACE = spaceSummary('!active-space:hs', '@active:hs');
const ACTIVE_INVITE = inviteSummary('!active-invite:hs', '@active:hs');

function setup(
  options: {
    selected?: ReadonlySet<string>;
    live?: readonly string[];
    active?: string | null;
    clients?: ReadonlyMap<string, FakeClient>;
  } = {},
) {
  const selected = signal<ReadonlySet<string>>(
    options.selected ?? new Set(['@active:hs']),
  );
  const accountIds = signal<readonly string[]>(options.live ?? ['@active:hs']);
  const activeUserId = signal<string | null>(
    options.active === undefined ? '@active:hs' : options.active,
  );
  const clients = new Map(options.clients ?? []);
  const setSelected = vi.fn<AccountScopeService['setSelected']>(() =>
    of({ kind: 'completed' as const }),
  );
  const toggle = vi.fn<AccountScopeService['toggle']>(() =>
    of({ kind: 'completed' as const }),
  );
  const matrix = {
    accountIds: accountIds.asReadonly(),
    activeUserId: activeUserId.asReadonly(),
    clientFor: (accountId: string) =>
      (clients.get(accountId) as unknown as MatrixClient | undefined) ?? null,
  } as unknown as MatrixClientService;

  TestBed.configureTestingModule({
    providers: [
      SelectedRoomLibraryService,
      { provide: MatrixClientService, useValue: matrix },
      MockProvider(AccountScopeService, { selected, setSelected, toggle }),
      MockProvider(RoomLibraryService, { rooms: signal([ACTIVE_ROOM]) }),
      MockProvider(SpacesService, { spaces: signal([ACTIVE_SPACE]) }),
      MockProvider(InvitesService, {
        pendingInvites: signal([ACTIVE_INVITE]),
      }),
    ],
  });

  return {
    service: TestBed.inject(SelectedRoomLibraryService),
    selected: selected as WritableSignal<ReadonlySet<string>>,
    accountIds,
    activeUserId,
    clients,
    setSelected,
    toggle,
  };
}

async function flushProjection(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('SelectedRoomLibraryService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('delegates one Account to active projections without duplicate listeners', () => {
    const client = fakeClient('@active:hs', [fakeRoom('!sdk:hs')]);
    const harness = setup({
      clients: new Map([['@active:hs', client]]),
    });

    expect(harness.service.view()).toEqual({
      accountIds: new Set(['@active:hs']),
      mode: 'active',
      rooms: [ACTIVE_ROOM],
      spaces: [ACTIVE_SPACE],
      spaceChildRoomIdsByAccount: new Map([['@active:hs', new Set<string>()]]),
      invitations: [ACTIVE_INVITE],
    });
    expect(client.listenerCount()).toBe(0);
  });

  it('publishes one mixed generation with exact Room, Space, and invite policy', () => {
    const a = fakeClient('@a:hs', [
      fakeRoom('!shared:hs'),
      fakeRoom('!space:hs', { kind: 'space', children: ['!x:hs'] }),
      fakeRoom('!invite-a:hs', { kind: 'invite', name: 'Alpha' }),
    ]);
    const b = fakeClient('@b:hs', [
      fakeRoom('!shared:hs', {
        unread: 3,
        highlight: 2,
        markedUnread: true,
        lowPriority: true,
      }),
      fakeRoom('!other:hs'),
      fakeRoom('!space:hs', {
        kind: 'space',
        children: ['!x:hs', '!y:hs'],
      }),
      fakeRoom('!invite-b:hs', { kind: 'invite', name: 'Bravo' }),
    ]);
    const accounts = new Set(['@a:hs', '@b:hs']);
    const harness = setup({
      selected: accounts,
      live: [...accounts],
      active: '@a:hs',
      clients: new Map([
        ['@a:hs', a],
        ['@b:hs', b],
      ]),
    });

    const view = harness.service.view();
    expect(view.accountIds).toBe(accounts);
    expect(view.mode).toBe('mixed');
    expect(view.rooms.map((item) => item.id).sort()).toEqual([
      '!other:hs',
      '!shared:hs',
    ]);
    expect(view.rooms.find((item) => item.id === '!shared:hs')).toMatchObject({
      accountId: '@a:hs',
      accountIds: ['@a:hs', '@b:hs'],
      unreadCount: 3,
      highlightCount: 2,
      markedUnread: true,
      hasUnread: true,
      lowPriority: true,
    });
    expect(view.spaces).toEqual([
      expect.objectContaining({
        id: '!space:hs',
        accountId: '@a:hs',
        childRoomIds: ['!x:hs', '!y:hs'],
      }),
    ]);
    expect(view.spaceChildRoomIdsByAccount).toEqual(
      new Map([
        ['@a:hs', new Set(['!x:hs'])],
        ['@b:hs', new Set(['!x:hs', '!y:hs'])],
      ]),
    );
    expect(
      view.invitations.map((item) => [item.roomId, item.accountId]),
    ).toEqual([
      ['!invite-a:hs', '@a:hs'],
      ['!invite-b:hs', '@b:hs'],
    ]);
    // Shared SDK events have one listener, rather than one per domain projector.
    expect(a.listenerCount('Room')).toBe(1);
    expect(a.listenerCount()).toBe(9);
  });

  it('ignores unselected live Accounts and gives them no listeners', () => {
    const a = fakeClient('@a:hs', [fakeRoom('!a:hs')]);
    const b = fakeClient('@b:hs', [fakeRoom('!b:hs')]);
    const c = fakeClient('@c:hs', [fakeRoom('!c:hs')]);
    const harness = setup({
      selected: new Set(['@a:hs', '@b:hs']),
      live: ['@a:hs', '@b:hs', '@c:hs'],
      clients: new Map([
        ['@a:hs', a],
        ['@b:hs', b],
        ['@c:hs', c],
      ]),
    });

    expect(
      harness.service
        .view()
        .rooms.map((item) => item.id)
        .sort(),
    ).toEqual(['!a:hs', '!b:hs']);
    expect(c.listenerCount()).toBe(0);
  });

  it('keeps invitations Account-scoped even when their Room ids match', () => {
    const a = fakeClient('@a:hs', [
      fakeRoom('!invite:hs', { kind: 'invite', name: 'Shared' }),
    ]);
    const b = fakeClient('@b:hs', [
      fakeRoom('!invite:hs', { kind: 'invite', name: 'Shared' }),
    ]);
    const harness = setup({
      selected: new Set(['@a:hs', '@b:hs']),
      live: ['@a:hs', '@b:hs'],
      clients: new Map([
        ['@a:hs', a],
        ['@b:hs', b],
      ]),
    });

    expect(
      harness.service.view().invitations.map((invite) => invite.accountId),
    ).toEqual(['@a:hs', '@b:hs']);
  });

  it('uses stable fallback ownership and each Account’s direct map', () => {
    const a = fakeClient(
      '@a:hs',
      [fakeRoom('!shared:hs'), fakeRoom('!dm:hs', { favourite: true })],
      ['!dm:hs'],
    );
    const b = fakeClient('@b:hs', [fakeRoom('!shared:hs')]);
    const harness = setup({
      selected: new Set(['@b:hs', '@a:hs']),
      live: ['@a:hs', '@b:hs'],
      active: null,
      clients: new Map([
        ['@a:hs', a],
        ['@b:hs', b],
      ]),
    });

    expect(harness.service.view().rooms.map((item) => item.id)).toEqual([
      '!dm:hs',
      '!shared:hs',
    ]);
    expect(harness.service.view().rooms[0].directUserId).toBe('@peer:hs');
    expect(harness.service.view().rooms[1].accountId).toBe('@a:hs');
  });

  it('coalesces domain events and structurally shares unaffected projections', async () => {
    const a = fakeClient('@a:hs', [fakeRoom('!a:hs')]);
    const b = fakeClient('@b:hs', [fakeRoom('!b:hs')]);
    const harness = setup({
      selected: new Set(['@a:hs', '@b:hs']),
      live: ['@a:hs', '@b:hs'],
      clients: new Map([
        ['@a:hs', a],
        ['@b:hs', b],
      ]),
    });
    const before = harness.service.view();
    a.getRooms.mockClear();

    a.emit(RoomEvent.Receipt);
    a.emit(RoomEvent.Receipt);
    a.emit(RoomEvent.Receipt);
    await flushProjection();

    const after = harness.service.view();
    expect(a.getRooms).toHaveBeenCalledOnce();
    expect(after.rooms).not.toBe(before.rooms);
    expect(after.spaces).toBe(before.spaces);
    expect(after.spaceChildRoomIdsByAccount).toBe(
      before.spaceChildRoomIdsByAccount,
    );
    expect(after.invitations).toBe(before.invitations);
  });

  it('reconciles live Accounts and same-id client replacement', async () => {
    const first = fakeClient('@a:hs', [fakeRoom('!a:hs')]);
    const b = fakeClient('@b:hs', [fakeRoom('!b:hs')]);
    const harness = setup({
      selected: new Set(['@a:hs', '@b:hs']),
      live: ['@a:hs', '@b:hs'],
      clients: new Map([
        ['@a:hs', first],
        ['@b:hs', b],
      ]),
    });
    const replacement = fakeClient('@a:hs', [fakeRoom('!a2:hs')]);
    harness.clients.set('@a:hs', replacement);

    b.emit('Room');
    await flushProjection();

    expect(first.listenerCount()).toBe(0);
    expect(replacement.listenerCount()).toBe(9);
    expect(
      harness.service
        .view()
        .rooms.map((item) => item.id)
        .sort(),
    ).toEqual(['!a2:hs', '!b:hs']);

    harness.clients.delete('@a:hs');
    harness.accountIds.set(['@b:hs']);
    TestBed.tick();
    expect(replacement.listenerCount()).toBe(0);
    expect(harness.service.view().rooms.map((item) => item.id)).toEqual([
      '!b:hs',
    ]);
  });

  it('re-attributes shared rows when the Active Account changes', () => {
    const a = fakeClient('@a:hs', [
      fakeRoom('!shared:hs'),
      fakeRoom('!space:hs', { kind: 'space' }),
    ]);
    const b = fakeClient('@b:hs', [
      fakeRoom('!shared:hs'),
      fakeRoom('!space:hs', { kind: 'space' }),
    ]);
    const harness = setup({
      selected: new Set(['@a:hs', '@b:hs']),
      live: ['@a:hs', '@b:hs'],
      active: '@a:hs',
      clients: new Map([
        ['@a:hs', a],
        ['@b:hs', b],
      ]),
    });
    expect(harness.service.view().rooms[0].accountId).toBe('@a:hs');
    expect(harness.service.view().spaces[0].accountId).toBe('@a:hs');

    harness.activeUserId.set('@b:hs');
    TestBed.tick();

    expect(harness.service.view().rooms[0].accountId).toBe('@b:hs');
    expect(harness.service.view().spaces[0].accountId).toBe('@b:hs');
  });

  it('does not churn listeners for an equal selected Account set', () => {
    const a = fakeClient('@a:hs', [fakeRoom('!a:hs')]);
    const b = fakeClient('@b:hs', [fakeRoom('!b:hs')]);
    const harness = setup({
      selected: new Set(['@a:hs', '@b:hs']),
      live: ['@a:hs', '@b:hs'],
      clients: new Map([
        ['@a:hs', a],
        ['@b:hs', b],
      ]),
    });

    harness.selected.set(new Set(['@b:hs', '@a:hs']));
    TestBed.tick();

    expect(a.attachmentCount()).toBe(9);
    expect(a.detachmentCount()).toBe(0);
    expect(a.listenerCount()).toBe(9);
  });

  it('detaches selected sources before returning to one active Account', () => {
    const a = fakeClient('@a:hs', [fakeRoom('!a:hs')]);
    const b = fakeClient('@b:hs', [fakeRoom('!b:hs')]);
    const harness = setup({
      selected: new Set(['@a:hs', '@b:hs']),
      live: ['@a:hs', '@b:hs'],
      clients: new Map([
        ['@a:hs', a],
        ['@b:hs', b],
      ]),
    });
    expect(a.listenerCount()).toBe(9);

    harness.selected.set(new Set(['@a:hs']));
    TestBed.tick();

    expect(harness.service.view()).toMatchObject({
      mode: 'active',
      rooms: [ACTIVE_ROOM],
      spaces: [ACTIVE_SPACE],
      invitations: [ACTIVE_INVITE],
    });
    expect(a.listenerCount()).toBe(0);
    expect(b.listenerCount()).toBe(0);
  });

  it('cancels a queued projection before detaching on destruction', async () => {
    const a = fakeClient('@a:hs', [fakeRoom('!a:hs')]);
    const b = fakeClient('@b:hs', [fakeRoom('!b:hs')]);
    setup({
      selected: new Set(['@a:hs', '@b:hs']),
      live: ['@a:hs', '@b:hs'],
      clients: new Map([
        ['@a:hs', a],
        ['@b:hs', b],
      ]),
    });
    a.emit(RoomEvent.Receipt);

    TestBed.resetTestingModule();
    await flushProjection();

    expect(a.listenerCount()).toBe(0);
    expect(b.listenerCount()).toBe(0);
    expect(a.attachmentCount()).toBe(9);
    expect(a.detachmentCount()).toBe(9);
  });

  it('keeps selection commands cold and returns typed unavailable recovery', async () => {
    const harness = setup();
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
    const harness = setup();
    const command = harness.service.toggleAccount('@other:hs');

    expect(harness.toggle).not.toHaveBeenCalled();
    await firstValueFrom(command);
    expect(harness.toggle).toHaveBeenCalledWith('@other:hs');
  });
});

function roomSummary(id: string, accountId: string): RoomSummary {
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

function spaceSummary(id: string, accountId: string): SpaceSummary {
  return {
    id,
    accountId,
    name: id,
    initial: 'S',
    avatarMxc: null,
    childRoomIds: [],
  };
}

function inviteSummary(roomId: string, accountId: string): PendingInvite {
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
