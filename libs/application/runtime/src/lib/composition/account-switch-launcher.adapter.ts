import { Injectable, computed, inject } from '@angular/core';
import { Observable, catchError, defer, map, of } from 'rxjs';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import type { AccountSwitchLauncher } from '@trinity/platform-native';

/**
 * `ACCOUNT_SWITCH_LAUNCHER`: "Use another account" on the new-device check. Switches with
 * Accounts' own switch workflow, the one the account switcher's Workspace navigation runs,
 * but without Workspace's Rooms projection: that would open Rooms while the account on the
 * check is still active, and the route guard would send it straight back. The check opens
 * Rooms itself once the switch has landed.
 */
@Injectable({ providedIn: 'root' })
export class AccountSwitchLauncherAdapter implements AccountSwitchLauncher {
  private readonly accounts = inject(AccountRuntimeService);
  private readonly matrix = inject(SessionStateService);
  /** The first signed-in account besides the active one, in the switcher's order. */
  private readonly otherAccountId = computed(() => {
    const active = this.accounts.activeAccountId();
    return this.matrix.accountIds().find((id) => id !== active) ?? null;
  });

  readonly hasOtherAccount = computed(() => this.otherAccountId() !== null);

  switchToOther(): Observable<boolean> {
    return defer(() => {
      const accountId = this.otherAccountId();
      if (!accountId) return of(false);
      return this.accounts.switchActiveAccount(accountId).pipe(
        map((outcome) => outcome.kind === 'ready'),
        catchError(() => of(false)),
      );
    });
  }
}
