import { describe, expect, it } from 'vitest';
import {
  resolveWorkspaceNavigation,
  resolveWorkspacePanel,
} from './workspace-navigation.resolver';
import type {
  WorkspaceNavigationScope,
  WorkspaceRoomNavigationOrigin,
} from './workspace-navigation.models';
import type { WorkspaceView } from './workspace.models';

const view = (over: Partial<WorkspaceView> = {}): WorkspaceView => ({
  accountId: '@a:hs',
  scope: { kind: 'home' },
  roomId: null,
  pane: 'list',
  panel: null,
  ...over,
});

type ListKind = 'recent' | 'home' | 'rooms';
/** A list by kind, or a space's own list. */
type Listed = ListKind | WorkspaceNavigationScope;

const open = (
  accountId: string,
  current: WorkspaceView,
  listedIn: readonly Listed[] = ['recent', 'home', 'rooms'],
) =>
  resolveWorkspaceNavigation(
    {
      kind: 'room',
      accountId,
      roomId: '!chat:hs',
      origin: 'rail-unread',
      listedIn: listedIn.map((list) =>
        typeof list === 'string' ? { kind: list } : list,
      ),
    },
    current,
  );

const scopeOf = (current: WorkspaceView, listedIn: readonly Listed[]) =>
  open('@a:hs', current, listedIn)?.destination.scope;

describe("resolveWorkspaceNavigation — 'rail-unread'", () => {
  it('opens a chat on the same account over the list already shown', () => {
    const resolved = open('@a:hs', view({ scope: { kind: 'rooms' } }));
    expect(resolved?.destination).toEqual({
      accountId: '@a:hs',
      scope: { kind: 'rooms' },
      roomId: '!chat:hs',
      pane: 'conversation',
      panel: null,
    });
    expect(resolved?.options).toMatchObject({
      source: 'user',
      history: 'push',
    });
  });

  it('keeps Home for a direct message, which Home lists', () => {
    expect(
      scopeOf(view({ scope: { kind: 'home' } }), ['recent', 'home']),
    ).toEqual({ kind: 'home' });
  });

  it('opens a group chat from Home in Recent, since Home lists only direct messages', () => {
    expect(
      scopeOf(view({ scope: { kind: 'home' } }), ['recent', 'rooms']),
    ).toEqual({ kind: 'recent' });
  });

  it('keeps Rooms for a room outside spaces, which Rooms lists', () => {
    expect(
      scopeOf(view({ scope: { kind: 'rooms' } }), ['recent', 'rooms']),
    ).toEqual({ kind: 'rooms' });
  });

  it('opens a direct message from Rooms in Recent', () => {
    expect(
      scopeOf(view({ scope: { kind: 'rooms' } }), ['recent', 'home']),
    ).toEqual({ kind: 'recent' });
  });

  it("opens a space's room from Rooms in Recent, since Rooms omits space children", () => {
    expect(scopeOf(view({ scope: { kind: 'rooms' } }), ['recent'])).toEqual({
      kind: 'recent',
    });
  });

  it('keeps Recent, which lists every chat', () => {
    expect(scopeOf(view({ scope: { kind: 'recent' } }), ['recent'])).toEqual({
      kind: 'recent',
    });
  });

  it('opens in Recent when the caller could not say which lists show the chat', () => {
    const resolved = resolveWorkspaceNavigation(
      {
        kind: 'room',
        accountId: '@a:hs',
        roomId: '!chat:hs',
        origin: 'rail-unread',
      },
      view({ scope: { kind: 'home' } }),
    );
    expect(resolved?.destination.scope).toEqual({ kind: 'recent' });
  });

  it('falls back to Recent from a space, which may not hold the chat', () => {
    expect(
      open('@a:hs', view({ scope: { kind: 'space', spaceId: '!s:hs' } }))
        ?.destination.scope,
    ).toEqual({ kind: 'recent' });
  });

  describe('from a space', () => {
    const space = { kind: 'space', spaceId: '!s:hs' } as const;

    it('keeps the space when its list shows the chat, like Home and Rooms do', () => {
      expect(scopeOf(view({ scope: space }), ['recent', space])).toEqual(space);
    });

    it('opens in Recent when only another space lists the chat', () => {
      expect(
        scopeOf(view({ scope: space }), [
          'recent',
          { kind: 'space', spaceId: '!other:hs' },
        ]),
      ).toEqual({ kind: 'recent' });
    });

    // Mixed view: the space's list shows another account's chat, as for a pick from it.
    it("keeps the space for another account's chat that its list shows", () => {
      expect(
        open('@b:hs', view({ scope: space }), ['recent', space])?.destination
          .scope,
      ).toEqual(space);
    });
  });

  it("opens another account's chat in Recent even when its list would show it", () => {
    const resolved = open(
      '@b:hs',
      view({ scope: { kind: 'rooms' }, roomId: '!x:hs', pane: 'conversation' }),
    );
    expect(resolved?.destination).toEqual({
      accountId: '@b:hs',
      scope: { kind: 'recent' },
      roomId: '!chat:hs',
      pane: 'conversation',
      panel: null,
    });
  });

  it('opens over the compact list page, so Back returns to the list', () => {
    const resolved = resolveWorkspaceNavigation(
      {
        kind: 'room',
        accountId: '@a:hs',
        roomId: '!chat:hs',
        origin: 'rail-unread',
      },
      view({ pane: 'list' }),
      { listBelow: false, compact: true },
    );
    expect(resolved?.options.overList).toBe(true);
  });
});

