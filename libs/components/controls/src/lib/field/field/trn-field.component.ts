import { ChangeDetectionStrategy, Component } from '@angular/core';
import { BrnField } from '@spartan-ng/brain/field';

/**
 * Groups one labelled form control and its supporting content.
 *
 * The field owns only layout. Native controls remain projected so their focus, value,
 * autofill, and Signal Forms behaviour are unchanged.
 */
@Component({
  selector: 'trn-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './trn-field.component.html',
  styleUrl: './trn-field.component.scss',
  hostDirectives: [
    {
      directive: BrnField,
      inputs: ['forceInvalid: invalid'],
      outputs: [],
    },
  ],
})
export class TrnFieldComponent {}
