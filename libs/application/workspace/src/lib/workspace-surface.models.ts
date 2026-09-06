/** Semantic application surfaces coordinated above product capabilities. */
export type WorkspaceApplicationSurface =
  | {
      readonly kind: 'settings';
      readonly section: string | null;
    }
  | {
      readonly kind: 'trust';
      readonly flow: 'setup' | 'unlock' | 'verify';
    };

/** Compare semantic application identities without leaking presentation details. */
export function sameWorkspaceApplicationSurface(
  left: WorkspaceApplicationSurface,
  right: WorkspaceApplicationSurface,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'settings' && right.kind === 'settings'
    ? left.section === right.section
    : left.kind === 'trust' && right.kind === 'trust'
      ? left.flow === right.flow
      : false;
}

/** Presentation-neutral context carried with an application-surface intent. */
export interface WorkspaceApplicationSurfaceContext {
  /** Semantic return destination for a routed trust flow. */
  readonly returnTo?: WorkspaceApplicationSurface;
  /** Optional Room whose image packs Settings should edit. */
  readonly sourceRoomId?: string;
  /** A nested application surface must remain modal over its semantic owner. */
  readonly placement?: 'auto' | 'nested';
  /** The lazy presenter drops a result whose requesting owner no longer exists. */
  readonly ownerActive?: () => boolean;
  /** Logical focus owner restored after a modal presentation ends or fails. */
  readonly restoreFocus?: () => void;
  /** Enter unlock with the destructive recovery reset already offered. */
  readonly offerReset?: boolean;
}

/** One request to present a typed application surface. */
export interface WorkspaceApplicationSurfaceRequest {
  readonly surface: WorkspaceApplicationSurface;
  readonly context?: WorkspaceApplicationSurfaceContext;
}

export type WorkspaceApplicationSurfaceOutcome =
  | {
      readonly kind: 'presented';
      readonly surface: WorkspaceApplicationSurface;
    }
  | {
      readonly kind: 'unavailable';
      readonly surface: WorkspaceApplicationSurface;
    };

/** Semantic surfaces nested inside one exact Room destination. */
export type WorkspaceRoomSurface =
  | {
      readonly kind: 'settings';
      readonly accountId: string;
      readonly roomId: string;
    }
  | { readonly kind: 'members' }
  | { readonly kind: 'threads' }
  | { readonly kind: 'thread'; readonly rootEventId: string }
  | { readonly kind: 'pinned' }
  | { readonly kind: 'search' }
  | { readonly kind: 'member'; readonly userId: string };

/** The compact master-detail Conversation, below Room surfaces in the Back order. */
export interface WorkspaceConversationSurface {
  readonly kind: 'conversation';
  readonly accountId: string;
  readonly roomId: string;
}

/** One semantic surface and its fixed position in the Workspace Back policy. */
export type WorkspaceSurface =
  | {
      readonly layer: 'application';
      readonly surface: WorkspaceApplicationSurface;
    }
  | {
      readonly layer: 'room';
      readonly surface: WorkspaceRoomSurface;
    }
  | {
      readonly layer: 'conversation';
      readonly surface: WorkspaceConversationSurface;
    };

/** A surface either closed or deliberately retained the Back press. */
export type WorkspaceDismissResult = 'dismissed' | 'blocked';

/** Typed result of offering one Back intent to Workspace. */
export type WorkspaceBackOutcome =
  | {
      readonly kind: WorkspaceDismissResult;
      readonly surface: WorkspaceSurface;
    }
  | { readonly kind: 'unhandled' };
