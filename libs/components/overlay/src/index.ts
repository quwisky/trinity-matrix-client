// Domain-neutral overlays. The vendor implementation stays private and this API stays explicit.
export { provideTrnOverlayDefaults } from './lib/provide-overlay-defaults';
export {
  TrnDialogService,
  type DialogOptions,
  type TrnDialogAutoFocus,
  type TrnDialogPlacement,
} from './lib/dialog/trn-dialog.service';
export { TrnDialogRef } from './lib/dialog/trn-dialog-ref';
export {
  TrnAlertService,
  type ConfirmOptions,
  type PromptOptions,
  type TrnAlertVariant,
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
  type TrnActionSheetButtonVariant,
} from './lib/action-sheet/trn-action-sheet.component';
export { TrnActionSheetRef } from './lib/action-sheet/trn-action-sheet-ref';
export {
  TrnToastService,
  type ToastOptions,
  type TrnToastVariant,
} from './lib/toast/trn-toast.service';
export { TrnToasterComponent } from './lib/toast/trn-toaster.component';
export { TrnOverlaySurfaceDirective } from './lib/surface/trn-overlay-surface.directive';
export type {
  TrnOverlaySurfaceLayout,
  TrnOverlaySurfaceSize,
  TrnOverlaySurfaceVariant,
} from './lib/surface/trn-overlay-surface-recipe';
export {
  TrnDropdownMenu,
  TrnDropdownMenuCheckbox,
  TrnDropdownMenuCheckboxIndicatorComponent,
  TrnDropdownMenuImports,
  TrnDropdownMenuItem,
  TrnDropdownMenuItemSubIndicatorComponent,
  TrnDropdownMenuLabel,
  TrnLockedSelectionDirective,
  TrnDropdownMenuRadio,
  TrnDropdownMenuRadioIndicatorComponent,
  TrnDropdownMenuSeparator,
  TrnDropdownMenuSub,
  TrnDropdownMenuSubTrigger,
  TrnDropdownMenuTrigger,
  type TrnDropdownMenuItemVariant,
} from './lib/dropdown/trn-dropdown-menu';
export {
  TrnAnchoredOverlayDirective,
  type TrnAnchoredAlign,
  type TrnAnchoredSide,
} from './lib/anchored/trn-anchored-overlay.directive';
export type {
  TrnOverlayAlign,
  TrnOverlaySide,
} from './lib/position/trn-overlay-position';