describe('resolveWorkspaceNavigation — a room opened from a space', () => {
  const space = { kind: 'space', spaceId: '!s:hs' } as const;

  const scopeFrom = (
    origin: WorkspaceRoomNavigationOrigin,
    current: WorkspaceView,
    accountId = '@a:hs',
  ) =>
    resolveWorkspaceNavigation(
      { kind: 'room', accountId, roomId: '!chat:hs', origin },
      current,
    )?.destination.scope;

  it("keeps the space for a room picked from the space's own list (#1369)", () => {
    const resolved = resolveWorkspaceNavigation(
      {
        kind: 'room',
        accountId: '@a:hs',
        roomId: '!chat:hs',
        origin: 'room-list',
      },
      view({ scope: space }),
    );
    expect(resolved?.destination).toEqual({
      accountId: '@a:hs',
      scope: space,
      roomId: '!chat:hs',
      pane: 'conversation',
      panel: null,
    });
  });

  it('keeps the space when switching from one of its rooms to another', () => {
    expect(
      scopeFrom(
        'room-list',
        view({ scope: space, roomId: '!x:hs', pane: 'conversation' }),
      ),
    ).toEqual(space);
  });

  // Mixed view: the space's list shows a room only another selected account has joined.
  // Workspace keeps the space while some selected account holds it, else repairs it.
  it("keeps the space for another account's room picked from the space's list", () => {
    expect(scopeFrom('room-list', view({ scope: space }), '@b:hs')).toEqual(
      space,
    );
  });

  it.each<WorkspaceRoomNavigationOrigin>([
    'room-action',
    'global-search',
    'deep-link',
    'room-hop',
    // A visit-history jump (Ctrl/Cmd+digit) can land on a room outside the space.
    'shortcut',
  ])(
    'opens a %s room from a space in Recent, which lists every chat',
    (origin) => {
      expect(scopeFrom(origin, view({ scope: space }))).toEqual({
        kind: 'recent',
      });
    },
  );

  it('opens a room invitation from a space in Recent, as before', () => {
    expect(scopeFrom('room-invitation', view({ scope: space }))).toEqual({
      kind: 'recent',
    });
  });

  it('opens a direct invitation from a space in Home, as before', () => {
    expect(scopeFrom('direct-invitation', view({ scope: space }))).toEqual({
      kind: 'home',
    });
  });

  it('honours a scope the intent names over the space on screen', () => {
    const resolved = resolveWorkspaceNavigation(
      {
        kind: 'room',
        accountId: '@a:hs',
        roomId: '!chat:hs',
        origin: 'room-list',
        scope: { kind: 'rooms' },
      },
      view({ scope: space }),
    );
    expect(resolved?.destination.scope).toEqual({ kind: 'rooms' });
  });
});

