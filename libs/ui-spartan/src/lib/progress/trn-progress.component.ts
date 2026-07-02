import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
} from '@angular/core';
import type { ClassValue } from 'clsx';
import { hlm } from '../core/cn';

/**
 * Linear progress bar (shadcn/spartan "helm"). Determinate by default —
 * `[value]` is a 0–1 fraction (matching `<ion-progress-bar>`); set
 * `indeterminate` for an animated bar when the total isn't known. The host is
 * the track; the inner div is the fill. Replaces `<ion-progress-bar>`.
 */
@Component({
  selector: 'trn-progress',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '1',
    '[attr.aria-valuenow]': 'indeterminate() ? null : value()',
    '[class]': '_computedClass()',
  },
  template: `
    @if (indeterminate()) {
      <div class="trn-progress__bar h-full w-2/5 rounded-full bg-primary"></div>
    } @else {
      <div
        class="h-full rounded-full bg-primary transition-[width] duration-200"
        [style.width.%]="pct()"
      ></div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      @keyframes trn-progress-indeterminate {
        0% {
          transform: translateX(-100%);
        }
        100% {
          transform: translateX(350%);
        }
      }
      .trn-progress__bar {
        animation: trn-progress-indeterminate 1.2s ease-in-out infinite;
      }
    `,
  ],
})
export class TrnProgressComponent {
  /** Completion fraction in [0, 1]; ignored when `indeterminate`. */
  readonly value = input<number>(0);
  readonly indeterminate = input(false, { transform: booleanAttribute });
  readonly userClass = input<ClassValue>('', { alias: 'class' });

  protected readonly pct = computed(
    () => Math.max(0, Math.min(1, this.value())) * 100,
  );
  protected readonly _computedClass = computed(() =>
    hlm(
      'block h-1.5 w-full overflow-hidden rounded-full bg-secondary',
      this.userClass(),
    ),
  );
}
