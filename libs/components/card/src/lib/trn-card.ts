import { Directive } from '@angular/core';
import {
  HlmCard,
  HlmCardContent,
  HlmCardDescription,
  HlmCardHeader,
  HlmCardTitle,
} from '@trinity/helm/card';

/**
 * Trinity's card, as five attribute directives.
 *
 * Attributes rather than elements because the call site chooses the semantics: the login
 * card is a `<section>` with an `<h2>` title and `<p>` descriptions, and turning those into
 * `<trn-card>` / `<trn-card-title>` elements would flatten the document outline and the
 * heading level with it. The kit's own layout depends on the parent/child relationship
 * (`has-data-[slot=card-footer]` and friends), which attributes preserve exactly.
 *
 * Each composes the kit directive through `hostDirectives`, so no class list is duplicated
 * and a swap is a change to these five entries.
 *
 * `trnCardFooter` and `trnCardAction` exist in the kit and are not wrapped: nothing uses
 * them. `HlmCard`'s `size` input is not forwarded for the same reason. Both are one line to
 * add when something needs them, and until then they are surface nobody has to maintain or
 * reimplement.
 */
@Directive({
  selector: '[trnCard]',
  hostDirectives: [{ directive: HlmCard, inputs: [], outputs: [] }],
})
export class TrnCard {}

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
