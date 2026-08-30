import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { HlmSpinner } from '@trinity/helm/spinner';

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
 * The host is `inline-flex` through a component style rather than a utility class, for the
 * same reason `<trn-icon>` is: the box model then ships with the component instead of
 * depending on a consuming app emitting the class — and, unlike a Tailwind class, jsdom can
 * see it, so the spec can actually assert it.
 */
@Component({
  selector: 'trn-spinner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmSpinner],
  styles: [':host { display: inline-flex; }'],
  template: `<hlm-spinner [aria-label]="ariaLabel()" />`,
})
export class TrnSpinnerComponent {
  /** Announced by screen readers while the spinner is on screen. */
  readonly ariaLabel = input<string>('Loading', { alias: 'aria-label' });
}
