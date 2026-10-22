import { computed, signal, type WritableSignal } from '@angular/core';
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
  /** Overrides the membership `kind` implies, e.g. a space the Account has left. */
  readonly membership?: 'join' | 'invite' | 'leave';
  readonly name?: string;
  readonly children?: readonly string[];
  readonly unread?: number;
  readonly highlight?: number;
  readonly markedUnread?: boolean;
  readonly favourite?: boolean;
  readonly lowPriority?: boolean;
  /** The body of a last message that arrived in clear. */
  readonly message?: string;
}

function fakeRoom(id: string, options: FakeRoomOptions = {}) {
  const kind = options.kind ?? 'room';
  return {
    roomId: id,
    name: options.name ?? id,
    isSpaceRoom: () => kind === 'space',
    getMyMembership: () =>
      options.membership ?? (kind === 'invite' ? 'invite' : 'join'),
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
      getEvents: () =>
        options.message === undefined
          ? []
          : [
              {
                getType: () => 'm.room.message',
                getTs: () => 1,
                getContent: () => ({ body: options.message }),
                getOriginalContent: () => ({ body: options.message }),
                isRedacted: () => false,
                isDecryptionFailure: () => false,
                isEncrypted: () => false,
                isState: () => false,
                replacingEvent: () => null,
                status: null,
              },
            ],
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
        isSpaceRoom: () => false,
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
    /** Accounts whose client has synced with its homeserver; every live one unless named. */
    synced?: ReadonlySet<string>;
    /** Accounts whose client has prepared its rooms, from cache or server; every live one. */
    prepared?: ReadonlySet<string>;
    connect?: boolean;
  } = {},
) {
  const selected = signal<ReadonlySet<string>>(
    options.selected ?? new Set(['@active:hs']),
  );
  const accountIds = signal<readonly string[]>(options.live ?? ['@active:hs']);
  const synced = signal<ReadonlySet<string>>(
    options.synced ?? new Set(accountIds()),
  );
  const prepared = signal<ReadonlySet<string>>(
    options.prepared ?? new Set(accountIds()),
  );
  const activeSpaces = signal<SpaceSummary[]>([ACTIVE_SPACE]);
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
    serverSynced: (accountId: string) => synced().has(accountId),
    roomsPrepared: (accountId: string) => prepared().has(accountId),
  } as unknown as MatrixClientService;

  TestBed.configureTestingModule({
    providers: [
      SelectedRoomLibraryService,
      { provide: MatrixClientService, useValue: matrix },
      MockProvider(AccountScopeService, { selected, setSelected, toggle }),
      MockProvider(RoomLibraryService, { rooms: signal([ACTIVE_ROOM]) }),
      MockProvider(SpacesService, { spaces: activeSpaces }),
      MockProvider(InvitesService, {
        pendingInvites: signal([ACTIVE_INVITE]),
      }),
    ],
  });

  const service = TestBed.inject(SelectedRoomLibraryService);
  const lifetime =
    options.connect !== false ? service.runProjection().subscribe() : null;
  return {
    service,
    selected: selected as WritableSignal<ReadonlySet<string>>,
    accountIds,
    synced,
    prepared,
    activeSpaces,
    activeUserId,
    clients,
    setSelected,
    toggle,
    lifetime,
  };
}

