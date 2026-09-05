import { Injectable, inject } from '@angular/core';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  ACCOUNT_REMOVAL_CONSEQUENCES,
  CLEAR_DATA_CONFIRMATION_WORD,
  CLEAR_DATA_MISTYPED_MESSAGE,
  classifyClearDataIntent,
  clearDataMessage,
} from '@trinity/data-access/accounts';
import {
  RESET_CONFIG_CONFIRMATION_WORD,
  RESET_CONFIG_CONSEQUENCES,
  RESET_CONFIG_MISTYPED_MESSAGE,
  classifyResetConfigIntent,
} from '@trinity/platform-native';
import { EMPTY, filter, map, switchMap, type Observable } from 'rxjs';
import { ApplicationRuntimeService } from '../application-runtime.service';
import type {
  ApplicationRecoveryOutcome,
  ApplicationStartupRecovery,
} from '../application-runtime.models';

/** Owns destructive startup-recovery confirmation and result presentation. */
@Injectable({ providedIn: 'root' })
export class ApplicationRecoveryPresenter {
  private readonly runtime = inject(ApplicationRuntimeService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);

  confirmAndRecover(
    recovery: ApplicationStartupRecovery,
  ): Observable<ApplicationRecoveryOutcome> {
    if (recovery === 'reauthenticate') {
      return this.alert
        .confirm$({
          header: 'Remove account and sign in again',
          message: ACCOUNT_REMOVAL_CONSEQUENCES,
          confirmText: 'Remove account',
          cancelText: 'Cancel',
          variant: 'danger',
        })
        .pipe(
          filter(Boolean),
          switchMap(() => this.runtime.recover()),
        );
    }
    if (recovery === 'reset-installation') {
      return this.alert
        .prompt$({
          header: 'Erase all Trinity data',
          message: clearDataMessage(null),
          placeholder: CLEAR_DATA_CONFIRMATION_WORD,
          inputLabel: `Type ${CLEAR_DATA_CONFIRMATION_WORD} to confirm`,
          confirmText: 'Erase everything',
          cancelText: 'Cancel',
          variant: 'danger',
        })
        .pipe(
          map(classifyClearDataIntent),
          switchMap((intent) => {
            if (intent === 'mistyped') {
              this.toast.show(CLEAR_DATA_MISTYPED_MESSAGE, { duration: 4000 });
            }
            return intent === 'confirmed' ? this.runtime.recover() : EMPTY;
          }),
        );
    }
    if (recovery === 'reset-preferences') {
      return this.alert
        .prompt$({
          header: 'Reset settings to defaults',
          message: `${RESET_CONFIG_CONSEQUENCES}\n\nType ${RESET_CONFIG_CONFIRMATION_WORD} to confirm.`,
          placeholder: RESET_CONFIG_CONFIRMATION_WORD,
          inputLabel: `Type ${RESET_CONFIG_CONFIRMATION_WORD} to confirm`,
          confirmText: 'Reset settings',
          cancelText: 'Cancel',
          variant: 'danger',
        })
        .pipe(
          map(classifyResetConfigIntent),
          switchMap((intent) => {
            if (intent === 'mistyped') {
              this.toast.show(RESET_CONFIG_MISTYPED_MESSAGE, {
                duration: 4000,
              });
            }
            return intent === 'confirmed' ? this.runtime.recover() : EMPTY;
          }),
        );
    }
    return this.runtime.recover();
  }

  present(outcome: ApplicationRecoveryOutcome): void {
    if (outcome.kind !== 'unavailable') return;
    if (outcome.reason === 'cleanup-in-progress') {
      this.toast.show(
        'Cleanup is still running. Leaving this screen does not cancel it; use recovery again to observe the same attempt.',
        { duration: 6000 },
      );
      return;
    }
    if (outcome.reason === 'partial-cleanup') {
      const restartRequired = outcome.cleanup.issues.some(
        ({ recovery }) => recovery === 'restart-application',
      );
      this.toast.show(
        restartRequired
          ? 'Cleanup finished with some residue. Restart Trinity before trying recovery again.'
          : 'Cleanup finished with residue. Use recovery again to retry only the remaining safe work.',
        { duration: 6000 },
      );
    }
  }
}
