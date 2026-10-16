import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';

/** How an account-removal request ended, for the surface that asked. */
export type AccountRemovalOutcome =
  /** A question was cancelled; nothing was removed. */
  | { readonly kind: 'kept' }
  /** The person chose to export room keys first; nothing was removed. */
  | { readonly kind: 'export-keys' }
  /**
   * Removed, possibly with cleanup left over (the flow has said so). With no account
   * left, the flow has already gone to sign-in.
   */
  | {
      readonly kind: 'removed';
      readonly remainingAccountIds: readonly string[];
    }
  /** Removal is still running in the background; the flow has said so. */
  | { readonly kind: 'still-running' }
  /** Nothing could be removed right now. */
  | { readonly kind: 'failed' };

/** Removes an account from this device after the account menu's two questions. */
export interface AccountRemovalLauncher {
  remove(accountId: string): Observable<AccountRemovalOutcome>;
}

/**
 * "Remove account from this device" for the account menu and the new-device check. Declared
 * in this shared tier because the Crypto feature, a Trust capability, may import neither
 * Accounts nor an application library. Application Runtime provides it.
 */
export const ACCOUNT_REMOVAL_LAUNCHER =
  new InjectionToken<AccountRemovalLauncher>('ACCOUNT_REMOVAL_LAUNCHER');
