import type { WorkspaceNavigationScope } from '@trinity/application/workspace';

export type WorkspaceScope = WorkspaceNavigationScope;

export interface WorkspaceDestination {
  readonly accountId: string;
  readonly scope: WorkspaceScope;
  readonly roomId: string | null;
  readonly pane: 'list' | 'conversation';
}

export interface WorkspaceView {
  readonly accountId: string | null;
  readonly scope: WorkspaceScope;
  readonly roomId: string | null;
  readonly pane: 'list' | 'conversation';
}

export type WorkspacePlacement = 'list' | 'conversation' | 'split';

export type WorkspaceNavigationSource =
  'user' | 'hop' | 'back' | 'restore' | 'repair';

export interface WorkspaceOpenOptions {
  readonly source: WorkspaceNavigationSource;
  readonly history: 'push' | 'replace';
}

export interface WorkspaceTransitionMetrics {
  readonly durationMs: number;
  readonly accountDurationMs: number;
  readonly routeDurationMs: number;
}

/** One event anchor requested by an inbound Workspace destination. */
export interface WorkspaceEventTarget {
  readonly eventId: string;
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
