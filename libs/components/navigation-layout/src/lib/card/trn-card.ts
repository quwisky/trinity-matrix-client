import { Directive, input } from '@angular/core';
import {
  HlmCardContent,
  HlmCardDescription,
  HlmCardHeader,
} from '@trinity/helm/card';
import { classes } from '@trinity/helm/utils';
import {
  trnCardRecipe,
  type TrnCardSize,
  type TrnCardVariant,
} from './trn-card-recipe';

export type { TrnCardSize, TrnCardVariant } from './trn-card-recipe';

/**
 * Trinity's card, as four attribute directives.
 *
 * Attributes rather than elements because the call site chooses the semantics: the card has no
 * title slot, so projected content supplies its own correctly levelled heading, and `<trn-card>`
 * elements would flatten the document outline. The kit's layout depends on the parent/child
 * relationship (`has-data-[slot=card-footer]` and friends), which attributes preserve.
 *
 * The root owns its semantic surface and size recipe; the structural slots still compose the
 * kit directives. `trnCardFooter` and `trnCardAction` are not wrapped because nothing uses them.
 */
@Directive({
  selector: '[trnCard]',
  host: {
    'data-slot': 'card',
    '[attr.data-size]': 'size()',
    '[attr.data-variant]': 'variant()',
  },
})
export class TrnCard {
  readonly variant = input<TrnCardVariant>('neutral');
  readonly size = input<TrnCardSize>('md');

  constructor() {
    classes(() => trnCardRecipe(this.variant(), this.size()));
  }
}

@Directive({
  selector: '[trnCardHeader]',
  hostDirectives: [{ directive: HlmCardHeader, inputs: [], outputs: [] }],
})
export class TrnCardHeader {}

@Directive({
  selector: '[trnCardDescription]',
  hostDirectives: [{ directive: HlmCardDescription, inputs: [], outputs: [] }],
})
export class TrnCardDescription {}

@Directive({
  selector: '[trnCardContent]',
  hostDirectives: [{ directive: HlmCardContent, inputs: [], outputs: [] }],
})
export class TrnCardContent {}

/** Every card directive, for a call site that composes the whole card. */
export const TrnCardImports = [
  TrnCard,
  TrnCardHeader,
  TrnCardDescription,
  TrnCardContent,
] as const;
