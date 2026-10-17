import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { HlmSpinner } from '@trinity/helm/spinner';
import {
  trnSpinnerRecipe,
  type TrnSpinnerSize,
  type TrnSpinnerVariant,
} from './trn-spinner-recipe';

export type { TrnSpinnerSize, TrnSpinnerVariant } from './trn-spinner-recipe';

/**
 * Trinity's busy indicator, an element composed by template (`hostDirectives` allows only
 * directives, never components).
 *
 * `icon` is deliberately not exposed: a public input is a promise a replacement library must
 * keep. `aria-label` IS exposed, so a screen reader doesn't announce every spinner as "Loading".
 *
 * The host is `inline-flex` through a layered component style rather than a utility class, so
 * the box model ships with the component. Storybook verifies that compiled style in a real
 * browser; the unit contract keeps the host class free for consumer layout.
 */
@Component({
  selector: 'trn-spinner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmSpinner],
  host: {
    '[attr.data-variant]': 'variant()',
    '[attr.data-size]': 'size()',
  },
  templateUrl: './trn-spinner.component.html',
  styleUrl: './trn-spinner.component.scss',
})
export class TrnSpinnerComponent {
  /** Announced by screen readers while the spinner is on screen. */
  readonly ariaLabel = input<string>('Loading', { alias: 'aria-label' });
  readonly size = input<TrnSpinnerSize>('md');
  /** Omit to inherit the surrounding control's ink. */
  readonly variant = input<TrnSpinnerVariant | null>(null);

  protected readonly spinnerClass = computed(() =>
    trnSpinnerRecipe(this.size(), this.variant()),
  );
}
