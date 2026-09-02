import { Directive, input } from '@angular/core';
import { BrnSeparator } from '@spartan-ng/brain/separator';
import { classes } from '@trinity/helm/utils';
import {
  trnSeparatorRecipe,
  type TrnSeparatorVariant,
} from './trn-separator-recipe';

export type { TrnSeparatorVariant } from './trn-separator-recipe';

/**
 * A rule between groups of controls.
 *
 * A directive rather than an element, because the thing it separates is usually a flex or
 * grid child and an extra wrapper would land in that layout. Brain remains the behavior and
 * accessibility substrate while the public directive owns its neutral/accent line recipe.
 *
 * Brain's `orientation` and `decorative` inputs are re-published explicitly so call sites keep
 * the behavior contract on the same element as Trinity's visual treatment.
 *
 * `decorative` is the interesting one, and its default is upstream's: `true`, so a rule is
 * silent unless asked otherwise and `role` reads `none`. That is right for the common case —
 * most rules are drawn to look like something, not to say something — and it means a caller
 * who wants the rule announced has to say `[decorative]="false"` and think about why. Left
 * where upstream put it rather than inverted here, so a regenerate does not quietly change
 * what every existing call site means.
 */
@Directive({
  selector: '[trnSeparator]',
  hostDirectives: [
    {
      directive: BrnSeparator,
      inputs: ['orientation', 'decorative'],
      outputs: [],
    },
  ],
  host: {
    'data-slot': 'separator',
    '[attr.data-variant]': 'variant()',
  },
})
export class TrnSeparatorDirective {
  readonly variant = input<TrnSeparatorVariant>('neutral');

  constructor() {
    classes(() => trnSeparatorRecipe(this.variant()));
  }
}
