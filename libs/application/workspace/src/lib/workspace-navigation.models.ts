/** Sidebar scope selected by the user without exposing a URL projection. */
export type WorkspaceNavigationScope =
  | { readonly kind: 'recent' }
  | { readonly kind: 'home' }
  | { readonly kind: 'rooms' }
  | { readonly kind: 'space'; readonly spaceId: string };

/** Why the Room shell is opening an exact Account-and-Room identity. */
export type WorkspaceRoomNavigationOrigin =
  | 'room-list'
  | 'room-action'
  | 'shortcut'
  | 'room-hop'
  | 'direct-invitation'
  | 'room-invitation'
  | 'global-search';

/** Product intent for opening one exact Room. */
export interface WorkspaceRoomNavigationIntent {
  readonly kind: 'room';
  readonly accountId: string;
  readonly roomId: string;
  readonly scope?: WorkspaceNavigationScope;
  readonly origin: WorkspaceRoomNavigationOrigin;
}

/** One Account-and-Room identity eligible for visit-history navigation. */
export interface WorkspaceRoomIdentity {
  readonly accountId: string;
  readonly roomId: string;
}

/** Product intent for switching the active Account from the shell picker. */
export interface WorkspaceAccountNavigationIntent {
  readonly kind: 'account';
  readonly accountId: string;
  readonly origin?: 'account-picker' | 'search-preparation';
}

/** Product intent for selecting one sidebar scope on an exact Account. */
export interface WorkspaceScopeNavigationIntent {
  readonly kind: 'scope';
  readonly accountId: string;
  readonly scope: WorkspaceNavigationScope;
}

/** Product intent for returning to the compact Room list. */
export interface WorkspaceListNavigationIntent {
  readonly kind: 'list';
  readonly origin: 'compact-close' | 'workspace-back' | 'room-removed';
}

/** Product intent for navigating the application-owned visit history. */
export type WorkspaceHistoryNavigationIntent =
  | {
      readonly kind: 'history';
      readonly action: 'hop';
      readonly direction: 'back' | 'forward';
      readonly availableRooms: readonly WorkspaceRoomIdentity[];
    }
  | {
      readonly kind: 'history';
      readonly action: 'jump';
      readonly position: number;
      readonly availableRooms: readonly WorkspaceRoomIdentity[];
    };

/** Exact Conversation selected by Global Search. */
export interface WorkspaceConversationNavigationIntent {
  readonly kind: 'conversation';
  readonly accountId: string;
  readonly roomId: string;
}

/** Exact Space selected by Global Search. */
export interface WorkspaceSpaceNavigationIntent {
  readonly kind: 'space';
  readonly accountId: string;
  readonly spaceId: string;
}

/** Person selected by Global Search before its direct Conversation exists. */
export interface WorkspacePersonNavigationIntent {
  readonly kind: 'person';
  readonly accountId: string;
  readonly userId: string;
}

/** Invitation selected by Global Search before its Room is joined. */
export interface WorkspaceInvitationNavigationIntent {
  readonly kind: 'invitation';
  readonly accountId: string;
  readonly roomId: string;
  readonly target: 'conversation' | 'direct' | 'space';
}

/** Host-neutral activation from a local or native notification. */
export interface WorkspaceNotificationNavigationIntent {
  readonly kind: 'notification';
  readonly accountId?: string;
  readonly roomId?: string;
  readonly eventId?: string;
}

/** Semantic coordinates restored from Workspace's canonical location projection. */
export interface WorkspaceRestorationNavigationIntent {
  readonly kind: 'restoration';
  readonly accountId: string;
  readonly scope: WorkspaceNavigationScope;
  readonly roomId: string | null;
  readonly pane: 'list' | 'conversation';
  readonly eventId?: string;
  readonly canonical: boolean;
}

/** Semantic navigation commands accepted by Workspace. */
export type WorkspaceNavigationIntent =
  | WorkspaceAccountNavigationIntent
  | WorkspaceScopeNavigationIntent
  | WorkspaceRoomNavigationIntent
  | WorkspaceListNavigationIntent
  | WorkspaceHistoryNavigationIntent
  | WorkspaceConversationNavigationIntent
  | WorkspaceSpaceNavigationIntent
  | WorkspacePersonNavigationIntent
  | WorkspaceInvitationNavigationIntent
  | WorkspaceNotificationNavigationIntent
  | WorkspaceRestorationNavigationIntent;

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

/** The single immutable semantic Workspace state. */
export interface WorkspaceView {
  readonly accountId: string | null;
  readonly scope: WorkspaceNavigationScope;
  readonly roomId: string | null;
  readonly pane: 'list' | 'conversation';
}

export type WorkspacePlacement = 'list' | 'conversation' | 'split';

/** One event anchor requested by an inbound Workspace destination. */
export interface WorkspaceEventTarget {
  readonly eventId: string;
}

export interface WorkspaceTransitionMetrics {
  readonly durationMs: number;
  readonly accountDurationMs: number;
  readonly routeDurationMs: number;
}
