import { DestroyRef, Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  WorkspaceApplicationSurfaceService,
  WorkspaceNavigationService,
} from '@trinity/application/workspace';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { ACCOUNT_REMOVAL_LAUNCHER } from '@trinity/platform-native';
import { ShellStatusService } from './shell-status.service';

/**
 * Session-level actions reachable from the account menu: switching account, adding one,
 * re-authenticating a soft-logged-out one, signing out, and leaving for settings.
 *
 * Distinct from {@link AccountRoutingService}, which routes a *selection* to the account
 * that owns it. This one changes which account the whole shell is signed in as.
 */
@Injectable()
export class SessionActionsService {
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly matrix = inject(SessionStateService);
  private readonly router = inject(Router);
  private readonly applicationSurfaces = inject(
    WorkspaceApplicationSurfaceService,
  );
  private readonly accountRemoval = inject(ACCOUNT_REMOVAL_LAUNCHER);
  private readonly status = inject(ShellStatusService);
  private readonly destroyRef = inject(DestroyRef);

  /** Open Settings, at `section` when given ('security' holds the room key export). */
  goToSettings(section: string | null = null): void {
    this.applicationSurfaces
      .open({ surface: { kind: 'settings', section } })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Switch the active account (no-op when it is already active). */
  switchAccount(userId: string): void {
    if (userId === this.matrix.activeAccountId()) {
      return;
    }
    this.workspace
      .navigate({
        kind: 'account',
        accountId: userId,
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

  /**
   * Remove an account from this device through the shared flow (Application Runtime),
   * which asks the consequences and room-key questions and signs it out. Here: open
   * Security settings when the person exports keys first, and say when nothing could be
   * removed.
   */
  logout(userId: string): void {
    this.accountRemoval
      .remove(userId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => {
        switch (outcome.kind) {
          case 'export-keys':
            this.goToSettings('security');
            break;
          case 'failed':
            this.status.showError('Unable to remove this account right now.');
            break;
          case 'kept':
          case 'removed':
          case 'still-running':
            break;
          default: {
            const unhandled: never = outcome;
            void unhandled;
          }
        }
      });
  }
}
