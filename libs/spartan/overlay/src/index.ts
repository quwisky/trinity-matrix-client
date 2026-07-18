// @trinity/helm/overlay — Trinity's imperative overlay adapters.
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
// Re-exported so modal'd components close themselves via @trinity/helm/overlay
// (inject(DialogRef).close(data)) instead of importing @angular/cdk directly.
export { DialogRef } from '@angular/cdk/dialog';
