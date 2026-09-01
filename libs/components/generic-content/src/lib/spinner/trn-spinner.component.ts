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
 * Trinity's busy indicator.
 *
 * An element, because the thing it replaces is one — 15 call sites write `<trn-spinner />`
 * and two of those add a layout class. Composed by template rather than `hostDirectives`,
 * which Angular allows only for directives, never components.
 *
 * `icon` is deliberately not exposed. The kit takes one, but no call site in this workspace
 * has ever passed it, and a public input is a promise: every one kept here is another thing
 * a replacement library has to satisfy. `aria-label` IS exposed, because a busy indicator
 * that cannot be named is a busy indicator a screen reader announces as "Loading" whatever
 * it is actually loading.
 *
 * The host is `inline-flex` through a layered component style rather than a utility class,
 * for the same reason `<trn-icon>` is: the box model ships with the component instead of
 * depending on a consuming app emitting the class. Storybook verifies that compiled style in
 * a real browser; the unit contract keeps the host class free for consumer layout.
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
