import { computed, signal, type WritableSignal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { defer, finalize, firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SESSION,
  SESSION_ENGINE,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import {
  FakeRoomListEngine,
  fakeRoom,
} from '../contract/fake-room-list-engine';
import { AccountScopeService } from './account-scope.service';
import { InvitesService, type PendingInvite } from './invites.service';
import { RoomLibraryService, type RoomSummary } from './room-library.service';
import type { RoomInfo } from './room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';
import { SelectedRoomLibraryService } from './selected-room-library.service';
import { SpacesService, type SpaceSummary } from './spaces.service';

interface RoomOptions {
  readonly kind?: 'room' | 'space' | 'invite';
  /** Overrides the membership `kind` implies, e.g. a space the Account has left. */
  readonly membership?: RoomInfo['membership'];
  readonly name?: string;
  readonly unread?: number;
  readonly highlight?: number;
  readonly markedUnread?: boolean;
  readonly favourite?: boolean;
  readonly lowPriority?: boolean;
  readonly encrypted?: boolean;
  /** The body of a last message that arrived in clear. */
  readonly message?: string;
  readonly directUserId?: string;
}

/** One row as the engine lists it for an Account. */
function row(id: string, options: RoomOptions = {}): RoomInfo {
  const kind = options.kind ?? 'room';
  return fakeRoom(id, {
    displayName: options.name ?? id,
    isSpace: kind === 'space',
    membership: options.membership ?? (kind === 'invite' ? 'invite' : 'join'),
    notificationCount: options.unread ?? 0,
    highlightCount: options.highlight ?? 0,
    markedUnread: options.markedUnread ?? false,
    favourite: options.favourite ?? false,
    lowPriority: options.lowPriority ?? false,
    encryption: options.encrypted ? 'encrypted' : 'unencrypted',
    latestMessage:
      options.message === undefined
        ? null
        : {
            text: options.message,
            mark: options.encrypted ? 'unencrypted' : null,
          },
    directUserId: options.directUserId ?? null,
    inviter:
      kind === 'invite'
        ? { userId: '@inviter:hs', displayName: 'Inviter', isDirect: false }
        : null,
  });
}

function account(
  accountId: string,
  generation = 1,
  { synced = true, prepared = true } = {},
): SessionAccountStatus {
  return {
    accountId,
    deviceId: 'DEVICE',
    generation,
    syncState: 'syncing',
    serverSynced: synced,
    roomsPrepared: prepared,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

const ACTIVE_ROOM = roomSummary('!active:hs', '@active:hs');
const ACTIVE_SPACE = spaceSummary('!active-space:hs', '@active:hs');
const ACTIVE_INVITE = inviteSummary('!active-invite:hs', '@active:hs');

function setup(
  options: {
    selected?: ReadonlySet<string>;
    live?: readonly string[];
    active?: string | null;
    rooms?: Readonly<Record<string, readonly RoomInfo[]>>;
    /** Accounts that have synced with their homeserver; every live one unless named. */
    synced?: ReadonlySet<string>;
    /** Accounts that have prepared their rooms, from cache or server; every live one. */
    prepared?: ReadonlySet<string>;
    connect?: boolean;
  } = {},
) {
  const fake = new FakeRoomListEngine();
  for (const [accountId, rows] of Object.entries(options.rooms ?? {})) {
    fake.seed(accountId, rows);
  }
  const selected = signal<ReadonlySet<string>>(
    options.selected ?? new Set(['@active:hs']),
  );
  const live = options.live ?? ['@active:hs'];
  const synced = options.synced ?? new Set(live);
  const prepared = options.prepared ?? new Set(live);
  const session = signal<SessionSnapshot>({
    ...EMPTY_SESSION,
    activeAccountId:
      options.active === undefined ? '@active:hs' : options.active,
    accounts: live.map((id) =>
      account(id, 1, { synced: synced.has(id), prepared: prepared.has(id) }),
    ),
  });
  const activeSpaces = signal<SpaceSummary[]>([ACTIVE_SPACE]);
  const setSelected = vi.fn<AccountScopeService['setSelected']>(() =>
    of({ kind: 'completed' as const }),
  );
  const toggle = vi.fn<AccountScopeService['toggle']>(() =>
    of({ kind: 'completed' as const }),
  );

  // Counts the child-link subscriptions the service holds, per Account.
  const openLinks = new Map<string, number>();
  let opened = 0;
  let closed = 0;
  const links = fake.spaceChildLinks.bind(fake);
  vi.spyOn(fake, 'spaceChildLinks').mockImplementation((accountId, spaceId) =>
    defer(() => {
      opened++;
      openLinks.set(accountId, (openLinks.get(accountId) ?? 0) + 1);
      return links(accountId, spaceId);
    }).pipe(
      finalize(() => {
        closed++;
        openLinks.set(accountId, (openLinks.get(accountId) ?? 0) - 1);
      }),
    ),
  );

  TestBed.configureTestingModule({
    providers: [
      { provide: ROOM_LIST_ENGINE, useValue: fake },
      { provide: SESSION_SNAPSHOT, useValue: session },
      {
        provide: SESSION_ENGINE,
        useFactory: () => ({ session: () => toObservable(session) }),
      },
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
  /** Links `childId` into `spaceId` as `accountId` would. */
  const link = (accountId: string, spaceId: string, childId: string): void => {
    fake
      .setSpaceChild(accountId, spaceId, childId, {
        via: ['hs'],
        suggested: false,
        order: '',
      })
      .subscribe();
  };
  return {
    service,
    fake,
    session,
    selected: selected as WritableSignal<ReadonlySet<string>>,
    activeSpaces,
    setSelected,
    toggle,
    lifetime,
    link,
    openLinks: (accountId?: string) =>
      accountId === undefined
        ? opened - closed
        : (openLinks.get(accountId) ?? 0),
    linkCounts: () => ({ opened, closed }),
    /** Sets the session's active Account. */
    activate: (accountId: string | null) =>
      session.update((s) => ({ ...s, activeAccountId: accountId })),
  };
}

const AB = {
  selected: new Set(['@a:hs', '@b:hs']),
  live: ['@a:hs', '@b:hs'],
};

describe('SelectedRoomLibraryService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('holds space links only for its owned lifetime and reconnects from empty state', () => {
    const harness = setup({
      ...AB,
      rooms: {
        '@a:hs': [row('!a:hs'), row('!sa:hs', { kind: 'space' })],
        '@b:hs': [row('!b:hs'), row('!sb:hs', { kind: 'space' })],
      },
      connect: false,
    });

    expect(harness.service.view()).toMatchObject({
      mode: 'active',
      rooms: [ACTIVE_ROOM],
      spaces: [ACTIVE_SPACE],
      invitations: [ACTIVE_INVITE],
    });
    expect(harness.openLinks()).toBe(0);

    const lifetime = harness.service.runProjection().subscribe();
    expect(harness.service.view().spaces).toHaveLength(2);
    expect(harness.openLinks('@a:hs')).toBe(1);
    expect(harness.openLinks('@b:hs')).toBe(1);

    lifetime.unsubscribe();
    expect(harness.openLinks()).toBe(0);
    expect(harness.service.view()).toMatchObject({
      mode: 'mixed',
      rooms: [],
      spaces: [],
      invitations: [],
    });

    harness.service.runProjection().subscribe();
    expect(harness.service.view().spaces).toHaveLength(2);
    expect(harness.openLinks()).toBe(2);
    expect(harness.linkCounts().opened).toBe(4);
  });

  it('acknowledges its projection lifetime at once', () => {
    const harness = setup({ connect: false });
    const seen: unknown[] = [];

    harness.service.runProjection().subscribe((value) => seen.push(value));

    expect(seen).toEqual([undefined]);
  });

  it('delegates one Account to active projections without holding links', () => {
    const harness = setup({
      rooms: {
        '@active:hs': [row('!sdk:hs'), row('!s:hs', { kind: 'space' })],
      },
    });

    expect(harness.service.view()).toEqual({
      accountIds: new Set(['@active:hs']),
      mode: 'active',
      rooms: [ACTIVE_ROOM],
      spaces: [ACTIVE_SPACE],
      spaceChildRoomIdsByAccount: new Map([['@active:hs', new Set<string>()]]),
      invitations: [ACTIVE_INVITE],
    });
    expect(harness.openLinks()).toBe(0);
  });

  it('publishes one mixed generation with exact Room, Space, and invite policy', () => {
    const harness = setup({
      ...AB,
      active: '@a:hs',
      rooms: {
        '@a:hs': [
          row('!shared:hs'),
          row('!x:hs'),
          row('!space:hs', { kind: 'space' }),
          row('!invite-a:hs', { kind: 'invite', name: 'Alpha' }),
        ],
        '@b:hs': [
          row('!shared:hs', {
            unread: 3,
            highlight: 2,
            markedUnread: true,
            lowPriority: true,
          }),
          row('!other:hs'),
          row('!x:hs'),
          row('!y:hs'),
          row('!space:hs', { kind: 'space' }),
          row('!invite-b:hs', { kind: 'invite', name: 'Bravo' }),
        ],
      },
    });
    harness.link('@b:hs', '!space:hs', '!x:hs');
    harness.link('@b:hs', '!space:hs', '!y:hs');

    const view = harness.service.view();
    expect(view.accountIds).toBe(AB.selected);
    expect(view.mode).toBe('mixed');
    expect(view.rooms.map((item) => item.id).sort()).toEqual([
      '!other:hs',
      '!shared:hs',
      '!x:hs',
      '!y:hs',
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
    // A has joined only !x of the space's children.
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
    expect(view.invitations[0]).toMatchObject({
      inviterName: 'Inviter',
      inviterId: '@inviter:hs',
    });
    // One link subscription per Account and space.
    expect(harness.openLinks('@a:hs')).toBe(1);
    expect(harness.openLinks()).toBe(2);
  });

  it("locks a mixed-list room by its own Account's encryption", () => {
    const harness = setup({
      ...AB,
      rooms: {
        '@a:hs': [row('!a:hs')],
        '@b:hs': [row('!b:hs', { encrypted: true })],
      },
    });
    const lock = (id: string) =>
      harness.service.view().rooms.find((room) => room.id === id)?.encrypted;

    expect(lock('!b:hs')).toBe(true);
    expect(lock('!a:hs')).toBe(false);
  });

  it("previews each Account's rooms by its own encryption", () => {
    const harness = setup({
      ...AB,
      rooms: {
        '@a:hs': [row('!stored:hs', { message: 'hello', encrypted: true })],
        '@b:hs': [row('!plain:hs', { message: 'hello' })],
      },
    });
    const room = (id: string) =>
      harness.service.view().rooms.find((r) => r.id === id);

    expect(room('!plain:hs')?.lastMessage).toBe('hello');
    expect(room('!stored:hs')?.lastMessage).toBe('hello');
    expect(room('!stored:hs')?.lastMessageMark).toBe('unencrypted');
    expect(room('!plain:hs')?.encrypted).toBe(false);
    expect(room('!stored:hs')?.encrypted).toBe(true);
  });

  describe('a room several Accounts share', () => {
    function sharedRow(
      active: string | null,
      copies: readonly (readonly [string, boolean])[],
    ) {
      const ids = copies.map(([id]) => id);
      const harness = setup({
        selected: new Set(ids),
        live: ids,
        active,
        rooms: Object.fromEntries(
          copies.map(([id, encrypted]) => [
            id,
            [row('!shared:hs', { message: `from ${id}`, encrypted })],
          ]),
        ),
      });
      return harness.service.view().rooms.find((r) => r.id === '!shared:hs');
    }

    it('shows the room unencrypted when the active Account sees it so', () => {
      const row = sharedRow('@a:hs', [
        ['@a:hs', false],
        ['@b:hs', true],
      ]);

      expect(row?.accountId).toBe('@a:hs');
      expect(row?.encrypted).toBe(false);
      expect(row?.lastMessage).toBe('from @a:hs');
      expect(row?.lastMessageMark).toBeNull();
    });

    it('shows the room encrypted when the active Account sees it so', () => {
      const row = sharedRow('@b:hs', [
        ['@a:hs', false],
        ['@b:hs', true],
      ]);

      expect(row?.accountId).toBe('@b:hs');
      expect(row?.encrypted).toBe(true);
      expect(row?.lastMessage).toBe('from @b:hs');
      expect(row?.lastMessageMark).toBe('unencrypted');
    });

    it('follows the first source when none of the copies is active', () => {
      const row = sharedRow('@none:hs', [
        ['@a:hs', false],
        ['@b:hs', true],
      ]);

      expect(row?.accountId).toBe('@a:hs');
      expect(row?.encrypted).toBe(false);
      expect(row?.lastMessageMark).toBeNull();
    });

    it.each(['@a:hs', '@b:hs', '@c:hs'])(
      'follows the active Account among three copies (%s)',
      (active) => {
        const row = sharedRow(active, [
          ['@a:hs', true],
          ['@b:hs', false],
          ['@c:hs', true],
        ]);

        expect(row?.accountId).toBe(active);
        expect(row?.encrypted).toBe(active !== '@b:hs');
        expect(row?.lastMessage).toBe(`from ${active}`);
      },
    );
  });

  it('takes favourite from the winning Account copy', () => {
    const harness = setup({
      ...AB,
      active: '@a:hs',
      rooms: {
        '@a:hs': [row('!shared:hs')],
        '@b:hs': [row('!shared:hs', { favourite: true })],
      },
    });

    expect(harness.service.view().rooms[0]?.favourite).toBe(false);

    harness.activate('@b:hs');

    expect(harness.service.view().rooms[0]?.favourite).toBe(true);
  });

  it('refreshes marked-unread state after its room list changes', () => {
    const harness = setup({
      ...AB,
      active: '@a:hs',
      rooms: { '@a:hs': [row('!room:hs')], '@b:hs': [row('!other:hs')] },
    });
    const marked = () =>
      harness.service.view().rooms.find((item) => item.id === '!room:hs')
        ?.markedUnread;
    expect(marked()).toBe(false);

    harness.fake.seed('@a:hs', [row('!room:hs', { markedUnread: true })]);

    expect(marked()).toBe(true);
  });

  it('ignores unselected live Accounts and holds no links for them', () => {
    const harness = setup({
      selected: new Set(['@a:hs', '@b:hs']),
      live: ['@a:hs', '@b:hs', '@c:hs'],
      rooms: {
        '@a:hs': [row('!a:hs')],
        '@b:hs': [row('!b:hs')],
        '@c:hs': [row('!c:hs'), row('!sc:hs', { kind: 'space' })],
      },
    });

    expect(
      harness.service
        .view()
        .rooms.map((item) => item.id)
        .sort(),
    ).toEqual(['!a:hs', '!b:hs']);
    expect(harness.service.view().spaces).toEqual([]);
    expect(harness.openLinks('@c:hs')).toBe(0);
  });

  it('keeps invitations Account-scoped even when their Room ids match', () => {
    const harness = setup({
      ...AB,
      rooms: {
        '@a:hs': [row('!invite:hs', { kind: 'invite', name: 'Shared' })],
        '@b:hs': [row('!invite:hs', { kind: 'invite', name: 'Shared' })],
      },
    });

    expect(
      harness.service.view().invitations.map((invite) => invite.accountId),
    ).toEqual(['@a:hs', '@b:hs']);
  });

  it('uses stable fallback ownership and each Account’s direct user', () => {
    const harness = setup({
      selected: new Set(['@b:hs', '@a:hs']),
      live: ['@a:hs', '@b:hs'],
      active: null,
      rooms: {
        '@a:hs': [
          row('!shared:hs'),
          row('!dm:hs', { favourite: true, directUserId: '@peer:hs' }),
        ],
        '@b:hs': [row('!shared:hs')],
      },
    });

    expect(harness.service.view().rooms.map((item) => item.id)).toEqual([
      '!dm:hs',
      '!shared:hs',
    ]);
    expect(harness.service.view().rooms[0].directUserId).toBe('@peer:hs');
    expect(harness.service.view().rooms[1].accountId).toBe('@a:hs');
  });

  it('structurally shares projections a room change leaves alone', () => {
    const harness = setup({
      ...AB,
      rooms: {
        '@a:hs': [row('!a:hs'), row('!s:hs', { kind: 'space' })],
        '@b:hs': [row('!b:hs'), row('!i:hs', { kind: 'invite' })],
      },
    });
    const before = harness.service.view();

    harness.fake.seed('@a:hs', [
      row('!a:hs', { unread: 1 }),
      row('!s:hs', { kind: 'space' }),
    ]);

    const after = harness.service.view();
    expect(after.rooms).not.toBe(before.rooms);
    expect(after.rooms.find((r) => r.id === '!a:hs')?.unreadCount).toBe(1);
    expect(after.spaces).toBe(before.spaces);
    expect(after.spaceChildRoomIdsByAccount).toBe(
      before.spaceChildRoomIdsByAccount,
    );
    expect(after.invitations).toBe(before.invitations);
  });

  it('follows live Accounts and a restarted Account’s new generation', () => {
    const harness = setup({
      ...AB,
      rooms: {
        '@a:hs': [row('!a:hs'), row('!sa:hs', { kind: 'space' })],
        '@b:hs': [row('!b:hs')],
      },
    });
    expect(harness.service.view().spaces).toHaveLength(1);
    expect(harness.openLinks('@a:hs')).toBe(1);

    harness.fake.seed('@a:hs', [
      row('!a2:hs'),
      row('!sa:hs', { kind: 'space' }),
    ]);
    harness.session.update((s) => ({
      ...s,
      accounts: [account('@a:hs', 2), account('@b:hs')],
    }));
    TestBed.tick();

    // The old generation's link closed at once; the new one opens on read.
    expect(harness.linkCounts().closed).toBe(1);
    expect(
      harness.service
        .view()
        .rooms.map((item) => item.id)
        .sort(),
    ).toEqual(['!a2:hs', '!b:hs']);
    expect(harness.openLinks('@a:hs')).toBe(1);

    harness.session.update((s) => ({ ...s, accounts: [account('@b:hs')] }));
    TestBed.tick();
    expect(harness.openLinks('@a:hs')).toBe(0);
    expect(harness.service.view().rooms.map((item) => item.id)).toEqual([
      '!b:hs',
    ]);
  });

  it('a restarted account is not double counted', () => {
    const harness = setup({
      ...AB,
      rooms: {
        '@a:hs': [
          row('!shared:hs', { unread: 2 }),
          row('!x:hs'),
          row('!s:hs', { kind: 'space' }),
        ],
        '@b:hs': [row('!shared:hs', { unread: 1 })],
      },
    });
    harness.link('@a:hs', '!s:hs', '!x:hs');
    expect(harness.service.view().spaces[0]?.childRoomIds).toEqual(['!x:hs']);

    harness.session.update((s) => ({
      ...s,
      accounts: [account('@a:hs', 2), account('@b:hs')],
    }));

    const view = harness.service.view();
    expect(view.rooms.find((r) => r.id === '!shared:hs')).toMatchObject({
      accountIds: ['@a:hs', '@b:hs'],
      unreadCount: 2,
    });
    expect(view.rooms.filter((r) => r.id === '!x:hs')).toHaveLength(1);
    expect(view.spaces).toHaveLength(1);
    expect(view.spaces[0].childRoomIds).toEqual(['!x:hs']);
    expect(harness.openLinks('@a:hs')).toBe(1);
  });

  it('closes a signed-out Account’s space links without a read', () => {
    const harness = setup({
      ...AB,
      rooms: {
        '@a:hs': [row('!sa:hs', { kind: 'space' })],
        '@b:hs': [row('!sb:hs', { kind: 'space' })],
      },
    });
    expect(harness.service.view().spaces).toHaveLength(2);

    harness.session.update((s) => ({ ...s, accounts: [account('@a:hs')] }));
    TestBed.tick();

    expect(harness.openLinks('@b:hs')).toBe(0);
    expect(harness.openLinks('@a:hs')).toBe(1);
  });

  it('re-attributes shared rows when the Active Account changes', () => {
    const harness = setup({
      ...AB,
      active: '@a:hs',
      rooms: {
        '@a:hs': [row('!shared:hs'), row('!space:hs', { kind: 'space' })],
        '@b:hs': [row('!shared:hs'), row('!space:hs', { kind: 'space' })],
      },
    });
    expect(harness.service.view().rooms[0].accountId).toBe('@a:hs');
    expect(harness.service.view().spaces[0].accountId).toBe('@a:hs');

    harness.activate('@b:hs');

    expect(harness.service.view().rooms[0].accountId).toBe('@b:hs');
    expect(harness.service.view().spaces[0].accountId).toBe('@b:hs');
  });

  it('does not churn links for an equal selected Account set', () => {
    const harness = setup({
      ...AB,
      rooms: {
        '@a:hs': [row('!sa:hs', { kind: 'space' })],
        '@b:hs': [row('!b:hs')],
      },
    });
    harness.service.view();

    harness.selected.set(new Set(['@b:hs', '@a:hs']));
    TestBed.tick();
    harness.service.view();

    expect(harness.linkCounts()).toEqual({ opened: 1, closed: 0 });
    expect(harness.openLinks('@a:hs')).toBe(1);
  });

  it('closes a deselected Account’s space links without a read', () => {
    const harness = setup({
      selected: new Set(['@a:hs', '@b:hs', '@c:hs']),
      live: ['@a:hs', '@b:hs', '@c:hs'],
      rooms: {
        '@a:hs': [row('!sa:hs', { kind: 'space' })],
        '@b:hs': [row('!sb:hs', { kind: 'space' })],
        '@c:hs': [row('!sc:hs', { kind: 'space' })],
      },
    });
    harness.service.view();
    expect(harness.openLinks('@c:hs')).toBe(1);

    harness.selected.set(new Set(['@a:hs', '@b:hs']));
    TestBed.tick();

    expect(harness.openLinks('@c:hs')).toBe(0);
    expect(harness.openLinks('@a:hs')).toBe(1);
    expect(harness.openLinks('@b:hs')).toBe(1);
  });

  it('closes selected links before returning to one active Account', () => {
    const harness = setup({
      ...AB,
      rooms: {
        '@a:hs': [row('!sa:hs', { kind: 'space' })],
        '@b:hs': [row('!sb:hs', { kind: 'space' })],
      },
    });
    harness.service.view();
    expect(harness.openLinks('@a:hs')).toBe(1);

    harness.selected.set(new Set(['@a:hs']));
    TestBed.tick();

    expect(harness.service.view()).toMatchObject({
      mode: 'active',
      rooms: [ACTIVE_ROOM],
      spaces: [ACTIVE_SPACE],
      invitations: [ACTIVE_INVITE],
    });
    expect(harness.openLinks()).toBe(0);
  });

  it('closes its links on destruction', () => {
    const harness = setup({
      ...AB,
      rooms: {
        '@a:hs': [row('!sa:hs', { kind: 'space' })],
        '@b:hs': [row('!sb:hs', { kind: 'space' })],
      },
    });
    harness.service.view();
    expect(harness.openLinks()).toBe(2);

    TestBed.resetTestingModule();

    expect(harness.openLinks()).toBe(0);
    expect(harness.linkCounts()).toEqual({ opened: 2, closed: 2 });
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
        rooms: {
          '@a:hs': [row('!s:hs', { kind: 'space' })],
          '@b:hs': [row('!r:hs')],
          '@c:hs': [row('!c:hs')],
        },
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
    it('does not count a space held by a selected Account that is not live', () => {
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

    it('makes it unavailable for an Account that is not live, or a malformed id', () => {
      const service = mixed(['@a:hs', '@b:hs'], []);

      expect(service.spaceAvailability('@gone:hs', '!s:hs')).toBe(
        'unavailable',
      );
      expect(service.spaceAvailability('@a:hs', '#alias:hs')).toBe(
        'unavailable',
      );
    });

    // The room list drops a left space; one only knocked on is listed but not held.
    it('makes a space the Accounts have only knocked on unavailable', () => {
      const service = setup({
        ...AB,
        active: '@a:hs',
        rooms: {
          '@a:hs': [row('!s:hs', { kind: 'space', membership: 'knock' })],
          '@b:hs': [row('!s:hs', { kind: 'space', membership: 'knock' })],
        },
      }).service;

      expect(service.spaceAvailability('@a:hs', '!s:hs')).toBe('unavailable');
      expect(service.spaceAvailability('@b:hs', '!s:hs')).toBe('unavailable');
    });

    // An accepted invitation keeps `invite` until the join syncs; the flows that open a
    // space they just joined wait for the join (RoomReadinessService) instead.
    it('does not count a space the Account is only invited to', () => {
      const service = setup({
        rooms: {
          '@active:hs': [row('!s:hs', { kind: 'space', membership: 'invite' })],
        },
      }).service;

      expect(service.spaceAvailability('@active:hs', '!s:hs')).toBe(
        'unavailable',
      );
    });

    it("does not count another selected Account's invitation", () => {
      const service = setup({
        ...AB,
        active: '@b:hs',
        rooms: {
          '@a:hs': [row('!s:hs', { kind: 'space', membership: 'invite' })],
          '@b:hs': [row('!r:hs')],
        },
      }).service;

      expect(service.spaceAvailability('@b:hs', '!s:hs')).toBe('unavailable');
    });

    it('does not count a room that is not a joined space', () => {
      expect(
        mixed(['@a:hs', '@b:hs']).spaceAvailability('@a:hs', '!r:hs'),
      ).toBe('unavailable');
    });

    describe('as a reactive read', () => {
      it('follows a membership change of a selected Account in the mixed view', () => {
        const harness = setup({
          ...AB,
          active: '@b:hs',
          rooms: {
            '@a:hs': [row('!s:hs', { kind: 'space' })],
            '@b:hs': [row('!r:hs')],
          },
        });
        const availability = TestBed.runInInjectionContext(() =>
          computed(() => harness.service.spaceAvailability('@b:hs', '!s:hs')),
        );
        expect(availability()).toBe('available');

        harness.fake.leave('@a:hs', '!s:hs').subscribe();

        expect(availability()).toBe('unavailable');
      });

      it("follows the active Account's spaces in the single-Account view", () => {
        const harness = setup({
          rooms: { '@active:hs': [row('!s:hs', { kind: 'space' })] },
        });
        const availability = TestBed.runInInjectionContext(() =>
          computed(() =>
            harness.service.spaceAvailability('@active:hs', '!s:hs'),
          ),
        );
        expect(availability()).toBe('available');

        harness.fake.leave('@active:hs', '!s:hs').subscribe();

        expect(availability()).toBe('unavailable');
      });

      it('follows the first server sync, the cache replay and the selection', () => {
        const harness = setup({
          ...AB,
          synced: new Set(),
          prepared: new Set(['@b:hs']),
          active: '@b:hs',
          rooms: {
            '@a:hs': [row('!s:hs', { kind: 'space' })],
            '@b:hs': [row('!r:hs')],
          },
        });
        const status = (synced: boolean, prepared: boolean) =>
          harness.session.update((s) => ({
            ...s,
            accounts: [
              account('@a:hs', 1, { synced: false, prepared }),
              account('@b:hs', 1, { synced, prepared: true }),
            ],
          }));
        const availability = TestBed.runInInjectionContext(() =>
          computed(() => harness.service.spaceAvailability('@b:hs', '!t:hs')),
        );
        expect(availability()).toBe('unconfirmed');

        status(true, false);
        expect(availability()).toBe('unconfirmed'); // A has not loaded its cache

        status(true, true);
        expect(availability()).toBe('unavailable');

        status(true, false);
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
