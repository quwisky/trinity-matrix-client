import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import type { TrnIconName } from '../trn-icon-name';

/**
 * Trinity's icon.
 *
 * **Decorative by default, announced only on request.** The inner `<ng-icon>` always
 * carries a *static* `aria-hidden="true"`, and a `label` moves the announcement to this
 * host instead. That split exists because of a trap in the vendor: `NgIcon` reads
 * `aria-hidden` through `HostAttributeToken` in its constructor and force-hides itself when
 * the attribute is absent — so a *bound* `[attr.aria-hidden]` is invisible to it, and an
 * `[attr.aria-label]` written beside one is announced to nobody. Trinity shipped exactly
 * that bug in the quick switcher. Here the static attribute is written once, in one file,
 * and call sites express intent with `label` instead of re-deriving the incantation.
 */
@Component({
  selector: 'trn-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './trn-icon.component.html',
  imports: [NgIcon],
  styles: [
    // Matches the element this replaced. `ng-icon` sets `:host{display:inline-block}`, so
    // without this the wrapper is `display: inline` and every icon in the app changes box
    // model — harmless inside a flex parent, which blockifies its children, but in true
    // inline flow an inline host participates in baseline and line-height in a way the
    // inline-block element did not, and icons shift. `TrnSpinner` — the same shape, a
    // wrapper whose template is one `<ng-icon>` — declares `inline-flex` for this reason.
    //
    // It does so through `classes()` from @trinity/kit/utils, which is the kit's house
    // pattern and what this would otherwise use. A component style is deliberate here on
    // two counts: it ships with the component, so the box model does not depend on a
    // consuming app emitting the `inline-block` utility; and it is assertable, which a
    // Tailwind class is not, because jsdom loads no stylesheet. Switching to `classes()`
    // would silently make the box-model test in the spec vacuous — change both together
    // or neither. Keeping it also leaves this library importing nothing but @ng-icons.
    ':host { display: inline-block; }',
  ],
  host: {
    // Null rather than absent-when-false: an unlabelled icon must expose no role at all,
    // or every decorative icon becomes an announceable image with no name. An EMPTY label
    // counts as unlabelled for the same reason — `[attr.x]` only removes on null, so
    // passing '' would otherwise render `aria-label=""`: an announceable-looking element
    // with no name, which is the exact dead ARIA this component exists to prevent.
    '[attr.role]': 'announced() ? "img" : null',
    '[attr.aria-label]': 'announced()',
  },
})
export class TrnIconComponent {
  /** Which icon, from Trinity's own vocabulary — not a vendor identifier. */
  readonly name = input.required<TrnIconName>();
  /**
   * Accessible name. Leave unset for the common case: an icon sitting beside text that
   * already says the same thing, where a label is duplicate noise rather than help.
   */
  readonly label = input<string | null>(null);

  protected readonly announced = computed(() => this.label() || null);
}
