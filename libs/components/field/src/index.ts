// @trinity/components/field — Trinity's form-field composition contract.
export * from './lib/field/trn-field.component';
export * from './lib/field-label/trn-field-label.component';

import { TrnFieldComponent } from './lib/field/trn-field.component';
import { TrnFieldLabelComponent } from './lib/field-label/trn-field-label.component';

export const TrnFieldImports = [
  TrnFieldComponent,
  TrnFieldLabelComponent,
] as const;
