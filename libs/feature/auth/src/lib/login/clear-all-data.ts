import {
  CLEAR_DATA_CONFIRMATION_WORD,
  classifyClearDataIntent,
  clearDataMessage,
  type ClearDataIntent,
  type InstallationResetOutcome,
} from '@trinity/data-access/accounts';
import type { TrnAlertService } from '@trinity/components/overlay';
import { map, type Observable } from 'rxjs';

export {
  CLEAR_DATA_CONFIRMATION_WORD,
  CLEAR_DATA_CONSEQUENCES,
  CLEAR_DATA_MISTYPED_MESSAGE,
  clearDataMessage,
  signedInWarning,
} from '@trinity/data-access/accounts';

/** Logged with value-free scope identifiers when cleanup settles with residue. */
export const CLEAR_DATA_RESIDUE_WARNING =
  'Trinity: some local data could not be cleared:';

/** Ask for typed confirmation immediately before the reset command is dispatched. */
export function confirmClearDataIntent(
  alert: TrnAlertService,
  signedInUserIds: readonly string[] | null,
): Observable<ClearDataIntent> {
  return alert
    .prompt$({
      header: 'Erase all Trinity data',
      message: clearDataMessage(signedInUserIds),
      placeholder: CLEAR_DATA_CONFIRMATION_WORD,
      inputLabel: `Type ${CLEAR_DATA_CONFIRMATION_WORD} to confirm`,
      confirmText: 'Erase everything',
      cancelText: 'Cancel',
      variant: 'danger',
    })
    .pipe(map(classifyClearDataIntent));
}

/**
 * The message for an installation reset that did not finish, or `null` when it did and
 * the app should restart. Wording is specific to the erase flow on purpose: account
 * removal in the rooms shell reports a different operation in its own terms.
 */
export function installationResetFailureMessage(
  outcome: InstallationResetOutcome,
): string | null {
  switch (outcome.kind) {
    case 'ready':
      return null;
    case 'transition-in-progress':
      return 'Another account change is still in progress. Try again.';
    case 'uncertain-cleanup':
      return 'Cleanup is still running. Closing this page does not cancel it; try again to check the same attempt.';
    case 'partial-cleanup':
      return outcome.issues.some(
        ({ recovery }) => recovery === 'restart-application',
      )
        ? 'Some cleanup could not be completed. Restart Trinity before trying again.'
        : 'Some cleanup could not be completed. Try again to retry only the remaining safe work.';
  }
}
