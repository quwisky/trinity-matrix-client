import { computed, Directive, input } from '@angular/core';
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
    '[attr.data-trn-surface]': 'surface()',
  },
})
export class TrnOverlaySurfaceDirective {
  readonly variant = input<TrnOverlaySurfaceVariant>('neutral');
  readonly size = input<TrnOverlaySurfaceSize>('md');
  readonly layout = input<TrnOverlaySurfaceLayout>('dialog');

  /**
   * The accent variant paints the attention surface, so it declares that context for its
   * content: `trnBtn` reads `data-trn-surface="attention"` and inverts its solid fill, which
   * would otherwise be the same accent as the surface (#1224). That includes the surface's
   * own primary action. The accent recipe also switches every focusable inside (buttons,
   * fields, links) to the on-attention ring, because they all sit on the accent. Portal
   * content opened from inside renders outside this element. Neutral content (a neutral card
   * or banner) placed directly inside an accent surface is unsupported: its buttons would
   * invert and its focus ring would be tuned against the wrong background.
   */
  protected readonly surface = computed(() =>
    this.variant() === 'accent' ? 'attention' : null,
  );

  constructor() {
    classes(() =>
      trnOverlaySurfaceRecipe(this.variant(), this.size(), this.layout()),
    );
  }
}
