import {
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import type { DisabledReason } from '@angular/forms/signals';
import { TRN_DEFAULT_LOCK_REASON } from './trn-lockable-control';

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