describe('resolveWorkspaceNavigation — a room picked from the list on screen', () => {
  it.each(
    (['recent', 'home', 'rooms'] as const).flatMap((kind) =>
      (['room-list', 'shortcut'] as const).map((origin) => ({
        scope: { kind },
        origin,
      })),
    ),
  )('keeps the $scope.kind list for a $origin open', ({ scope, origin }) => {
    expect(
      resolveWorkspaceNavigation(
        { kind: 'room', accountId: '@a:hs', roomId: '!chat:hs', origin },
        view({ scope }),
      )?.destination.scope,
    ).toEqual(scope);
  });

  it("keeps the list on screen for another account's room, as before", () => {
    expect(
      resolveWorkspaceNavigation(
        {
          kind: 'room',
          accountId: '@b:hs',
          roomId: '!chat:hs',
          origin: 'room-list',
        },
        view({ scope: { kind: 'rooms' } }),
      )?.destination.scope,
    ).toEqual({ kind: 'rooms' });
  });
});

describe('resolveWorkspaceNavigation — the inbox scope', () => {
  const inbox = { kind: 'inbox' } as const;
  const choose = (scope: WorkspaceNavigationScope) =>
    resolveWorkspaceNavigation(
      { kind: 'scope', accountId: '@a:hs', scope },
      view({ scope: { kind: 'recent' } }),
    );

  it('replaces history when the inbox is chosen', () => {
    expect(choose(inbox)?.options).toEqual({
      source: 'user',
      history: 'replace',
    });
  });

  it('still pushes history when Recent is chosen', () => {
    expect(choose({ kind: 'recent' })?.options.history).toBe('push');
  });

  it('keeps the inbox for a room picked from it, over the compact list', () => {
    const resolved = resolveWorkspaceNavigation(
      {
        kind: 'room',
        accountId: '@a:hs',
        roomId: '!chat:hs',
        origin: 'room-list',
      },
      view({ scope: inbox }),
      { listBelow: false, compact: true },
    );
    expect(resolved?.destination.scope).toEqual(inbox);
    expect(resolved?.options.overList).toBe(true);
  });

  it('opens a rail unread chat in Recent, as the inbox lists no chats', () => {
    expect(scopeOf(view({ scope: inbox }), ['recent', 'home'])).toEqual({
      kind: 'recent',
    });
  });
});

describe('resolveWorkspacePanel — panel history', () => {
  const room = view({ roomId: '!chat:hs', pane: 'conversation' });
  const members = { kind: 'members' } as const;
  const threads = { kind: 'threads' } as const;
  const thread = { kind: 'thread', root: '$root:hs' } as const;

  it('pushes a panel opened over the bare Room', () => {
    expect(
      resolveWorkspacePanel(members, room, {
        panelBelow: false,
        membersBelow: false,
      }),
    ).toEqual({
      destination: { ...room, accountId: '@a:hs', panel: members },
      options: { source: 'user', history: 'push', withinRoom: true },
    });
  });

  it('replaces one panel with another', () => {
    expect(
      resolveWorkspacePanel(
        { kind: 'pinned' },
        { ...room, panel: threads },
        { panelBelow: true, membersBelow: false },
      )?.options.history,
    ).toBe('replace');
    expect(
      resolveWorkspacePanel(
        threads,
        { ...room, panel: thread },
        {
          panelBelow: true,
          membersBelow: false,
        },
      )?.options.history,
    ).toBe('replace');
  });

  it('pushes a panel opened over the roster, so Back returns to the roster', () => {
    for (const panel of [threads, thread, { kind: 'pinned' } as const]) {
      expect(
        resolveWorkspacePanel(
          panel,
          { ...room, panel: members },
          { panelBelow: true, membersBelow: false },
        )?.options.history,
      ).toBe('push');
    }
  });

  it('pops back to the roster below rather than opening it again', () => {
    expect(
      resolveWorkspacePanel(
        members,
        { ...room, panel: thread },
        { panelBelow: true, membersBelow: true },
      ),
    ).toMatchObject({
      destination: { panel: members },
      options: { history: 'back', withinRoom: true },
    });
    expect(
      resolveWorkspacePanel(
        members,
        { ...room, panel: thread },
        { panelBelow: true, membersBelow: false },
      )?.options.history,
    ).toBe('replace');
  });

  it('pushes a thread opened from the threads list, so Back returns to the list', () => {
    expect(
      resolveWorkspacePanel(
        thread,
        { ...room, panel: threads },
        {
          panelBelow: true,
          membersBelow: false,
        },
      )?.options.history,
    ).toBe('push');
  });

  it('pops a panel pushed over its Room on close, and replaces one without the mark', () => {
    const open = { ...room, panel: members };
    expect(
      resolveWorkspacePanel(null, open, {
        panelBelow: true,
        membersBelow: false,
      }),
    ).toMatchObject({
      destination: { roomId: '!chat:hs', panel: null },
      options: { history: 'back', withinRoom: true },
    });
    expect(
      resolveWorkspacePanel(null, open, {
        panelBelow: false,
        membersBelow: false,
      })?.options.history,
    ).toBe('replace');
  });

  it('opens a panel on a Room shown beside its list as its Conversation', () => {
    expect(
      resolveWorkspacePanel(members, view({ roomId: '!chat:hs' }), {
        panelBelow: false,
        membersBelow: false,
      })?.destination,
    ).toMatchObject({ pane: 'conversation', panel: members });
  });

  it('rejects a panel with no Room open', () => {
    expect(
      resolveWorkspacePanel(members, view(), {
        panelBelow: false,
        membersBelow: false,
      }),
    ).toBeNull();
  });
});

