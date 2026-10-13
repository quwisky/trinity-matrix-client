import { InjectionToken, type Signal } from '@angular/core';
import type { Observable } from 'rxjs';

/** Switches away from the active account, for a surface that has no account switcher. */
export interface AccountSwitchLauncher {
  /** Whether another signed-in account is there to switch to. */
  readonly hasOtherAccount: Signal<boolean>;
  /**
   * Make the first other signed-in account, in the account switcher's order, the active
   * one. Answers whether it is active now; false when there is none or the switch failed.
   */
  switchToOther(): Observable<boolean>;
}

/**
 * "Use another account" on the new-device check (`feature/crypto`), so a pending check on
 * one account never blocks the others. Declared in this shared tier because the Crypto
 * feature, a Trust capability, may import neither Accounts nor an application library.
 * Application Runtime provides it.
 */
export const ACCOUNT_SWITCH_LAUNCHER =
  new InjectionToken<AccountSwitchLauncher>('ACCOUNT_SWITCH_LAUNCHER');
