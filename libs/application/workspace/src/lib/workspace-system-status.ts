import { InjectionToken, type Signal } from '@angular/core';

/**
 * Which encryption prompt the global banner slot holds. The same kinds as Trust's slot
 * forecast; the application composition asserts that the two stay identical.
 */
export type SlotForecast =
  'needs-setup' | 'needs-recovery' | 'needs-verification' | 'setup-elsewhere';

/** The encryption prompt laid out in the global banner slot. */
export interface BannerPrompt {
  readonly kind: SlotForecast;
  /**
   * Layout only: the prompt holds its space but is hidden, unannounced and inert. True for
   * a forecast the live status has not confirmed, and for a held prompt the live status no
   * longer supports while a press keeps the slot unchanged.
   */
  readonly placeholder: boolean;
}

/** Navigation access to application-owned health and its startup-safe status surface. */
export interface WorkspaceSystemStatus {
  readonly hasProblems: Signal<boolean>;
  /** Which prompt owns the one global banner slot; `null` means no global banner. */
  readonly bannerSlot: Signal<'status' | 'encryption' | 'sign-in-again' | null>;
  /**
   * Whether the slot has held the status notice in this session, so a prompt that may
   * replace it keeps the notice's height instead of moving the page below the slot.
   */
  readonly bannerSlotReserved: Signal<boolean>;
  /**
   * The encryption prompt the slot holds, held with the slot while a pointer is pressed;
   * `null` unless {@link bannerSlot} is `'encryption'`.
   */
  readonly bannerPrompt: Signal<BannerPrompt | null>;
  /** Hide the prompt to sign in again for the active Account until the next app start. */
  dismissSignInAgain(): void;
  /** Open System status; closing it returns focus to whatever had it. */
  show(): void;
}

export const WORKSPACE_SYSTEM_STATUS =
  new InjectionToken<WorkspaceSystemStatus>('WORKSPACE_SYSTEM_STATUS');
