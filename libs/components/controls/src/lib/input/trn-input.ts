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
 * Trinity's form input. The native-input selector keeps focus, value, autofill and Signal
 * Forms behavior on the element the browser operates; this directive owns the size and
 * validation vocabulary plus every appearance class. Validation shows only once the user
 * touched the control or tried to submit (`spartanInvalid`).
 *
 * `aria-describedby` is published explicitly because `BrnFieldControlDescribedBy` otherwise
 * writes `null` over a consumer attribute.
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
  /**
   * Explicitly marks the control invalid. Not named `invalid`: Signal Forms writes the field's
   * raw `invalid` state into any `invalid` input, which would show errors before interaction.
   */
  readonly explicitInvalid = input(false, { transform: booleanAttribute });
  protected readonly resolvedInvalid = computed(
    () => this.explicitInvalid() || Boolean(this.fieldControl.spartanInvalid()),
  );

  constructor() {
    classes(() => trnInputRecipe(this.size(), this.resolvedInvalid()));
  }
}
