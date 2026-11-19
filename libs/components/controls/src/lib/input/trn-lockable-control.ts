import { InjectionToken, type Signal } from '@angular/core';

/** What a disabled field says when nobody gave it a reason. */
export const TRN_DEFAULT_LOCK_REASON = 'You can’t change this right now';

/**
 * A control that `trn-field-lock` can explain while it is disabled. `lockReason` is the
 * sentence the lock's bubble shows, or `null` while the control is enabled or too small to
 * fit the lock (`sm`), which keeps only the dashed disabled look.
 */
export interface TrnLockableControl {
  readonly lockReason: Signal<string | null>;
  /** A multi-line control pins the lock to its first line instead of centring it. */
  readonly multiline: boolean;
}

export const TRN_LOCKABLE_CONTROL = new InjectionToken<TrnLockableControl>(
  'TRN_LOCKABLE_CONTROL',
);
