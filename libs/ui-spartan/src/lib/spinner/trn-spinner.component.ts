import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import type { ClassValue } from 'clsx';
import { hlm } from '../core/cn';

/**
 * Indeterminate loading spinner — an SVG that spins via Tailwind's `animate-spin`.
 * Colors from `currentColor` (defaults to the brand `text-primary`); size and
 * color are overridable through the host `class`. Replaces `<ion-spinner>`.
 */
@Component({
  selector: 'trn-spinner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'status',
    'aria-label': 'Loading',
    '[class]': '_computedClass()',
  },
  template: `
    <svg
      class="h-full w-full animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        class="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        stroke-width="4"
      ></circle>
      <path
        class="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8V0C5.4 0 0 5.4 0 12h4z"
      ></path>
    </svg>
  `,
})
export class TrnSpinnerComponent {
  readonly userClass = input<ClassValue>('', { alias: 'class' });

  protected readonly _computedClass = computed(() =>
    hlm('inline-block size-6 text-primary', this.userClass()),
  );
}
