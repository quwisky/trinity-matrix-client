import type { Observable } from 'rxjs';

/**
 * Product intent for opening one exact Room from the Workspace room list.
 *
 * Callers identify what the user selected. Workspace owns the current scope,
 * Conversation pane, canonical URL, history policy, and Account transition.
 */
export interface WorkspaceRoomNavigationIntent {
  readonly kind: 'room';
  readonly accountId: string;
  readonly roomId: string;
  readonly origin: 'room-list';
}

/** Semantic navigation commands accepted by Workspace during the migration. */
export type WorkspaceNavigationIntent = WorkspaceRoomNavigationIntent;

/** Presentation-neutral result of one semantic Workspace navigation command. */
export type WorkspaceNavigationOutcome =
  | {
      readonly kind: 'ready';
      readonly change: 'committed' | 'unchanged';
    }
  | {
      readonly kind: 'unavailable';
      readonly reason:
        | 'account-transition-failed'
        | 'navigation-rejected'
        | 'transition-in-progress';
    };

/** Application-owned semantic navigation seam. */
export interface WorkspaceNavigation {
  navigate(
    intent: WorkspaceNavigationIntent,
  ): Observable<WorkspaceNavigationOutcome>;
}
