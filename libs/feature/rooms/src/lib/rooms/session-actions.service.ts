import { DestroyRef, Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  WorkspaceApplicationSurfaceService,
  WorkspaceNavigationService,
} from '@trinity/application/workspace';
import {
  ACCOUNT_REMOVAL_CONSEQUENCES,
  AccountRuntimeService,
  ROOM_KEYS_AT_RISK,
  ROOM_KEYS_MAY_BE_LOST,
  roomKeysAtRiskHeader,
} from '@trinity/data-access/accounts';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  TrnAlertService,
  type TrnAlertChoice,
} from '@trinity/components/overlay';
import { ShellStatusService } from './shell-status.service';
import { filter, map, of, switchMap, tap, type Observable } from 'rxjs';

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
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly matrix = inject(MatrixClientService);
  private readonly router = inject(Router);
  private readonly applicationSurfaces = inject(
    WorkspaceApplicationSurfaceService,
  );
  private readonly alert = inject(TrnAlertService);
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
    if (userId === this.matrix.activeUserId()) {
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

  logout(userId: string): void {
    this.alert
      .confirm$({
        header: 'Remove account',
        message: `Account ${userId}\n\n${ACCOUNT_REMOVAL_CONSEQUENCES}`,
        confirmText: 'Remove account',
        variant: 'danger',
      })
      .pipe(
        filter(Boolean),
        switchMap(() => this.confirmRoomKeysLoss(userId)),
        tap((choice) => {
          if (choice === 'alternative') {
            this.goToSettings('security');
          }
        }),
        filter((choice) => choice === 'confirm'),
        switchMap(() => this.accounts.signOutAccount(userId)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((outcome) => {
        if (outcome.kind === 'partial-cleanup') {
          const restartRequired = outcome.issues.some(
            ({ recovery }) => recovery === 'restart-application',
          );
          this.status.showError(
            restartRequired
              ? 'Account removal finished with some cleanup incomplete. Restart Trinity before trying again.'
              : 'Account removal finished with some cleanup incomplete. Retry it to run only safe remaining work.',
          );
        }
        if (
          (outcome.kind === 'ready' || outcome.kind === 'partial-cleanup') &&
          outcome.remainingAccountIds.length === 0
        ) {
          void this.router.navigateByUrl('/login', { replaceUrl: true });
        } else if (outcome.kind === 'uncertain-cleanup') {
          this.status.showError(
            'Account removal is still running. Closing this message does not cancel it.',
          );
        } else if (
          outcome.kind !== 'ready' &&
          outcome.kind !== 'partial-cleanup'
        ) {
          this.status.showError('Unable to remove this account right now.');
        }
      });
  }

  /**
   * Removing an account deletes its room keys from this device. When key backup is known
   * to be incomplete, offer the existing key export first ('alternative'); when the status
   * cannot be read, nothing can export either, so only warn.
   */
  private confirmRoomKeysLoss(userId: string): Observable<TrnAlertChoice> {
    return this.matrix.roomKeysBackedUp(userId).pipe(
      switchMap((backedUp): Observable<TrnAlertChoice> => {
        if (backedUp) {
          return of('confirm');
        }
        const header = roomKeysAtRiskHeader(backedUp);
        if (backedUp === null) {
          return this.alert
            .confirm$({
              header,
              message: `Account ${userId}\n\n${ROOM_KEYS_MAY_BE_LOST}`,
              confirmText: 'Remove anyway',
              variant: 'danger',
            })
            .pipe(map((confirmed) => (confirmed ? 'confirm' : 'cancel')));
        }
        return this.alert.choose$({
          header,
          message: `Account ${userId}\n\n${ROOM_KEYS_AT_RISK}`,
          alternativeText: 'Export keys',
          confirmText: 'Remove anyway',
          variant: 'danger',
        });
      }),
    );
  }
}
