import { DestroyRef, Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { TrnAlertService } from '@trinity/components/overlay';
import { SettingsDialogService } from '@trinity/components/settings-dialog';
import { ShellStatusService } from './shell-status.service';
import { WorkspaceService } from './workspace.service';

/**
 * Session-level actions reachable from the account menu: switching account, adding one,
 * re-authenticating a soft-logged-out one, signing out, and leaving for settings.
 *
 * Distinct from {@link AccountRoutingService}, which routes a *selection* to the account
 * that owns it. This one changes which account the whole shell is signed in as.
 */
@Injectable()
export class SessionActionsService {
  private readonly accounts = inject(AccountRuntimeService);
  private readonly workspace = inject(WorkspaceService);
  private readonly matrix = inject(MatrixClientService);
  private readonly router = inject(Router);
  private readonly settings = inject(SettingsDialogService);
  private readonly alert = inject(TrnAlertService);
  private readonly status = inject(ShellStatusService);
  private readonly destroyRef = inject(DestroyRef);

  goToSettings(): void {
    void this.settings.open();
  }

  /** Switch the active account (no-op when it is already active). */
  switchAccount(userId: string): void {
    if (userId === this.matrix.activeUserId()) {
      return;
    }
    this.workspace
      .open(this.workspace.accountDestination(userId), {
        source: 'user',
        history: 'push',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => {
        if (outcome.kind !== 'ready') {
          void this.status.showError('Unable to switch accounts right now.');
        }
      });
  }

  /** Start adding another account: route to the login screen in add mode. */
  addAccount(): void {
    void this.router.navigate(['/login'], { queryParams: { add: 1 } });
  }

  /** Re-authenticate a soft-logged-out account: route to the login prefilled for it. */
  reauthAccount(userId: string): void {
    void this.router.navigate(['/login'], { queryParams: { reauth: userId } });
  }

  async logout(userId: string): Promise<void> {
    const confirmed = await this.alert.confirm({
      header: 'Sign out',
      message: 'Sign out of this account on this device?',
      confirmText: 'Sign out',
      destructive: true,
    });
    if (!confirmed) {
      return;
    }
    this.accounts
      .signOutAccount(userId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => {
        if (
          (outcome.kind === 'ready' || outcome.kind === 'partial-cleanup') &&
          outcome.remainingAccountIds.length === 0
        ) {
          void this.router.navigateByUrl('/login', { replaceUrl: true });
        } else if (outcome.kind !== 'ready') {
          void this.status.showError('Unable to fully sign out right now.');
        }
      });
  }
}
