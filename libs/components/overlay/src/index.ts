// @trinity/components/overlay — Trinity's imperative overlay adapters.
//
// Service-driven dialog/alert/action-sheet/toast APIs built on Angular CDK's
// Dialog/Overlay + brain sonner, styled with the owned helm components. These are
// the spartan replacements for Ionic's ModalController/AlertController/
// ActionSheetController/ToastController.
export * from './lib/provide-overlay-defaults';
export * from './lib/dialog/trn-dialog.service';
export * from './lib/alert/trn-alert.service';
export * from './lib/alert/trn-alert-dialog.component';
export * from './lib/action-sheet/trn-action-sheet.service';
export * from './lib/action-sheet/trn-action-sheet.component';
export * from './lib/toast/trn-toast.service';
// How a modal'd component closes itself: `inject(TrnDialogRef).close(value)`.
//
// This used to be `export { DialogRef } from '@angular/cdk/dialog'` — one deliberate,
// documented CDK export. It was still a leak: it put the vendor's class in the type
// signature of 24 feature components, so swapping the dialog library would have meant
// editing all of them, which is the exact cost this layer exists to remove. `TrnDialogRef`
// is Trinity's own two-method handle over it, and `vendor-surface.spec.ts` now asserts
// this barrel re-exports NO CDK symbol at all rather than exactly one.
//
// `Dialog` was never re-exported and still is not. Handing it back would let feature code
// call `.open()` with unmediated CDK config, and TrnDialogService would stop being the
// only door — the vendor ban would then be cosmetic. Everything that used to need the
// class is a named method instead: `closeTopmost()` for the Android back button and
// `closeAll()` for teardown. If a genuinely new need appears, add another method.
//
// `DIALOG_DATA` is not re-exported either: `TrnDialogService.open`'s `inputs` bag is
// the idiom here, so a dialog reads what it was given through `input.required()`.
export { TrnDialogRef } from './lib/dialog/trn-dialog-ref';
