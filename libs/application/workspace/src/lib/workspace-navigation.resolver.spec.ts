import { describe, expect, it } from 'vitest';
import { resolveWorkspaceNavigation } from './workspace-navigation.resolver';
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
