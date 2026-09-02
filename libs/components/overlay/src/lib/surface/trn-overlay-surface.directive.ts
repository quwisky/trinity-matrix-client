import { Directive, input } from '@angular/core';
import { classes } from '@trinity/helm/utils';
import {
  trnOverlaySurfaceRecipe,
  type TrnOverlaySurfaceLayout,
  type TrnOverlaySurfaceSize,
  type TrnOverlaySurfaceVariant,
} from './trn-overlay-surface-recipe';

/** Trinity-owned chrome for content rendered in the document or an overlay portal. */
@Directive({
  selector: '[trnOverlaySurface]',
  host: {
    '[attr.data-trn-layout]': 'layout()',
    '[attr.data-trn-size]': 'size()',
    '[attr.data-trn-variant]': 'variant()',
  },
})
export class TrnOverlaySurfaceDirective {
  readonly variant = input<TrnOverlaySurfaceVariant>('neutral');
  readonly size = input<TrnOverlaySurfaceSize>('md');
  readonly layout = input<TrnOverlaySurfaceLayout>('dialog');

  constructor() {
    classes(() =>
      trnOverlaySurfaceRecipe(this.variant(), this.size(), this.layout()),
    );
  }
}
