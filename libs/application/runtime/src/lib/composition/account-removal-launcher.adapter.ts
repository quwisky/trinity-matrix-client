import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, ReplaySubject, map, of, switchMap } from 'rxjs';
import {
  TrnAlertService,
  TrnToastService,
  type TrnAlertChoice,
} from '@trinity/components/overlay';
import {
  ACCOUNT_REMOVAL_CONSEQUENCES,
  AccountRuntimeService,
  ROOM_KEYS_AT_RISK,
  ROOM_KEYS_MAY_BE_LOST,
  roomKeysAtRiskHeader,
  type AccountSignOutOutcome,
} from '@trinity/data-access/accounts';
import { SESSION_ENGINE } from '@trinity/data-access/matrix-client';
import type {
  AccountRemovalLauncher,
  AccountRemovalOutcome,
} from '@trinity/platform-native';

const KEPT: AccountRemovalOutcome = Object.freeze({ kind: 'kept' });
const EXPORT_KEYS: AccountRemovalOutcome = Object.freeze({
  kind: 'export-keys',
});
const STILL_RUNNING: AccountRemovalOutcome = Object.freeze({
  kind: 'still-running',
});
const FAILED: AccountRemovalOutcome = Object.freeze({ kind: 'failed' });

/**
 * `ACCOUNT_REMOVAL_LAUNCHER`: the one "Remove account from this device" flow, for the
 * account menu and the new-device check. Callers open Security settings for "Export keys"
 * and say when nothing could be removed, each in its own way.
 *
 * Once the sign-out has started, its messages and the move to sign-in belong to this flow,
 * not to the caller: the sign-out can end the surface that asked (the new-device check
 * leaves as soon as its account is gone), and unsubscribing it must not drop them.
 */
@Injectable({ providedIn: 'root' })
export class AccountRemovalLauncherAdapter implements AccountRemovalLauncher {
  private readonly accounts = inject(AccountRuntimeService);
  private readonly engine = inject(SESSION_ENGINE);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly router = inject(Router);

  remove(accountId: string): Observable<AccountRemovalOutcome> {
    return this.alert
      .confirm$({
        header: 'Remove account',
        message: `Account ${accountId}\n\n${ACCOUNT_REMOVAL_CONSEQUENCES}`,
        confirmText: 'Remove account',
        variant: 'danger',
      })
      .pipe(
        switchMap((confirmed) =>
          confirmed
            ? this.confirmRoomKeysLoss(accountId)
            : of<TrnAlertChoice>('cancel'),
        ),
        switchMap((choice): Observable<AccountRemovalOutcome> => {
          switch (choice) {
            case 'confirm':
              return this.signOut(accountId);
            case 'alternative':
              return of(EXPORT_KEYS);
            case 'cancel':
              return of(KEPT);
            default: {
              const unhandled: never = choice;
              void unhandled;
              return of(KEPT);
            }
          }
        }),
      );
  }

  /**
   * Removing an account deletes its room keys from this device. When key backup is known
   * to be incomplete, offer the existing key export first ('alternative'); when the status
   * cannot be read, nothing can export either, so only warn.
   */
  private confirmRoomKeysLoss(accountId: string): Observable<TrnAlertChoice> {
    return this.engine.roomKeysBackedUp(accountId).pipe(
      switchMap((backedUp): Observable<TrnAlertChoice> => {
        if (backedUp) {
          return of('confirm');
        }
        const header = roomKeysAtRiskHeader(backedUp);
        if (backedUp === null) {
          return this.alert
            .confirm$({
              header,
              message: `Account ${accountId}\n\n${ROOM_KEYS_MAY_BE_LOST}`,
              confirmText: 'Remove anyway',
              variant: 'danger',
            })
            .pipe(map((confirmed) => (confirmed ? 'confirm' : 'cancel')));
        }
        return this.alert.choose$({
          header,
          message: `Account ${accountId}\n\n${ROOM_KEYS_AT_RISK}`,
          alternativeText: 'Export keys',
          confirmText: 'Remove anyway',
          variant: 'danger',
        });
      }),
    );
  }

  private signOut(accountId: string): Observable<AccountRemovalOutcome> {
    // Finite: Accounts bounds how long a sign-out is observed.
    const outcome = new ReplaySubject<AccountRemovalOutcome>(1);
    this.accounts
      .signOutAccount(accountId)
      .pipe(map((settled) => this.settle(settled)))
      .subscribe(outcome);
    return outcome.asObservable();
  }

  private settle(outcome: AccountSignOutOutcome): AccountRemovalOutcome {
    switch (outcome.kind) {
      case 'ready':
      case 'partial-cleanup':
        if (outcome.kind === 'partial-cleanup') {
          const restartRequired = outcome.issues.some(
            ({ recovery }) => recovery === 'restart-application',
          );
          this.showError(
            restartRequired
              ? 'Account removal finished with some cleanup incomplete. Restart Trinity before trying again.'
              : 'Account removal finished with some cleanup incomplete. Retry it to run only safe remaining work.',
          );
        }
        if (outcome.remainingAccountIds.length === 0) {
          void this.router.navigateByUrl('/login', { replaceUrl: true });
        }
        return {
          kind: 'removed',
          remainingAccountIds: outcome.remainingAccountIds,
        };
      case 'uncertain-cleanup':
        this.showError(
          'Account removal is still running. Closing this message does not cancel it.',
        );
        return STILL_RUNNING;
      case 'failed':
      case 'transition-in-progress':
        return FAILED;
      default: {
        const unhandled: never = outcome;
        void unhandled;
        return FAILED;
      }
    }
  }

  private showError(message: string): void {
    this.toast.show(message, { duration: 4000, variant: 'danger' });
  }
}
