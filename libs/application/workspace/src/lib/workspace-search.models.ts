/**
 * A fully qualified intent emitted by Global Search and resolved by Workspace.
 *
 * People and invitations are intents rather than final Room destinations because
 * Workspace must first create or join the Room on the named Account.
 */
export type WorkspaceSearchIntent =
  | {
      readonly kind: 'conversation';
      readonly accountId: string;
      readonly roomId: string;
    }
  | {
      readonly kind: 'space';
      readonly accountId: string;
      readonly spaceId: string;
    }
  | {
      readonly kind: 'person';
      readonly accountId: string;
      readonly userId: string;
    }
  | {
      readonly kind: 'invitation';
      readonly accountId: string;
      readonly roomId: string;
      readonly target: 'conversation' | 'direct' | 'space';
    };
