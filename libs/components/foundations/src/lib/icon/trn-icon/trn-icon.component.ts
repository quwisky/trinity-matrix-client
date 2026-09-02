import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import type { TrnIconName } from '../trn-icon-name';
import type { TrnIconMotion } from '../trn-icon-motion';
import {
  resolveTrnIconSize,
  type TrnIconSize,
  type TrnIconVariant,
} from '../trn-icon-recipe';

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
 *
 * **Size goes through `size`, never through a `text-*` class on this element.** `HlmButton`'s
 * cva string carries `[&_ng-icon:not([class*='text-'])]:text-[length:--spacing(4)]`, whose
 * `:not()` is the opt-out an oversized icon used to rely on: the class sat on the `<ng-icon>`
 * itself, so the guard excluded it. Wrapping moved that class to THIS host and left the inner
 * `<ng-icon>` bare, which the guard therefore matches — the utility then writes `font-size`
 * straight onto the inner element, beating the size inherited from here, and `1em` resolves
 * against 16px instead of the intended 20px. `size` is immune because it sets
 * `--ng-icon__size`, which drives the inner element's own width/height rather than its
 * font-size. Verified in a browser, not in jsdom, which does no layout.
 */
@Component({
  selector: 'trn-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './trn-icon.component.html',
  imports: [NgIcon],
  styleUrl: './trn-icon.component.scss',
  host: {
    // Null rather than absent-when-false: an unlabelled icon must expose no role at all,
    // or every decorative icon becomes an announceable image with no name. An EMPTY label
    // counts as unlabelled for the same reason — `[attr.x]` only removes on null, so
    // passing '' would otherwise render `aria-label=""`: an announceable-looking element
    // with no name, which is the exact dead ARIA this component exists to prevent.
    '[attr.role]': 'announced() ? "img" : null',
    '[attr.aria-label]': 'announced()',
    '[attr.data-motion]': 'motion()',
    '[attr.data-size]': 'size()',
    '[attr.data-variant]': 'variant()',
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
  /**
   * Glyph size from Trinity's ordinal scale, forwarded to the inner element's
   * `--ng-icon__size`. Leave unset to keep inheriting from font-size, which is what the
   * ~100 icons sitting inside a button already do correctly. Set it — rather than reaching
   * for `class="text-xl"` — whenever an icon must be BIGGER than its context: see the note
   * above for why the class form silently stops working through this wrapper.
   *
   * The public input uses `null` for "unset" while {@link resolvedSize} translates that to
   * the empty string required by `NgIcon.size` under strict template checking. The vendor
   * coercion returns it untouched, Angular drops the custom property, and `1em` applies as
   * before.
   */
  readonly size = input<TrnIconSize | null>(null);
  /** Optional semantic ink. Leave unset when the surrounding control supplies the colour. */
  readonly variant = input<TrnIconVariant | null>(null);
  /**
   * Optional transform gesture driven by the surrounding interactive button. The default
   * writes no activation hook, so decorative icons and controls not explicitly audited for
   * motion stay completely inert.
   */
  readonly motion = input<TrnIconMotion | null>(null);

  protected readonly announced = computed(() => this.label() || null);
  protected readonly resolvedSize = computed(() =>
    resolveTrnIconSize(this.size()),
  );
}
