import type { TrnAlertService } from '@trinity/components/overlay';
import { catchError, of, type Observable } from 'rxjs';

/**
 * Why leaving right now would cost something.
 *
 * `unsaved-key` is the shown-once recovery key both crypto surfaces render through
 * {@link RecoveryKeySaveComponent}; the two `*-in-flight` variants are the operations
 * that mint one and cannot be cancelled once they are running. Named after the action
 * rather than shared, because "we are resetting your encryption" is a lie to someone
 * who is setting it up for the first time.
 */
export type LeaveRisk = 'unsaved-key' | 'setup-in-flight' | 'reset-in-flight';

const QUESTIONS: Record<LeaveRisk, { header: string; message: string }> = {
  'unsaved-key': {
    header: 'Leave without saving your key?',
    message:
      "This key is shown once. Leave now and you won't be able to recover your messages on another device.",
  },
  'setup-in-flight': {
    header: 'Encryption setup in progress',
    message:
      "Leaving won't stop it, and the recovery key it creates will be lost — your messages would be backed up with a key you never saw. Wait for it to finish.",
  },
  'reset-in-flight': {
    header: 'Encryption reset in progress',
    message:
      "Leaving won't stop it, and the new recovery key it produces will be lost. Wait for it to finish.",
  },
};

/**
 * Whether it is safe to leave, asking the user when it is not.
 *
 * Lives here rather than on either page because setup and unlock ask the identical
 * question: both display a recovery key exactly once and never persist it, and both are
 * dismissed by the browser's own back button, which tears the component down without
 * asking anyone. One copy of the wording, so the two cannot drift apart again.
 *
 * Fails towards staying: if the confirmation itself cannot be shown there is nothing to
 * read, and refusing to leave loses nothing that cannot be retried.
 */
export function confirmLeaving(
  alert: TrnAlertService,
  risk: LeaveRisk | null,
): Observable<boolean> {
  if (!risk) {
    return of(true);
  }
  return alert
    .confirm$({
      ...QUESTIONS[risk],
      confirmText: 'Leave anyway',
      cancelText: 'Stay',
      variant: 'danger',
    })
    .pipe(catchError(() => of(false)));
}
