/** A persisted Matrix login session, restored on app start to recreate the client. */
export interface MatrixSession {
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  /**
   * OIDC refresh token (OAuth 2.0 `refresh_token` grant), present only for accounts
   * signed in via OIDC-native ("next-gen") auth. A long-lived, bearer-equivalent
   * credential — persisted through the platform secure store alongside {@link
   * accessToken}, **never** in the plaintext account registry.
   */
  refreshToken?: string;
  /**
   * Absolute epoch-ms expiry of {@link accessToken} (login/refresh time +
   * `expires_in`). OIDC access tokens are short-lived; the SDK's token refresher uses
   * this to refresh ahead of expiry. Absent for password/SSO sessions, whose tokens
   * do not expire on a fixed schedule.
   */
  accessTokenExpiresAt?: number;
  /**
   * OIDC provider binding, present only for OIDC-native accounts. Grouped so "is this
   * an OIDC account" is a single truthiness check, and so the inputs needed to
   * reconstruct the token refresher on restore stay together. All fields are
   * non-secret (the secret is {@link refreshToken}).
   */
  oidc?: OidcSessionBinding;
  /**
   * IndexedDB name prefix for this account's Rust crypto store, passed to
   * `initRustCrypto({ cryptoDatabasePrefix })`. Assigned per account **and device**
   * (`trinity-crypto:${userId}:${deviceId}`) so multiple accounts on one device don't
   * share a single Olm store, and — crucially — so a fresh login (which mints a new
   * device id) never reopens a store an earlier device left behind (which the Rust
   * OlmMachine rejects as an account/device mismatch). Unset for a migrated
   * pre-multi-account session, which keeps the SDK default prefix so its existing
   * crypto store is preserved (no re-verification on upgrade), until its device changes.
   */
  cryptoPrefix?: string;
}

/** Non-secret OIDC provider binding persisted with a {@link MatrixSession}. */
export interface OidcSessionBinding {
  /** The OIDC issuer (OpenID Provider) that minted the tokens. */
  issuer: string;
  /** This client's id as registered with the provider (dynamic or static registration). */
  clientId: string;
  /** The redirect URI registered for this platform; needed to rebuild the refresher. */
  redirectUri: string;
  /** id_token claims from the authorization grant, used to validate refreshed tokens. */
  idTokenClaims: OidcIdTokenClaims;
}

/**
 * The subset of OIDC id_token claims we persist. Structurally compatible with the
 * SDK's `IdTokenClaims` (from `oidc-client-ts`) — the mandatory JWT claims plus an
 * open index signature — so it round-trips into and out of the token refresher
 * without a direct dependency on `oidc-client-ts` (which is not a resolvable
 * top-level package in this workspace).
 */
export interface OidcIdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  [claim: string]: unknown;
}
