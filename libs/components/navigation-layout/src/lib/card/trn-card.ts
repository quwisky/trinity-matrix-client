import { Directive, input } from '@angular/core';
import {
  HlmCardContent,
  HlmCardDescription,
  HlmCardHeader,
  HlmCardTitle,
} from '@trinity/helm/card';
import { classes } from '@trinity/helm/utils';
import {
  trnCardRecipe,
  type TrnCardSize,
  type TrnCardVariant,
} from './trn-card-recipe';

export type { TrnCardSize, TrnCardVariant } from './trn-card-recipe';

/**
 * Trinity's card, as five attribute directives.
 *
 * Attributes rather than elements because the call site chooses the semantics: a section title
 * can put `trnCardTitle` on its correctly levelled heading, while a card such as the auth surface
 * can omit that slot and let projected content supply its own `<h1>`. Turning those into
 * `<trn-card>` / `<trn-card-title>` elements would flatten the document outline. The kit's own
 * layout depends on the parent/child relationship (`has-data-[slot=card-footer]` and friends),
 * which attributes preserve exactly.
 *
 * The root owns its bounded semantic surface and size recipe. The structural slots still
 * compose the kit directives because their private grid/spacing relationship is useful and
 * does not cross the public API.
 *
 * `trnCardFooter` and `trnCardAction` exist in the kit and are not wrapped: nothing uses
 * them. Both are one line to add when something needs them, and until then they are surface
 * nobody has to maintain or reimplement.
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
  selector: '[trnCardTitle]',
  hostDirectives: [{ directive: HlmCardTitle, inputs: [], outputs: [] }],
})
export class TrnCardTitle {}

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

/**
 * Every card directive, for a call site that composes the whole thing.
 *
 * Mirrors the kit's own `HlmCardImports` convention: a card is five cooperating attributes,
 * and listing them one by one in a component's `imports` is noise at every call site.
 */
export const TrnCardImports = [
  TrnCard,
  TrnCardHeader,
  TrnCardTitle,
  TrnCardDescription,
  TrnCardContent,
] as const;
