// @trinity/ui-spartan — Trinity's spartan.ng ("helm") component library.
//
// Owned, in-repo helm components built on @spartan-ng/brain primitives + Angular
// CDK, styled with Tailwind design tokens. These progressively replace the Ionic
// components across the app (see MIGRATION.md).
// The canonical spartan class-merge helper (hlm/classes) + provideSpartanHlm.
export * from '@trinity/helm/utils';
export * from '@trinity/helm/button';
export * from '@trinity/helm/input';
export * from '@trinity/helm/label';
export * from '@trinity/helm/spinner';
export * from '@trinity/helm/radio-group';
export * from '@trinity/helm/badge';
export * from '@trinity/helm/checkbox';
export * from '@trinity/helm/progress';
export * from './lib/toast/trn-toast.service';
// Helm sonner toaster — mount <hlm-toaster/> once at the app root; TrnToastService
// pushes messages to it via ngx-sonner's imperative toast().
export * from '@trinity/helm/sonner';
export * from './lib/alert/trn-alert.service';
export * from './lib/alert/trn-alert-dialog.component';
export * from './lib/action-sheet/trn-action-sheet.service';
export * from './lib/action-sheet/trn-action-sheet.component';
export * from './lib/dialog/trn-dialog.service';
// Re-exported so modal'd components close themselves via @trinity/ui-spartan
// (inject(DialogRef).close(data)) instead of importing @angular/cdk directly.
export { DialogRef } from '@angular/cdk/dialog';
