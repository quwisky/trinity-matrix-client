import { Directive, computed, input } from '@angular/core';
import { badgeVariants } from '@trinity/helm/badge';
import { classes } from '@trinity/components/foundations';

/**
 * What a badge can say in Trinity. Ours, and deliberately narrower than the kit's.
 *
 * The kit offers eight variants; this app uses three — `success` and `warning` on the device
 * list, and the default elsewhere. A public union is a promise to keep working, so it is kept
 * to what call sites actually ask for: five fewer things for the next library to satisfy, and
 * five fewer things to check when one is swapped in. Widen it when something needs it.
 */
export type TrnBadgeVariant = 'default' | 'success' | 'warning';

/**
 * Trinity's status badge.
 *
 * An attribute directive on a `<span>`, matching every call site. Unlike {@link TrnLabel}
 * this cannot compose the kit directive through `hostDirectives`, because our `variant`
 * vocabulary is not the kit's and `hostDirectives` cannot transform an input — Angular
 * accepts only `'name'` or `'name: alias'`, and an `input()` is a read-only signal that
 * nothing outside the directive can write.
 *
 * So the variant is mapped here and the classes are applied here, from the kit's own `cva`
 * table. That is still one table, not two: `badgeVariants` is imported rather than copied,
 * so a re-sync cannot leave a stale duplicate behind. Only the mapping is ours.
 */
@Directive({
  selector: '[trnBadge]',
  host: {
    'data-slot': 'badge',
    '[attr.data-variant]': 'variant()',
  },
})
export class TrnBadge {
  readonly variant = input<TrnBadgeVariant>('default');

  private readonly variantClasses = computed(() =>
    badgeVariants({ variant: this.variant() }),
  );

  constructor() {
    classes(() => this.variantClasses());
  }
}
