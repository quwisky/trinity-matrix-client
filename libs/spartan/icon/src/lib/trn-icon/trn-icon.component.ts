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
    // inline-block element did not, and icons shift.
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
