// @trinity/kit/overlay — Trinity's imperative overlay adapters.
//
// Service-driven dialog/alert/action-sheet/toast APIs built on Angular CDK's
// Dialog/Overlay + brain sonner, styled with the owned helm components. These are
// the spartan replacements for Ionic's ModalController/AlertController/
// ActionSheetController/ToastController.
export * from './lib/dialog/trn-dialog.service';
export * from './lib/alert/trn-alert.service';
export * from './lib/alert/trn-alert-dialog.component';
export * from './lib/action-sheet/trn-action-sheet.service';
export * from './lib/action-sheet/trn-action-sheet.component';
export * from './lib/toast/trn-toast.service';
// The ONE CDK symbol feature code may name, and now the only way it names a dialog
// ref at all: `inject(DialogRef).close(value)` in a modal'd component. Since #151 no
// file outside this library imports @angular/cdk, so this re-export is load-bearing
// rather than a convenience.
//
// `Dialog` is deliberately NOT re-exported. Handing it back would let feature code
// call `.open()` with unmediated CDK config, and TrnDialogService would stop being the
// only door — the vendor ban would then be cosmetic. Everything that used to need the
// class is a named method instead: `closeTopmost()` for the Android back button and
// `closeAll()` for teardown. If a genuinely new need appears, add another method.
//
// `DIALOG_DATA` is not re-exported either: `TrnDialogService.open`'s `inputs` bag is
// the idiom here, so a dialog reads what it was given through `input.required()`.
export { DialogRef } from '@angular/cdk/dialog';
