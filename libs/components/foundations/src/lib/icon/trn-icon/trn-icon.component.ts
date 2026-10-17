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
 * Decorative by default, announced only on request: the inner `<ng-icon>` always carries a
 * static `aria-hidden="true"`, and a `label` moves the announcement to this host. `NgIcon`
 * reads `aria-hidden` through `HostAttributeToken` in its constructor and force-hides itself
 * when the attribute is absent, so a bound `[attr.aria-hidden]` is invisible to it and an
 * `[attr.aria-label]` beside one is announced to nobody.
 *
 * Size goes through `size`, never a `text-*` class on this element: `HlmButton`'s cva string
 * has `[&_ng-icon:not([class*='text-'])]:text-[length:--spacing(4)]`, which matches the bare
 * inner `<ng-icon>` when the class sits on this host, so `font-size` is written onto the inner
 * element and `1em` resolves against 16px instead of 20px. `size` sets `--ng-icon__size`,
 * which drives the inner element's width/height instead of its font-size.
 */
@Component({
  selector: 'trn-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './trn-icon.component.html',
  imports: [NgIcon],
  styleUrl: './trn-icon.component.scss',
  host: {
    // Null, not absent-when-false: an unlabelled icon must expose no role, and an EMPTY label
    // counts as unlabelled because `[attr.x]` only removes on null (`aria-label=""` is dead ARIA).
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
  /** Accessible name. Leave unset when the icon sits beside text that already says the same. */
  readonly label = input<string | null>(null);
  /**
   * Glyph size from Trinity's ordinal scale, forwarded to `--ng-icon__size`. Leave unset to
   * inherit font-size; set it, rather than a `text-xl` class, when an icon must be BIGGER than
   * its context (see the class doc).
   *
   * The public input uses `null` for "unset"; {@link resolvedSize} maps it to the empty string
   * `NgIcon.size` needs under strict template checking.
   */
  readonly size = input<TrnIconSize | null>(null);
  /** Optional semantic ink. Leave unset when the surrounding control supplies the colour. */
  readonly variant = input<TrnIconVariant | null>(null);
  /** Optional transform gesture driven by the surrounding button; the default stays inert. */
  readonly motion = input<TrnIconMotion | null>(null);

  protected readonly announced = computed(() => this.label() || null);
  protected readonly resolvedSize = computed(() =>
    resolveTrnIconSize(this.size()),
  );
}
