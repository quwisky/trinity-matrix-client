import {
  CLEAR_DATA_CONFIRMATION_WORD,
  classifyClearDataIntent,
  clearDataMessage,
  type ClearDataIntent,
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
