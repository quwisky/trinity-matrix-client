// Domain-neutral overlays. The vendor implementation stays private.
// Only `export *` and `export type *` lines: with `"sideEffects": false` in ../package.json,
// esbuild leaves the files the startup bundle doesn't use in lazy chunks, and one named
// re-export pulls every file below back into it. `export type *` publishes a file's types
// and keeps its helpers and the services `TrnSurfaceService` wraps private.
export * from './lib/provide-overlay-defaults';
export type * from './lib/dialog/trn-dialog.service';
export * from './lib/dialog/trn-dialog-ref';
export type * from './lib/sheet-frame/sheet-detent';
export * from './lib/dialog-shell/trn-dialog-shell.component';
export * from './lib/dialog-shell/trn-dialog-dismiss';
export * from './lib/surface-service/trn-surface.service';
export * from './lib/alert/trn-alert.service';
export * from './lib/alert/trn-alert-dialog.component';
export type * from './lib/action-sheet/trn-action-list.component';
export * from './lib/inset-group/trn-inset-group';
export * from './lib/action-sheet/trn-action-sheet-ref';
export * from './lib/toast/trn-toast.service';
export * from './lib/toast/trn-toaster.component';
export * from './lib/surface/trn-overlay-surface.directive';
export * from './lib/input-target/release-input-target';
export * from './lib/settings-layout/trn-settings-layout.component';
export type * from './lib/surface/trn-overlay-surface-recipe';
export * from './lib/dropdown/trn-dropdown-menu';
export * from './lib/anchored/trn-anchored-overlay.directive';
export * from './lib/position/trn-overlay-position';
export * from './lib/settings-layout/trn-settings-group.component';
export * from './lib/settings-layout/trn-settings-row.component';
export * from './lib/settings-layout/trn-settings-parts';