describe('resolveWorkspaceNavigation — the open panel', () => {
  const members = { kind: 'members' } as const;
  const open = view({
    roomId: '!chat:hs',
    pane: 'conversation',
    panel: members,
  });

  it('carries the roster to another Room of the same Account, and nothing else', () => {
    const toOther = (current: typeof open, accountId = '@a:hs') =>
      resolveWorkspaceNavigation(
        { kind: 'room', accountId, roomId: '!other:hs', origin: 'room-list' },
        current,
      )?.destination.panel;
    expect(toOther(open)).toEqual(members);
    expect(toOther(open, '@b:hs')).toBeNull();
    for (const panel of [
      { kind: 'threads' },
      { kind: 'pinned' },
      { kind: 'search' },
      { kind: 'thread', root: '$root:hs' },
    ] as const) {
      expect(toOther({ ...open, panel })).toBeNull();
    }
  });

  it('drops the roster with the Room on a phone, where it is a page over the Room', () => {
    const toOther = (compact: boolean) =>
      resolveWorkspaceNavigation(
        {
          kind: 'room',
          accountId: '@a:hs',
          roomId: '!other:hs',
          origin: 'room-action',
        },
        open,
        { listBelow: false, compact },
      )?.destination.panel;
    expect(toOther(true)).toBeNull();
    expect(toOther(false)).toEqual(members);
    // Choosing the open Room again still keeps its page.
    expect(
      resolveWorkspaceNavigation(
        {
          kind: 'room',
          accountId: '@a:hs',
          roomId: '!chat:hs',
          origin: 'room-action',
        },
        open,
        { listBelow: false, compact: true },
      )?.destination.panel,
    ).toEqual(members);
  });

  it('drops the panel when the Account changes', () => {
    expect(
      resolveWorkspaceNavigation({ kind: 'account', accountId: '@b:hs' }, open)
        ?.destination.panel,
    ).toBeNull();
    expect(
      resolveWorkspaceNavigation(
        { kind: 'scope', accountId: '@b:hs', scope: { kind: 'rooms' } },
        open,
      )?.destination.panel,
    ).toBeNull();
  });

  it('keeps the panel when the scope changes around the same Room', () => {
    expect(
      resolveWorkspaceNavigation(
        { kind: 'scope', accountId: '@a:hs', scope: { kind: 'rooms' } },
        open,
      )?.destination.panel,
    ).toEqual(members);
  });

  it('restores the panel a reload or deep link names', () => {
    expect(
      resolveWorkspaceNavigation(
        {
          kind: 'restoration',
          accountId: '@a:hs',
          scope: { kind: 'recent' },
          roomId: '!chat:hs',
          pane: 'conversation',
          panel: members,
          canonical: true,
        },
        view(),
      )?.destination.panel,
    ).toEqual(members);
  });
});
