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
import { BrnInput } from '@spartan-ng/brain/input';
import { classes } from '@trinity/helm/utils';
import {
  trnLockReason,
  nativeDisabled,
  TRN_LOCKABLE_CONTROL,
  type TrnLockableControl,
} from './trn-lockable-control';
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
  providers: [
    {
      provide: TRN_LOCKABLE_CONTROL,
      useExisting: forwardRef(() => TrnInput),
    },
  ],
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
export class TrnInput implements TrnLockableControl {
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
  readonly multiline = false;
  readonly disabled = nativeDisabled();
  readonly lockReason = trnLockReason(
    this.disabled,
    computed(() => this.size() !== 'sm'),
    this.disabledReason,
    this.disabledReasons,
  );

  constructor() {
    classes(() => trnInputRecipe(this.size(), this.resolvedInvalid()));
  }
}
