import { DestroyRef, Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AuthService } from '@trinity/data-access/auth';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { TrnAlertService } from '@trinity/components/overlay';
import { RoomShellNavigationService } from './room-shell-navigation.service';

/**
 * Session-level actions reachable from the account menu: switching account, adding one,
 * re-authenticating a soft-logged-out one, signing out, and leaving for settings.
 *
 * Distinct from {@link AccountRoutingService}, which routes a *selection* to the account
 * that owns it. This one changes which account the whole shell is signed in as.
 */
@Injectable()
export class SessionActionsService {
  private readonly nav = inject(RoomShellNavigationService);
  private readonly auth = inject(AuthService);
  private readonly matrix = inject(MatrixClientService);
  private readonly router = inject(Router);
  private readonly alert = inject(TrnAlertService);
  private readonly destroyRef = inject(DestroyRef);

  goToSettings(): void {
    void this.router.navigateByUrl('/settings');
  }

  /** Switch the active account (no-op when it is already active). */
  switchAccount(userId: string): void {
    if (userId === this.matrix.activeUserId()) {
      return;
    }
    // Close the open room FIRST. Its panes are bound to this account's client and Room
    // objects, and timeline/threads/pinned all early-return on `open(sameRoomId)` — so
    // leaving it open would keep projecting the outgoing account's data (including its
    // decryption) with no way to re-bind short of a reload. The user re-picks a room on
    // the new account, which opens it cleanly.
    this.nav.closeOpenRoom();
    this.nav.resetViewScope();
    this.auth
      .switchAccount(userId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
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
    // Captured before the sign-out mutates the registry: signing out the last
    // account tears everything down → back to login; otherwise another account is
    // now active and we stay in the shell.
    const wasLastAccount = this.matrix.accountIds().length <= 1;
    this.auth
      .logout(userId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (wasLastAccount) {
          void this.router.navigateByUrl('/login', { replaceUrl: true });
        }
      });
  }
}
