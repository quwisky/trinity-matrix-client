import {
  booleanAttribute,
  computed,
  Directive,
  forwardRef,
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
  trnLockReason,
  nativeDisabled,
  TRN_LOCKABLE_CONTROL,
  type TrnLockableControl,
} from '../input/trn-lockable-control';
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
  providers: [
    {
      provide: TRN_LOCKABLE_CONTROL,
      useExisting: forwardRef(() => TrnTextarea),
    },
  ],
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
export class TrnTextarea implements TrnLockableControl {
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
  /** Why the field is disabled, for `trn-field-lock`; a Signal Forms reason is used otherwise. */
  readonly disabledReason = input<string | null>(null);
  /** Written by Signal Forms from the schema's `disabled(path, { when })` rules. */
  readonly disabledReasons = input<readonly { readonly message?: string }[]>(
    [],
  );
  readonly multiline = true;
  readonly disabled = nativeDisabled();
  readonly lockReason = trnLockReason(
    this.disabled,
    computed(() => this.size() !== 'sm'),
    this.disabledReason,
    this.disabledReasons,
  );

  constructor() {
    classes(() => trnTextareaRecipe(this.size(), this.resolvedInvalid()));
  }
}
