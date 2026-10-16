import { InjectionToken, type Signal } from '@angular/core';

/** Navigation access to application-owned health and its startup-safe status surface. */
export interface WorkspaceSystemStatus {
  readonly hasProblems: Signal<boolean>;
  /** Which prompt owns the one global banner slot; `null` means no global banner. */
  readonly bannerSlot: Signal<'status' | 'encryption' | null>;
  /**
   * Whether the slot has held the status notice in this session, so a prompt that may
   * replace it keeps the notice's height instead of moving the page below the slot.
   */
  readonly bannerSlotReserved: Signal<boolean>;
  /** Open System status; closing it returns focus to whatever had it. */
  show(): void;
}

export const WORKSPACE_SYSTEM_STATUS =
  new InjectionToken<WorkspaceSystemStatus>('WORKSPACE_SYSTEM_STATUS');
