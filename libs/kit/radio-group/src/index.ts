import { TrnRadio } from './lib/trn-radio';
import { TrnRadioGroup } from './lib/trn-radio-group';
import { TrnRadioIndicator } from './lib/trn-radio-indicator';

export * from './lib/trn-radio';
export * from './lib/trn-radio-group';
export * from './lib/trn-radio-indicator';

export const TrnRadioGroupImports = [
  TrnRadioGroup,
  TrnRadio,
  TrnRadioIndicator,
] as const;
