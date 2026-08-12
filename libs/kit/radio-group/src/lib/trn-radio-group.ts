import { computed, Directive, inject, input } from '@angular/core';
import { BrnFieldControlDescribedBy } from '@spartan-ng/brain/field';
import { BrnRadioGroup } from '@spartan-ng/brain/radio-group';
import { classes } from '@trinity/kit/utils';
import type { ClassValue } from 'clsx';

@Directive({
  selector: '[trnRadioGroup],trn-radio-group',
  hostDirectives: [
    {
      directive: BrnRadioGroup,
      inputs: ['name', 'value', 'disabled', 'required'],
      outputs: ['valueChange'],
    },
    // See trn-input.ts: without `inputs`, aria-describedby is silently removed.
    { directive: BrnFieldControlDescribedBy, inputs: ['aria-describedby'] , outputs: [] }],
  host: {
    'data-slot': 'radio-group',
    '[attr.aria-invalid]': '_ariaInvalid() ? "true" : null',
    '[attr.data-invalid]': '_ariaInvalid() ? "true" : null',
    '[attr.data-dirty]': '_dirty() ? "true" : null',
    '[attr.data-touched]': '_touched() ? "true" : null',
  },
})
export class TrnRadioGroup {
  public readonly userClass = input<ClassValue>('', { alias: 'class' });
  private readonly _brnRadioGroup = inject(BrnRadioGroup);
  protected readonly _ariaInvalid = computed(
    () => this._brnRadioGroup.controlState?.()?.invalid,
  );

  protected readonly _touched = computed(
    () => this._brnRadioGroup.controlState?.()?.touched,
  );
  protected readonly _dirty = computed(
    () => this._brnRadioGroup.controlState?.()?.dirty,
  );

  protected readonly _errorState = computed(
    () => this._brnRadioGroup.controlState?.()?.spartanInvalid,
  );

  constructor() {
    classes(() => [
      'grid gap-2',
      this.userClass(),
      this._errorState() ? 'data-[invalid=true]:text-destructive' : '',
    ]);
  }
}
