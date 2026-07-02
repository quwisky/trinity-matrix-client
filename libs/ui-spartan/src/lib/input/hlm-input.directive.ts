import { Directive, computed, input } from '@angular/core';
import type { ClassValue } from 'clsx';
import { hlm } from '../core/cn';

/**
 * Text-field styling (shadcn/spartan "helm"). A directive on a native
 * `<input>`/`<textarea>` so form binding, validation, and native behavior are the
 * platform's. `border-solid` is explicit because Tailwind preflight is off (see
 * tailwind.config.js). Replaces `<ion-input>`/`<ion-textarea>` shells.
 */
@Directive({
  selector: 'input[trnInput], textarea[trnInput]',
  standalone: true,
  host: {
    '[class]': '_computedClass()',
  },
})
export class TrnInputDirective {
  readonly userClass = input<ClassValue>('', { alias: 'class' });

  protected readonly _computedClass = computed(() =>
    hlm(
      'flex h-9 w-full rounded-md border border-solid border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
      this.userClass(),
    ),
  );
}
