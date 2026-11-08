import {
  computed,
  DestroyRef,
  ElementRef,
  inject,
  InjectionToken,
  signal,
  type Signal,
} from '@angular/core';
import type { DisabledReason } from '@angular/forms/signals';

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

/**
 * The host element's native `disabled` state, whoever writes it: Signal Forms sets the
 * property from the schema and a plain `[disabled]` binding sets it directly. Both reflect to
 * the attribute, which is what this observes.
 */
export function nativeDisabled(): Signal<boolean> {
  const element =
    inject<ElementRef<HTMLInputElement | HTMLTextAreaElement>>(
      ElementRef,
    ).nativeElement;
  const disabled = signal(element.disabled);
  const observer = new MutationObserver(() => disabled.set(element.disabled));
  observer.observe(element, { attributeFilter: ['disabled'] });
  inject(DestroyRef).onDestroy(() => observer.disconnect());
  return disabled.asReadonly();
}

/**
 * The lock's sentence: the caller's own reason, else the first message a Signal Forms
 * `disabled(path, { when })` rule returned, else the generic one.
 */
export function trnLockReason(
  disabled: Signal<boolean>,
  shown: Signal<boolean>,
  explicitReason: Signal<string | null>,
  formReasons: Signal<readonly Pick<DisabledReason, 'message'>[]>,
): Signal<string | null> {
  return computed(() => {
    if (!disabled() || !shown()) return null;
    return (
      explicitReason() ||
      formReasons().find((reason) => reason.message)?.message ||
      TRN_DEFAULT_LOCK_REASON
    );
  });
}
