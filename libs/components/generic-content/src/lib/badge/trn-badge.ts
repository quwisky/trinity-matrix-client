import { Directive, computed, input } from '@angular/core';
import { classes } from '@trinity/components/foundations';
import {
  trnBadgeRecipe,
  type TrnBadgeSize,
  type TrnBadgeVariant,
} from './trn-badge-recipe';

/**
 * What a badge can say in Trinity. Ours, and deliberately narrower than the kit's.
 *
 * The kit offers eight variants; this app uses three — `success` and `warning` on the device
 * list, and the default elsewhere. A public union is a promise to keep working, so it is kept
 * to what call sites actually ask for: five fewer things for the next library to satisfy, and
 * five fewer things to check when one is swapped in. Widen it when something needs it.
 */
/** Trinity's status badge, expressed only through semantic Trinity recipes. */
@Directive({
  selector: '[trnBadge]',
  host: {
    'data-slot': 'badge',
    '[attr.data-variant]': 'variant()',
    '[attr.data-size]': 'size()',
  },
})
export class TrnBadge {
  readonly variant = input<TrnBadgeVariant>('neutral');
  readonly size = input<TrnBadgeSize>('sm');

  private readonly recipeClasses = computed(() =>
    trnBadgeRecipe(this.variant(), this.size()),
  );

  constructor() {
    classes(() => this.recipeClasses());
  }
}
