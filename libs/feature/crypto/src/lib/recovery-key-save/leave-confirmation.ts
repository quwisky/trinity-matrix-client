import type { TrnAlertService } from '@trinity/components/overlay';
import { catchError, of, type Observable } from 'rxjs';

/**
 * Why leaving right now would cost something: `unsaved-key` is the shown-once recovery key
 * rendered through {@link RecoveryKeySaveComponent}; the `*-in-flight` variants are the
 * operations that mint one and cannot be cancelled. Named per action because "we are
 * resetting your encryption" is wrong for a first-time setup.
 */
export type LeaveRisk = 'unsaved-key' | 'setup-in-flight' | 'reset-in-flight';

const QUESTIONS: Record<LeaveRisk, { header: string; message: string }> = {
  'unsaved-key': {
    header: 'Leave without saving your key?',
    message:
      'This key is shown once. Leave now and you won’t be able to recover your messages on another device.',
  },
  'setup-in-flight': {
    header: 'Encryption setup in progress',
    message:
      'Leaving won’t stop it, and the recovery key it creates will be lost — your messages would be backed up with a key you never saw. Wait for it to finish.',
  },
  'reset-in-flight': {
    header: 'Identity reset in progress',
    message:
      'Leaving won’t stop it, and the new recovery key it produces will be lost. Wait for it to finish.',
  },
};

/**
 * Whether it is safe to leave, asking the user when it is not. Shared by setup and unlock,
 * which both show a recovery key once and are dismissed by the browser's back button
 * without asking.
 *
 * Fails towards staying: if the confirmation cannot be shown, refusing to leave loses
 * nothing that cannot be retried.
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
