// Domain-neutral interactive controls. Public exports are intentionally named.
export {
  TrnActionAvailability,
  TrnButton,
  TrnButtonImports,
  TrnIconButton,
} from './lib/button/trn-button';
export { TrnCheckboxComponent } from './lib/checkbox/trn-checkbox.component';
export { TrnEmojiIndex } from './lib/emoji-picker/trn-emoji-index.service';
export { TrnEmojiPickerComponent } from './lib/emoji-picker/trn-emoji-picker/trn-emoji-picker.component';
export type {
  TrnEmojiPick,
  TrnEmojiSuggestion,
} from './lib/emoji-picker/trn-emoji.model';
export { TrnFieldComponent } from './lib/field/field/trn-field.component';
export {
  TrnFieldLabelComponent,
  type TrnFieldLabelVariant,
} from './lib/field/field-label/trn-field-label.component';
export { TrnInput } from './lib/input/trn-input';
export { TrnLabel } from './lib/label/trn-label';
export { QrScannerComponent } from './lib/qr-scanner/qr-scanner/qr-scanner.component';
export {
  TrnRadioGroupComponent,
  type TrnRadioGroupVariant,
  type TrnRadioOption,
} from './lib/radio-group/trn-radio-group.component';
export {
  TrnSelectComponent,
  type TrnSelectOption,
} from './lib/select/trn-select.component';
export { TrnSwitchComponent } from './lib/switch/trn-switch.component';
export { TrnTextarea } from './lib/textarea/trn-textarea';
export { TrnToggleGroupComponent } from './lib/toggle-group/trn-toggle-group.component';
export { TrnToggleGroupItemDirective } from './lib/toggle-group/trn-toggle-group-item.directive';

import { TrnFieldComponent } from './lib/field/field/trn-field.component';
import { TrnFieldLabelComponent } from './lib/field/field-label/trn-field-label.component';

export const TrnFieldImports = [
  TrnFieldComponent,
  TrnFieldLabelComponent,
] as const;
