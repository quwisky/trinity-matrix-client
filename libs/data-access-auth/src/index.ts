export * from './lib/auth.service';
export * from './lib/auth.guard';
export type {
  OidcApplicationType,
  OidcAuthorizationParams,
  OidcAuthorizationRequest,
} from './lib/oidc-client.service';
// Re-export the validated OIDC provider config so feature libs can type the delegated
// auth metadata without importing matrix-js-sdk directly (components never do).
export type { OidcClientConfig } from 'matrix-js-sdk';
