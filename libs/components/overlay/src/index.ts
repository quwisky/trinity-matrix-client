// Domain-neutral overlays. The vendor implementation stays private and this API stays explicit.
export { provideTrnOverlayDefaults } from './lib/provide-overlay-defaults';
export {
  TrnDialogService,
  type DialogOptions,
} from './lib/dialog/trn-dialog.service';
export { TrnDialogRef } from './lib/dialog/trn-dialog-ref';
export {
  TrnAlertService,
  type ConfirmOptions,
  type PromptOptions,
} from './lib/alert/trn-alert.service';
export {
  TrnAlertDialogComponent,
  type AlertDialogData,
  type AlertDialogResult,
} from './lib/alert/trn-alert-dialog.component';
export {
  TrnActionSheetService,
  type TrnActionSheetOptions,
} from './lib/action-sheet/trn-action-sheet.service';
export {
  TrnActionSheetComponent,
  type ActionSheetButton,
  type ActionSheetData,
  type ActionSheetReaction,
} from './lib/action-sheet/trn-action-sheet.component';
export { TrnActionSheetRef } from './lib/action-sheet/trn-action-sheet-ref';
export {
  TrnToastService,
  type ToastOptions,
  type ToastVariant,
} from './lib/toast/trn-toast.service';
export { TrnToasterComponent } from './lib/toast/trn-toaster.component';
export {
  TrnDropdownMenu,
  TrnDropdownMenuCheckbox,
  TrnDropdownMenuCheckboxIndicatorComponent,
  TrnDropdownMenuImports,
  TrnDropdownMenuItem,
  TrnDropdownMenuItemSubIndicatorComponent,
  TrnDropdownMenuLabel,
  TrnDropdownMenuRadio,
  TrnDropdownMenuRadioIndicatorComponent,
  TrnDropdownMenuSeparator,
  TrnDropdownMenuSub,
  TrnDropdownMenuSubTrigger,
  TrnDropdownMenuTrigger,
} from './lib/dropdown/trn-dropdown-menu';
export {
  TrnAnchoredOverlayDirective,
  type TrnAnchoredAlign,
  type TrnAnchoredSide,
} from './lib/anchored/trn-anchored-overlay.directive';
