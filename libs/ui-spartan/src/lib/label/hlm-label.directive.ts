import { Directive, computed, input } from '@angular/core';
import type { ClassValue } from 'clsx';
import { hlm } from '../core/cn';

/**
 * Form-label styling (shadcn/spartan "helm"). A directive on a native `<label>`
 * so `for`/click-to-focus behavior is native. Pair a sibling control with `peer`
 * for the disabled styling to apply. Replaces `<ion-label>` in form contexts.
 */
@Directive({
  selector: 'label[trnLabel]',
  standalone: true,
  host: {
    '[class]': '_computedClass()',
  },
})
export class TrnLabelDirective {
  readonly userClass = input<ClassValue>('', { alias: 'class' });

  protected readonly _computedClass = computed(() =>
    hlm(
      'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      this.userClass(),
    ),
  );
}
