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

const open = (accountId: string, current: WorkspaceView) =>
  resolveWorkspaceNavigation(
    { kind: 'room', accountId, roomId: '!chat:hs', origin: 'rail-unread' },
    current,
  );

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

  it('falls back to Recent from a space, which may not hold the chat', () => {
    expect(
      open('@a:hs', view({ scope: { kind: 'space', spaceId: '!s:hs' } }))
        ?.destination.scope,
    ).toEqual({ kind: 'recent' });
  });

  it("opens another account's chat in Recent on that account", () => {
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
});
