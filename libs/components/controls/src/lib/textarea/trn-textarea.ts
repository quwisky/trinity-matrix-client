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
import { BrnTextarea } from '@spartan-ng/brain/textarea';
import { classes } from '@trinity/helm/utils';
import {
  trnTextareaRecipe,
  type TrnTextControlSize,
} from '../input/trn-text-control-recipe';

/**
 * Trinity's multi-line input.
 *
 * The exact native-textarea selector preserves native focus, value, form and template-reference
 * behavior. Brain supplies field state and description wiring while this directive owns the
 * public size and validation vocabulary plus every appearance class. See {@link TrnInput} for
 * the shared accessibility contract.
 */
@Directive({
  selector: 'textarea[trnTextarea]',
  host: {
    'data-slot': 'textarea',
    '[attr.data-size]': 'size()',
    '[attr.aria-invalid]': 'resolvedInvalid() ? "true" : null',
    '[attr.data-invalid]': 'resolvedInvalid() ? "true" : null',
    '[attr.data-matches-spartan-invalid]': 'resolvedInvalid() ? "true" : null',
  },
  hostDirectives: [
    {
      directive: BrnTextarea,
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
export class TrnTextarea {
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
    classes(() => trnTextareaRecipe(this.size(), this.resolvedInvalid()));
  }
}
