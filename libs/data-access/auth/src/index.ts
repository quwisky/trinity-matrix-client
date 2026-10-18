export * from './lib/auth.service';
export {
  deletionLink,
  type AccountManagement,
  type AccountServerApi,
} from './lib/account-server-api';
export * from './lib/registration.service';
export {
  ReauthAccountMismatchError,
  UnacceptableAccountError,
} from './lib/account-establishment';
export type { LoginMode } from './lib/account-establishment';
export { OidcClientService } from './lib/oidc-client.service';
export type {
  OidcApplicationType,
  OidcAuthorizationParams,
  OidcAuthorizationRequest,
  OidcGrantContext,
} from './lib/oidc-client.service';
// Re-export the validated delegated-auth metadata so feature libs can type it without
// importing matrix-js-sdk directly (components never do).
// Aliased to a local name so an upstream rename only touches this line.
export type { ValidatedAuthMetadata as AuthMetadata } from 'matrix-js-sdk';
export * from './lib/homeserver-discovery.port';
export { OidcStateStore } from './lib/oidc-state.store';
export type { OidcStateStash } from './lib/oidc-state.store';
export { SsoStateStore } from './lib/sso-state.store';
export type { SsoStateStash } from './lib/sso-state.store';
export { SignInRedirectService } from './lib/sign-in-redirect.service';
export * from './lib/new-device-sign-in.port';
export { isPartOfServer } from './lib/part-of-server';
export { matchesPinnedProvider } from './lib/pinned-provider';
export type {
  ExistingDeviceState,
  NewDeviceState,
  QrSignInFailure,
} from './lib/qr-sign-in/qr-sign-in.model';
export { qrSignInFailureOf } from './lib/qr-sign-in/qr-sign-in.model';
export { QrSignInAvailability } from './lib/qr-sign-in/qr-sign-in-availability.service';
export { QrSignInService } from './lib/qr-sign-in/qr-sign-in.service';
export type { ExistingDeviceLink } from './lib/qr-sign-in/qr-sign-in.adapter';
export {
  QR_SIGN_IN_COMPLETION,
  type LinkedSecrets,
  type QrSignInCompletion,
} from './lib/qr-sign-in/qr-sign-in-completion.port';
