import { Directive, computed, input } from '@angular/core';
import { classes } from '@trinity/helm/utils';
import {
  trnBadgeRecipe,
  type TrnBadgeSize,
  type TrnBadgeVariant,
} from './trn-badge-recipe';

/**
 * Trinity's badge variants are deliberately narrower than the kit's eight: a public union is a
 * promise to keep working, so it holds only what call sites ask for.
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
