import { InjectionToken, type Signal } from '@angular/core';

/** Navigation access to application-owned health and its startup-safe status surface. */
export interface WorkspaceSystemStatus {
  readonly hasProblems: Signal<boolean>;
  show(restoreFocus?: () => void): void;
}

export const WORKSPACE_SYSTEM_STATUS =
  new InjectionToken<WorkspaceSystemStatus>('WORKSPACE_SYSTEM_STATUS');
