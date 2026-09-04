import type { WorkspaceNavigationIntent } from './workspace-navigation.models';

/** Fully qualified Global Search intents accepted by semantic Workspace navigation. */
export type WorkspaceSearchIntent = Extract<
  WorkspaceNavigationIntent,
  { readonly kind: 'conversation' | 'space' | 'person' | 'invitation' }
>;
