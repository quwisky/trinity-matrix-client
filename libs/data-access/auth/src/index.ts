export * from './lib/auth.service';
export * from './lib/auth.guard';
export * from './lib/factory-reset.service';
export type {
  OidcApplicationType,
  OidcAuthorizationParams,
  OidcAuthorizationRequest,
  OidcGrantContext,
} from './lib/oidc-client.service';
// Re-export the validated delegated-auth metadata so feature libs can type it without
// importing matrix-js-sdk directly (components never do).
//
// Deliberately aliased to a local name. Upstream has now renamed this type once already
// — it was `OidcClientConfig` until matrix-js-sdk 42 replaced the whole OIDC module with
// `oauth` — and each rename would otherwise churn every consumer across a library
// boundary. `AuthMetadata` is the name this workspace uses; only this line tracks theirs.
export type { ValidatedAuthMetadata as AuthMetadata } from 'matrix-js-sdk';
