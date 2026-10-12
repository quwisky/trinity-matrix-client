// The lib's public surface is the lazy route table; the shell and section sub-pages
// are internal routing targets, referenced relatively by settings.routes.ts.
export * from './lib/settings.routes';
export * from './lib/settings-dialog/settings-dialog.component';
// Report a bug, which the application host loads lazily for the sign-in screen and System
// status.
export * from './lib/advanced/report-bug/report-bug-dialog.component';
