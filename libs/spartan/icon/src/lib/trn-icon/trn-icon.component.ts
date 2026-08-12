import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import type { TrnIconName, TrnIconSize } from '../trn-icon-name';

/**
 * `md` is `1em` rather than a fixed length on purpose: `ng-icon`'s own default is
 * `width: var(--ng-icon__size, 1em)`, so every icon in the app currently takes its size
 * from the surrounding font-size. A pixel default here would silently resize all of them.
 */
const SIZE: Record<TrnIconSize, string> = {
  sm: '0.875rem',
  md: '1em',
  lg: '1.125rem',
  xl: '1.25rem',
};

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
  host: {
    // Null rather than absent-when-false: an unlabelled icon must expose no role at all,
    // or every decorative icon becomes an announceable image with no name.
    '[attr.role]': 'label() ? "img" : null',
    '[attr.aria-label]': 'label()',
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
  readonly size = input<TrnIconSize>('md');

  protected readonly cssSize = computed(() => SIZE[this.size()]);
}
