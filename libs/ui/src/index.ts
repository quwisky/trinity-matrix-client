// @trinity/ui — the encryption-dialog seam, and nothing else.
//
// This library used to hold three unrelated things: five presentational components, which
// moved to the public tier, and a `util/` folder, which moved to `@trinity/util/ui` — those
// helpers have no template and nothing presentational about them, and sitting in `type:ui`
// put them in the one tier `type:data-access` and `type:platform` may not depend on.
//
// What is left is a genuine `type:ui` concern: the provided-loader token that lets a feature
// open the encryption dialogs without importing the feature that owns them.
export * from './lib/encryption-dialog/encryption-dialog.service';
export * from './lib/encryption-dialog/encryption-dialog.tokens';
