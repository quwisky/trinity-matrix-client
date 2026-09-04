import type { WorkspaceNavigationIntent } from '@trinity/application/workspace';
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

/** Resolve one Room-shell intent into the package-private transition protocol. */
export function resolveWorkspaceNavigation(
  intent: WorkspaceNavigationIntent,
  current: WorkspaceView,
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
        options: { source: 'user', history: 'push' },
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
        },
      };
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
          history: intent.origin === 'compact-close' ? 'push' : 'replace',
        },
      };
    }
  }
}
