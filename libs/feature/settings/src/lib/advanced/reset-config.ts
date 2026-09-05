import type { TrnAlertService } from '@trinity/components/overlay';
import {
  RESET_CONFIG_CONFIRMATION_WORD,
  RESET_CONFIG_CONSEQUENCES,
  RESET_CONFIG_MISTYPED_MESSAGE,
  classifyResetConfigIntent,
  type ResetConfigIntent,
} from '@trinity/platform-native';
import { map, type Observable } from 'rxjs';

export {
  RESET_CONFIG_CONFIRMATION_WORD,
  RESET_CONFIG_CONSEQUENCES,
  RESET_CONFIG_MISTYPED_MESSAGE,
};
export type { ResetConfigIntent };

/**
 * Ask for the confirmation word before anything is overwritten.
 *
 * The confirm button stays enabled and the word is checked after the dialog closes, matching
 * the two existing gates: a live-disabled button hides *why* nothing happened, and this flow
 * needs to tell "changed my mind" apart from "typed it wrong".
 */
export function confirmResetConfigIntent$(
  alert: TrnAlertService,
): Observable<ResetConfigIntent> {
  return alert
    .prompt$({
      header: 'Reset settings to defaults',
      message: `${RESET_CONFIG_CONSEQUENCES}\n\nType ${RESET_CONFIG_CONFIRMATION_WORD} to confirm.`,
      placeholder: RESET_CONFIG_CONFIRMATION_WORD,
      inputLabel: `Type ${RESET_CONFIG_CONFIRMATION_WORD} to confirm`,
      confirmText: 'Reset settings',
      cancelText: 'Cancel',
      variant: 'danger',
    })
    .pipe(map(classifyResetConfigIntent));
}
