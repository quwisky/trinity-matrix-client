// The lib's public surface is the lazy route table; the shell and section sub-pages
// are internal routing targets, referenced relatively by settings.routes.ts.
export * from './lib/settings.routes';
export * from './lib/settings-dialog/settings-dialog.component';
// Report a bug, which the application host loads lazily for the sign-in screen and System
// status.
export * from './lib/advanced/report-bug/report-bug-dialog.component';
// "Add to your emoji", which the rooms feature opens through ADD_TO_IMAGE_PACK_DIALOG.
export { AddToPackDialogComponent } from './lib/image-packs/add-to-pack-dialog/add-to-pack-dialog.component';
// The pack grid, which room settings loads through IMAGE_PACK_EDITOR.
export { PersonalPackComponent } from './lib/image-packs/personal-pack/personal-pack.component';
