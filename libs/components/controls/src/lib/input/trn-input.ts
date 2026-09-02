import {
  booleanAttribute,
  computed,
  Directive,
  inject,
  input,
} from '@angular/core';
import {
  BrnFieldControl,
  BrnFieldControlDescribedBy,
} from '@spartan-ng/brain/field';
import { BrnInput } from '@spartan-ng/brain/input';
import { classes } from '@trinity/helm/utils';
import {
  trnInputRecipe,
  type TrnTextControlSize,
} from './trn-text-control-recipe';

export type { TrnTextControlSize } from './trn-text-control-recipe';

/**
 * Trinity's form input.
 *
 * The exact native-input selector keeps focus, value, autofill and Signal Forms behavior on
 * the element the browser operates. Brain supplies field state and description wiring while
 * this directive owns the public size and validation vocabulary plus every appearance class.
 * The vendor's `forceInvalid` input is intentionally not published.
 *
 * `aria-describedby` is published explicitly because `BrnFieldControlDescribedBy` otherwise
 * writes `null` over a consumer attribute. The unit and browser contracts pin the resulting
 * native description relationship.
 */
@Directive({
  selector: 'input[trnInput]',
  host: {
    'data-slot': 'input',
    '[attr.data-size]': 'size()',
    '[attr.aria-invalid]': 'resolvedInvalid() ? "true" : null',
    '[attr.data-invalid]': 'resolvedInvalid() ? "true" : null',
    '[attr.data-matches-spartan-invalid]': 'resolvedInvalid() ? "true" : null',
  },
  hostDirectives: [
    {
      directive: BrnInput,
      inputs: ['id'],
      outputs: [],
    },
    {
      directive: BrnFieldControlDescribedBy,
      inputs: ['aria-describedby'],
      outputs: [],
    },
  ],
})
export class TrnInput {
  private readonly fieldControl = inject(BrnFieldControl);

  readonly size = input<TrnTextControlSize>('md');
  readonly invalid = input(false, { transform: booleanAttribute });
  protected readonly resolvedInvalid = computed(
    () => this.invalid() || Boolean(this.fieldControl.invalid()),
  );

  constructor() {
    classes(() => trnInputRecipe(this.size(), this.resolvedInvalid()));
  }
}
