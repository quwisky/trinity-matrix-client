import type {
  WorkspaceNavigationScope,
  WorkspaceTransitionMetrics,
  WorkspaceView,
} from './workspace-navigation.models';

export type {
  WorkspaceEventTarget,
  WorkspacePlacement,
  WorkspaceTransitionMetrics,
  WorkspaceView,
} from './workspace-navigation.models';

export type WorkspaceScope = WorkspaceNavigationScope;

export interface WorkspaceDestination {
  readonly accountId: string;
  readonly scope: WorkspaceScope;
  readonly roomId: string | null;
  readonly pane: 'list' | 'conversation';
}

export type WorkspaceNavigationSource =
  'user' | 'hop' | 'back' | 'restore' | 'repair';

export interface WorkspaceOpenOptions {
  readonly source: WorkspaceNavigationSource;
  readonly history: 'push' | 'replace';
  /** Present when a semantic command also owns the canonical event-anchor projection. */
  readonly eventId?: string | null;
  /** Re-attach projections when the semantic state survived outside the Workspace route. */
  readonly force?: boolean;
}

export type WorkspaceOpenFailure =
  'account-transition-failed' | 'navigation-rejected';

export type WorkspaceOpenOutcome =
  | {
      readonly kind: 'ready';
      readonly view: WorkspaceView;
      readonly repaired: boolean;
      readonly metrics: WorkspaceTransitionMetrics;
    }
  | {
      readonly kind: 'failed';
      readonly destination: WorkspaceDestination;
      readonly failure: WorkspaceOpenFailure;
    }
  | {
      readonly kind: 'transition-in-progress';
      readonly destination: WorkspaceDestination;
    };

export const RECENT_WORKSPACE_SCOPE: WorkspaceScope = Object.freeze({
  kind: 'recent',
});

export function workspaceViewOf(
  destination: WorkspaceDestination,
): WorkspaceView {
  return Object.freeze({
    ...destination,
    scope: Object.freeze({ ...destination.scope }),
  });
}

export function sameWorkspaceDestination(
  left: Pick<WorkspaceView, 'accountId' | 'scope' | 'roomId' | 'pane'>,
  right: Pick<WorkspaceView, 'accountId' | 'scope' | 'roomId' | 'pane'>,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.roomId === right.roomId &&
    left.pane === right.pane &&
    sameWorkspaceScope(left.scope, right.scope)
  );
}

export function sameWorkspaceScope(
  left: WorkspaceScope,
  right: WorkspaceScope,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== 'space' ||
      (right.kind === 'space' && left.spaceId === right.spaceId))
  );
}
