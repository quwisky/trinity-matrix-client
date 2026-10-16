import { booleanAttribute, Directive, input } from '@angular/core';
import { HlmLabel } from '@trinity/helm/label';
import { classes } from '@trinity/helm/utils';
import {
  trnFieldLabelRecipe,
  type TrnFieldLabelEmphasis,
} from '../field/trn-field-recipe';

/**
 * Trinity's form label. An attribute directive, not an element, because the host carries the
 * semantics: a native `<label for="…">` paired with an input's `id`, or a `<span>` group
 * caption. A `<trn-label>` element would break the `for`/`id` association.
 *
 * The kit directive is composed through `hostDirectives`, so there is no second copy of its
 * class list to drift from a `@spartan-ng/cli` re-sync.
 *
 * **`id` and `for` are deliberately not forwarded.** `hostDirectives` input forwarding does
 * not chain: listing `inputs: ['id', 'for']` on an entry whose target only inherits those
 * inputs fails at runtime with `NG0311`. The label/control association works because `for`
 * is the plain HTML attribute, not a directive input.
 */
@Directive({
  selector: 'label[trnLabel], span[trnLabel]',
  host: {
    '[attr.data-emphasis]': 'emphasis()',
    '[attr.data-invalid]': 'invalid() ? "true" : null',
  },
  hostDirectives: [{ directive: HlmLabel, inputs: [], outputs: [] }],
})
export class TrnLabel {
  readonly emphasis = input<TrnFieldLabelEmphasis>('normal');
  readonly invalid = input(false, { transform: booleanAttribute });

  constructor() {
    classes(() => trnFieldLabelRecipe(this.emphasis(), this.invalid()));
  }
}