async function flushProjection(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('SelectedRoomLibraryService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('attaches only for its owned lifetime and reconnects from empty state', () => {
    const a = fakeClient('@a:hs', [fakeRoom('!a:hs')]);
    const b = fakeClient('@b:hs', [fakeRoom('!b:hs')]);
    const harness = setup({
      selected: new Set(['@a:hs', '@b:hs']),
      live: ['@a:hs', '@b:hs'],
      clients: new Map([
        ['@a:hs', a],
        ['@b:hs', b],
      ]),
      connect: false,
    });

    expect(harness.service.view()).toMatchObject({
      mode: 'active',
      rooms: [ACTIVE_ROOM],
      spaces: [ACTIVE_SPACE],
      invitations: [ACTIVE_INVITE],
    });
    expect(a.listenerCount()).toBe(0);
    expect(b.listenerCount()).toBe(0);

    const lifetime = harness.service.runProjection().subscribe();
    expect(a.listenerCount()).toBe(9);
    expect(b.listenerCount()).toBe(9);

    lifetime.unsubscribe();
    expect(a.listenerCount()).toBe(0);
    expect(b.listenerCount()).toBe(0);
    expect(harness.service.view()).toMatchObject({
      mode: 'mixed',
      rooms: [],
      spaces: [],
      invitations: [],
    });

    harness.service.runProjection().subscribe();
    expect(a.listenerCount()).toBe(9);
    expect(b.listenerCount()).toBe(9);
    expect(a.attachmentCount()).toBe(18);
  });

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

  it('locks a mixed-list room the crypto store of its Account has as encrypted when its state lacks the event', async () => {
    const a = fakeClient('@a:hs', [fakeRoom('!a:hs')]);
    const b = Object.assign(fakeClient('@b:hs', [fakeRoom('!b:hs')]), {
      getCrypto: () => ({
        isEncryptionEnabledInRoom: (roomId: string) =>
          Promise.resolve(roomId === '!b:hs'),
      }),
    });
    const harness = setup({
      selected: new Set(['@a:hs', '@b:hs']),
      live: ['@a:hs', '@b:hs'],
      clients: new Map([
        ['@a:hs', a],
        ['@b:hs', b],
      ]),
    });
    const lock = (id: string) =>
      harness.service.view().rooms.find((room) => room.id === id)?.encrypted;

    await vi.waitFor(() => expect(lock('!b:hs')).toBe(true));
    expect(lock('!a:hs')).toBe(false);
  });

  it("previews each Account's rooms by its own crypto store's answer", async () => {
    const store = (encrypted: readonly string[]) => ({
      getCrypto: () => ({
        isEncryptionEnabledInRoom: async (roomId: string) =>
          encrypted.includes(roomId),
      }),
    });
    const a = Object.assign(
      fakeClient('@a:hs', [fakeRoom('!stored:hs', { message: 'hello' })]),
      store(['!stored:hs']),
    );
    const b = Object.assign(
      fakeClient('@b:hs', [fakeRoom('!plain:hs', { message: 'hello' })]),
      store([]),
    );
    const harness = setup({
      selected: new Set(['@a:hs', '@b:hs']),
      live: ['@a:hs', '@b:hs'],
      clients: new Map([
        ['@a:hs', a],
        ['@b:hs', b],
      ]),
    });
    const room = (id: string) =>
      harness.service.view().rooms.find((r) => r.id === id);

    await vi.waitFor(() => {
      expect(room('!plain:hs')?.lastMessage).toBe('hello');
      expect(room('!stored:hs')?.lastMessage).toBe('hello');
      expect(room('!stored:hs')?.lastMessageMark).toBe('unencrypted');
    });
    expect(room('!plain:hs')?.encrypted).toBe(false);
    expect(room('!stored:hs')?.encrypted).toBe(true);
  });

  it('marks a shared room shown as encrypted though the winning Account has it unencrypted', async () => {
    const store = (encrypted: boolean) => ({
      getCrypto: () => ({
        isEncryptionEnabledInRoom: async () => encrypted,
      }),
    });
    const a = Object.assign(
      fakeClient('@a:hs', [fakeRoom('!shared:hs', { message: 'hello' })]),
      store(false),
    );
    const b = Object.assign(
      fakeClient('@b:hs', [fakeRoom('!shared:hs', { message: 'hello' })]),
      store(true),
    );
    const harness = setup({
      selected: new Set(['@a:hs', '@b:hs']),
      live: ['@a:hs', '@b:hs'],
      clients: new Map([
        ['@a:hs', a],
        ['@b:hs', b],
      ]),
    });
    const shared = () =>
      harness.service.view().rooms.find((r) => r.id === '!shared:hs');

    await vi.waitFor(() => expect(shared()?.encrypted).toBe(true));
    expect(shared()?.accountId).toBe('@a:hs');
    expect(shared()?.lastMessage).toBe('hello');
    expect(shared()?.lastMessageMark).toBe('unencrypted');
  });

  it('takes favourite from the winning Account copy', () => {
    const a = fakeClient('@a:hs', [fakeRoom('!shared:hs')]);
    const b = fakeClient('@b:hs', [
      fakeRoom('!shared:hs', { favourite: true }),
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

    expect(harness.service.view().rooms[0]?.favourite).toBe(false);

    harness.activeUserId.set('@b:hs');
    TestBed.tick();

    expect(harness.service.view().rooms[0]?.favourite).toBe(true);
  });

  it('refreshes marked-unread state after room account data changes', async () => {
    const room = fakeRoom('!room:hs');
    const a = fakeClient('@a:hs', [room]);
    const b = fakeClient('@b:hs', [fakeRoom('!other:hs')]);
    const harness = setup({
      selected: new Set(['@a:hs', '@b:hs']),
      live: ['@a:hs', '@b:hs'],
      active: '@a:hs',
      clients: new Map([
        ['@a:hs', a],
        ['@b:hs', b],
      ]),
    });
    expect(
      harness.service.view().rooms.find((item) => item.id === '!room:hs')
        ?.markedUnread,
    ).toBe(false);

    room.getAccountData = (type: string) =>
      type === 'm.marked_unread'
        ? { getContent: () => ({ unread: true }) }
        : undefined;
    a.emit(RoomEvent.AccountData);
    await flushProjection();

    expect(
      harness.service.view().rooms.find((item) => item.id === '!room:hs')
        ?.markedUnread,
    ).toBe(true);
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

  describe('spaceAvailability', () => {
    // A holds the space; B has joined only a room that space lists.
    const mixed = (
      selected: readonly string[],
      synced: readonly string[] = ['@a:hs', '@b:hs', '@c:hs'],
      prepared: readonly string[] = ['@a:hs', '@b:hs', '@c:hs'],
      live: readonly string[] = ['@a:hs', '@b:hs', '@c:hs'],
    ) =>
      setup({
        selected: new Set(selected),
        live,
        synced: new Set(synced),
        prepared: new Set(prepared),
        active: '@b:hs',
        clients: new Map([
          [
            '@a:hs',
            fakeClient('@a:hs', [fakeRoom('!s:hs', { kind: 'space' })]),
          ],
          ['@b:hs', fakeClient('@b:hs', [fakeRoom('!r:hs')])],
          ['@c:hs', fakeClient('@c:hs', [fakeRoom('!c:hs')])],
        ]),
      }).service;

    it('makes a space the Account itself has joined available', () => {
      expect(mixed(['@b:hs']).spaceAvailability('@a:hs', '!s:hs')).toBe(
        'available',
      );
    });

    it('makes a space another selected Account has joined available, in the mixed view', () => {
      expect(
        mixed(['@a:hs', '@b:hs']).spaceAvailability('@b:hs', '!s:hs'),
      ).toBe('available');
    });

    it('leaves a space it does not hold unconfirmed until the Account syncs with its homeserver', () => {
      // Only a cache replay so far: the space may have been joined since that was saved.
      expect(
        mixed(['@b:hs'], ['@a:hs', '@c:hs']).spaceAvailability(
          '@b:hs',
          '!s:hs',
        ),
      ).toBe('unconfirmed');
    });

    it('makes it unavailable once the Account has synced without it', () => {
      expect(mixed(['@b:hs']).spaceAvailability('@b:hs', '!s:hs')).toBe(
        'unavailable',
      );
    });

    it('stays unconfirmed in the mixed view while another selected Account has not loaded even its cache', () => {
      expect(
        mixed(['@b:hs', '@c:hs'], ['@b:hs'], ['@b:hs']).spaceAvailability(
          '@b:hs',
          '!s:hs',
        ),
      ).toBe('unconfirmed');
    });

    // An offline Account lives on its cache; waiting for its homeserver would keep a space
    // it does not hold "Loading…" for as long as the server is unreachable.
    it('makes it unavailable once another selected Account has replayed its cache without it', () => {
      expect(
        mixed(
          ['@b:hs', '@c:hs'],
          ['@b:hs'],
          ['@b:hs', '@c:hs'],
        ).spaceAvailability('@b:hs', '!s:hs'),
      ).toBe('unavailable');
    });

    it('keeps the acting Account unconfirmed until its own server sync, whatever the others have', () => {
      expect(
        mixed(
          ['@b:hs', '@c:hs'],
          ['@c:hs'],
          ['@b:hs', '@c:hs'],
        ).spaceAvailability('@b:hs', '!s:hs'),
      ).toBe('unconfirmed');
    });

    // A selected Account that failed to start lists none of its rooms either.
    it('does not count a space held by a selected Account whose client is not live', () => {
      expect(
        mixed(
          ['@a:hs', '@b:hs'],
          ['@b:hs'],
          ['@b:hs'],
          ['@b:hs', '@c:hs'],
        ).spaceAvailability('@b:hs', '!s:hs'),
      ).toBe('unavailable');
    });

    it('makes it unavailable once the Account holding it is no longer selected', () => {
      expect(
        mixed(['@b:hs', '@c:hs']).spaceAvailability('@b:hs', '!s:hs'),
      ).toBe('unavailable');
    });

    it('makes it unavailable for an Account outside the mixed view', () => {
      expect(
        mixed(['@a:hs', '@b:hs']).spaceAvailability('@c:hs', '!s:hs'),
      ).toBe('unavailable');
    });

    it('makes it unavailable outside the mixed view, where only the Account itself counts', () => {
      expect(mixed(['@b:hs']).spaceAvailability('@b:hs', '!s:hs')).toBe(
        'unavailable',
      );
    });

    it('makes it unavailable for an Account whose client is not live, or a malformed id', () => {
      const service = mixed(['@a:hs', '@b:hs'], []);

      expect(service.spaceAvailability('@gone:hs', '!s:hs')).toBe(
        'unavailable',
      );
      expect(service.spaceAvailability('@a:hs', '#alias:hs')).toBe(
        'unavailable',
      );
    });

    // The SDK keeps a left or kicked room in its store, with a `leave` membership.
    it('makes a space the Account has left unavailable, though its client still stores it', () => {
      const service = setup({
        selected: new Set(['@a:hs', '@b:hs']),
        live: ['@a:hs', '@b:hs'],
        active: '@a:hs',
        clients: new Map([
          [
            '@a:hs',
            fakeClient('@a:hs', [
              fakeRoom('!s:hs', { kind: 'space', membership: 'leave' }),
            ]),
          ],
          [
            '@b:hs',
            fakeClient('@b:hs', [
              fakeRoom('!s:hs', { kind: 'space', membership: 'leave' }),
            ]),
          ],
        ]),
      }).service;

      expect(service.spaceAvailability('@a:hs', '!s:hs')).toBe('unavailable');
      expect(service.spaceAvailability('@b:hs', '!s:hs')).toBe('unavailable');
    });

    // An accepted invitation keeps `invite` until the join syncs; the flows that open a
    // space they just joined wait for the join (RoomReadinessService) instead.
    it('does not count a space the Account is only invited to', () => {
      const service = setup({
        clients: new Map([
          [
            '@active:hs',
            fakeClient('@active:hs', [fakeRoom('!s:hs', { kind: 'invite' })]),
          ],
        ]),
      }).service;

      expect(service.spaceAvailability('@active:hs', '!s:hs')).toBe(
        'unavailable',
      );
    });

    it("does not count another selected Account's invitation", () => {
      const service = setup({
        selected: new Set(['@a:hs', '@b:hs']),
        live: ['@a:hs', '@b:hs'],
        active: '@b:hs',
        clients: new Map([
          [
            '@a:hs',
            fakeClient('@a:hs', [
              fakeRoom('!s:hs', { kind: 'space', membership: 'invite' }),
            ]),
          ],
          ['@b:hs', fakeClient('@b:hs', [fakeRoom('!r:hs')])],
        ]),
      }).service;

      expect(service.spaceAvailability('@b:hs', '!s:hs')).toBe('unavailable');
    });

    it('does not count a room that is not a joined space', () => {
      expect(
        mixed(['@a:hs', '@b:hs']).spaceAvailability('@a:hs', '!r:hs'),
      ).toBe('unavailable');
    });

    describe('as a reactive read', () => {
      it('follows a membership change of a selected Account in the mixed view', async () => {
        const space = fakeRoom('!s:hs', { kind: 'space' });
        const a = fakeClient('@a:hs', [space]);
        const harness = setup({
          selected: new Set(['@a:hs', '@b:hs']),
          live: ['@a:hs', '@b:hs'],
          active: '@b:hs',
          clients: new Map([
            ['@a:hs', a],
            ['@b:hs', fakeClient('@b:hs', [fakeRoom('!r:hs')])],
          ]),
        });
        const availability = TestBed.runInInjectionContext(() =>
          computed(() => harness.service.spaceAvailability('@b:hs', '!s:hs')),
        );
        expect(availability()).toBe('available');

        space.getMyMembership = () => 'leave';
        a.emit(RoomEvent.MyMembership);
        await flushProjection();

        expect(availability()).toBe('unavailable');
      });

      it("follows the active Account's spaces in the single-Account view", () => {
        const space = fakeRoom('!s:hs', { kind: 'space' });
        const harness = setup({
          clients: new Map([['@active:hs', fakeClient('@active:hs', [space])]]),
        });
        const availability = TestBed.runInInjectionContext(() =>
          computed(() =>
            harness.service.spaceAvailability('@active:hs', '!s:hs'),
          ),
        );
        expect(availability()).toBe('available');

        space.getMyMembership = () => 'leave';
        harness.activeSpaces.set([]);
        TestBed.tick();

        expect(availability()).toBe('unavailable');
      });

      it('follows the first server sync, the cache replay and the selection', async () => {
        const harness = setup({
          selected: new Set(['@a:hs', '@b:hs']),
          live: ['@a:hs', '@b:hs'],
          synced: new Set(),
          prepared: new Set(['@b:hs']),
          active: '@b:hs',
          clients: new Map([
            [
              '@a:hs',
              fakeClient('@a:hs', [fakeRoom('!s:hs', { kind: 'space' })]),
            ],
            ['@b:hs', fakeClient('@b:hs', [fakeRoom('!r:hs')])],
          ]),
        });
        const availability = TestBed.runInInjectionContext(() =>
          computed(() => harness.service.spaceAvailability('@b:hs', '!t:hs')),
        );
        expect(availability()).toBe('unconfirmed');

        harness.synced.set(new Set(['@b:hs']));
        expect(availability()).toBe('unconfirmed'); // A has not loaded its cache

        harness.prepared.set(new Set(['@a:hs', '@b:hs']));
        expect(availability()).toBe('unavailable');

        harness.prepared.set(new Set(['@b:hs']));
        harness.selected.set(new Set(['@b:hs']));
        expect(availability()).toBe('unavailable');
      });
    });
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
    lastMessageMark: null,
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
    inviterId: '',
    isSpace: false,
    isDirect: false,
  };
}
