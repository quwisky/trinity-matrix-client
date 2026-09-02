import type { TrnAlertService } from '@trinity/components/overlay';
import { map, type Observable } from 'rxjs';

/**
 * The word the user has to type before every setting goes back to its default.
 *
 * Deliberately NOT the `RESET` of the encryption-reset flow or the `ERASE` of the
 * clear-all-data gate — `scripts/confirmation-words.spec.mjs` holds that invariant, because
 * muscle memory carried from one type-to-confirm gate to another is exactly what typing a
 * word is meant to prevent, and the other two destroy far more than this one.
 */
export const RESET_CONFIG_CONFIRMATION_WORD = 'DEFAULTS';

/**
 * What the user is agreeing to, cost first.
 *
 * Kept here as prose rather than inline so the wording is reviewed as wording. The order
 * matters: what is lost, then what is untouched — someone resetting because a setting has
 * wedged needs to know their accounts and half-typed messages are not part of the deal.
 */
export const RESET_CONFIG_CONSEQUENCES = [
  'Every setting in this document goes back to its default on this device: appearance, privacy, timeline, date and time formats, keyboard shortcuts, the GIF provider and its API key, and the push gateway.',
  'Clearing the push gateway also removes this device’s push registrations from your homeserver, so notifications stop until you set a gateway up again. Nothing else on the server changes.',
  'You stay signed in, and unsent drafts are kept.',
  'There is no undo. Copy or export the document first if you might want these values back.',
].join('\n\n');

/** What the type-to-confirm gate decided. Cancelling and mistyping are both "no". */
export type ResetConfigIntent = 'confirmed' | 'cancelled' | 'mistyped';

/** Said after a mistype — silence there is indistinguishable from a broken button. */
export const RESET_CONFIG_MISTYPED_MESSAGE = `Nothing was reset. Type ${RESET_CONFIG_CONFIRMATION_WORD} exactly to confirm.`;

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
    .pipe(
      map((typed) => {
        if (typed === null) {
          return 'cancelled';
        }
        return typed.trim().toUpperCase() === RESET_CONFIG_CONFIRMATION_WORD
          ? 'confirmed'
          : 'mistyped';
      }),
    );
}
