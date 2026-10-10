import { describe, expect, it } from 'vitest';
import { resolveWorkspaceNavigation } from './workspace-navigation.resolver';
import type { WorkspaceView } from './workspace.models';

const view = (over: Partial<WorkspaceView> = {}): WorkspaceView => ({
  accountId: '@a:hs',
  scope: { kind: 'home' },
  roomId: null,
  pane: 'list',
  ...over,
});

type ListKind = 'recent' | 'home' | 'rooms';

const open = (
  accountId: string,
  current: WorkspaceView,
  listedIn: readonly ListKind[] = ['recent', 'home', 'rooms'],
) =>
  resolveWorkspaceNavigation(
    {
      kind: 'room',
      accountId,
      roomId: '!chat:hs',
      origin: 'rail-unread',
      listedIn,
    },
    current,
  );

const scopeOf = (current: WorkspaceView, listedIn: readonly ListKind[]) =>
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
