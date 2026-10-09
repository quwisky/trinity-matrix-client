import type { WorkspaceNavigationIntent } from './workspace-navigation.models';
import {
  RECENT_WORKSPACE_SCOPE,
  type WorkspaceDestination,
  type WorkspaceOpenOptions,
  type WorkspaceView,
} from './workspace.models';

export interface ResolvedWorkspaceNavigation {
  readonly destination: WorkspaceDestination;
  readonly options: WorkspaceOpenOptions;
}

function roomScope(
  intent: Extract<WorkspaceNavigationIntent, { readonly kind: 'room' }>,
  current: WorkspaceView,
) {
  if (intent.origin === 'direct-invitation') return { kind: 'home' } as const;
  if (intent.origin === 'room-invitation') {
    return current.accountId === intent.accountId &&
      current.scope.kind !== 'space'
      ? current.scope
      : RECENT_WORKSPACE_SCOPE;
  }
  return (
    intent.scope ??
    (current.scope.kind === 'space' ? RECENT_WORKSPACE_SCOPE : current.scope)
  );
}

/** What browser history holds under the current entry, as far as Workspace knows. */
export interface WorkspaceHistoryContext {
  /** The current entry is a Conversation pushed straight over its list (see `overList`). */
  readonly listBelow: boolean;
  /** List and Conversation are separate pages (below `md`), not one split view. */
  readonly compact: boolean;
}

/** Resolve one Room-shell intent into the package-private transition protocol. */
export function resolveWorkspaceNavigation(
  intent: WorkspaceNavigationIntent,
  current: WorkspaceView,
  history: WorkspaceHistoryContext = { listBelow: false, compact: false },
): ResolvedWorkspaceNavigation | null {
  switch (intent.kind) {
    case 'account':
      return {
        destination: {
          accountId: intent.accountId,
          scope: { kind: 'home' },
          roomId: null,
          pane: 'list',
        },
        options:
          intent.origin === 'search-preparation'
            ? { source: 'repair', history: 'replace' }
            : { source: 'user', history: 'push' },
      };
    case 'scope':
      return {
        destination: {
          accountId: intent.accountId,
          scope: intent.scope,
          roomId:
            current.accountId === intent.accountId ? current.roomId : null,
          pane: current.accountId === intent.accountId ? current.pane : 'list',
        },
        options: { source: 'user', history: 'push' },
      };
    case 'room':
      return {
        destination: {
          accountId: intent.accountId,
          scope: roomScope(intent, current),
          roomId: intent.roomId,
          pane: 'conversation',
        },
        options: {
          source: intent.origin === 'room-hop' ? 'hop' : 'user',
          history: 'push',
          // Opened from this account's compact list page: Back can pop back to it (#1113).
          // Split view has no list page to return to; there Back leaves the Room as before.
          ...(history.compact &&
          current.pane === 'list' &&
          current.accountId === intent.accountId
            ? { overList: true }
            : {}),
        },
      };
    case 'conversation':
      return resolveWorkspaceNavigation(
        {
          kind: 'room',
          accountId: intent.accountId,
          roomId: intent.roomId,
          origin: 'global-search',
        },
        current,
      );
    case 'space':
      return resolveWorkspaceNavigation(
        {
          kind: 'scope',
          accountId: intent.accountId,
          scope: { kind: 'space', spaceId: intent.spaceId },
        },
        current,
      );
    case 'notification': {
      const accountId = intent.accountId ?? current.accountId;
      if (!accountId) return null;
      return {
        destination: {
          accountId,
          scope: RECENT_WORKSPACE_SCOPE,
          roomId: intent.roomId ?? null,
          pane: intent.roomId ? 'conversation' : 'list',
        },
        options: { source: 'user', history: 'push' },
      };
    }
    case 'restoration':
      return {
        destination: {
          accountId: intent.accountId,
          scope: intent.scope,
          roomId: intent.roomId,
          pane: intent.pane,
        },
        options: {
          source: intent.canonical ? 'restore' : 'repair',
          history: 'replace',
        },
      };
    case 'person':
    case 'invitation':
    case 'history':
      return null;
    case 'list': {
      if (!current.accountId) return null;
      const roomRemoved = intent.origin === 'room-removed';
      return {
        destination: {
          accountId: current.accountId,
          scope: current.scope,
          roomId: roomRemoved ? null : current.roomId,
          pane: 'list',
        },
        options: {
          source: roomRemoved
            ? 'repair'
            : intent.origin === 'workspace-back'
              ? 'back'
              : 'user',
          // Pop a Conversation opened over its list, so the entry below is the list Back
          // returns to and WebKit's swipe agrees. Otherwise replace it: a pushed list entry
          // would leave the Conversation one swipe back (#1113).
          history:
            !roomRemoved && history.listBelow && current.pane === 'conversation'
              ? 'back'
              : 'replace',
        },
      };
    }
  }
}
