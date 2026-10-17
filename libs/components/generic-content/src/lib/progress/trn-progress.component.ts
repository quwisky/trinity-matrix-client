import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { HlmProgress, HlmProgressIndicator } from '@trinity/helm/progress';
import {
  trnProgressIndicatorRecipe,
  trnProgressTrackRecipe,
  type TrnProgressSize,
  type TrnProgressVariant,
} from './trn-progress-recipe';

export type {
  TrnProgressSize,
  TrnProgressVariant,
} from './trn-progress-recipe';

/**
 * Trinity's progress bar.
 *
 * The kit's two-element composition (a host plus an indicator child that injects the host through
 * DI) is collapsed into one element, so call sites don't depend on the vendor's shape:
 *
 * ```html
 * <trn-progress [value]="fraction() * 100" aria-label="Uploading attachment" />
 * ```
 *
 * `null` means indeterminate, the kit's own convention. `max` and `getValueLabel` are not
 * exposed; the default max of 100 matches how callers compute the value.
 */
@Component({
  selector: 'trn-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmProgress, HlmProgressIndicator],
  host: {
    '[attr.data-variant]': 'variant()',
    '[attr.data-size]': 'size()',
    '[attr.data-state]': 'value() === null ? "indeterminate" : "determinate"',
  },
  templateUrl: './trn-progress.component.html',
  styleUrl: './trn-progress.component.scss',
})
export class TrnProgressComponent {
  /** Percentage complete, or `null` for an indeterminate bar. */
  readonly value = input<number | null>(null);

  readonly variant = input<TrnProgressVariant>('accent');
  readonly size = input<TrnProgressSize>('sm');

  /** What is progressing — announced by screen readers. */
  readonly ariaLabel = input<string | null>(null, { alias: 'aria-label' });

  protected readonly trackClass = computed(() =>
    trnProgressTrackRecipe(this.size()),
  );
  protected readonly indicatorClass = computed(() =>
    trnProgressIndicatorRecipe(this.variant()),
  );
}
