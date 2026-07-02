// @trinity/ui-spartan — Trinity's spartan.ng ("helm") component library.
//
// Owned, in-repo helm components built on @spartan-ng/brain primitives + Angular
// CDK, styled with Tailwind design tokens. These progressively replace the Ionic
// components across the app (see MIGRATION.md).
export * from './lib/core/cn';
export * from './lib/button/hlm-button.directive';
export * from './lib/input/hlm-input.directive';
export * from './lib/label/hlm-label.directive';
export * from './lib/spinner/trn-spinner.component';
export * from './lib/radio/trn-radio-group.component';
export * from './lib/radio/trn-radio.component';
export * from './lib/badge/trn-badge.directive';
export * from './lib/checkbox/trn-checkbox.component';
export * from './lib/progress/trn-progress.component';
export * from './lib/toast/trn-toast.service';
export * from './lib/toast/trn-toast-container.component';
export * from './lib/alert/trn-alert.service';
export * from './lib/alert/trn-alert-dialog.component';
export * from './lib/action-sheet/trn-action-sheet.service';
export * from './lib/action-sheet/trn-action-sheet.component';
export * from './lib/dialog/trn-dialog.service';
// Re-exported so modal'd components close themselves via @trinity/ui-spartan
// (inject(DialogRef).close(data)) instead of importing @angular/cdk directly.
export { DialogRef } from '@angular/cdk/dialog';
