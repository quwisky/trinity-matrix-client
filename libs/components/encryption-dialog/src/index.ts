// @trinity/components/encryption-dialog — present the encryption flows as a dialog or a route.
//
// The last thing `@trinity/ui` held, and the reason that library existed at all: a seam that
// lets four features open feature-crypto's pages without importing feature-crypto, which the
// `type:feature` boundary forbids outright. `main.ts` fills
// `ENCRYPTION_DIALOG_COMPONENTS` with dynamic `import('@trinity/feature/crypto')` calls, so
// nothing here ever names the feature and the service falls back to routing when the token is
// absent.
//
// Its own library rather than part of `@trinity/components/overlay`, deliberately. That
// library is the generic, swappable dialog wrapper — folding this in would teach it the
// `/encryption/unlock` route, an `asModal` input and one domain's loader token, which is
// precisely the accretion its own barrel refuses ("Re-add it with a real consumer").
export * from './lib/encryption-dialog.service';
export * from './lib/encryption-dialog.tokens';
