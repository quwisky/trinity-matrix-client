/** A persisted Matrix login session, restored on app start to recreate the client. */
export interface MatrixSession {
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  /**
   * OIDC refresh token (OAuth 2.0 `refresh_token` grant), present only for OIDC-native
   * accounts. A long-lived, bearer-equivalent credential: persisted through the platform
   * secure store alongside {@link accessToken}, **never** in the plaintext account registry.
   * On a phone native code takes it over when the client starts, so a stored session then has
   * none and a live client holds a non-secret marker in its place.
   */
  refreshToken?: string;
  /**
   * Absolute epoch-ms expiry of {@link accessToken} (login/refresh time + `expires_in`).
   * matrix-js-sdk takes no initial expiry, so it refreshes on the first 401 after a restart.
   * Absent for password/SSO sessions.
   */
  accessTokenExpiresAt?: number;
  /**
   * OIDC provider binding, present only for OIDC-native accounts, so "is this an OIDC
   * account" is a single truthiness check. All fields are non-secret (the secret is
   * {@link refreshToken}).
   */
  oidc?: OidcSessionBinding;
  /**
   * IndexedDB name prefix for this account's Rust crypto store, passed to
   * `initRustCrypto({ cryptoDatabasePrefix })`. Assigned per account **and device**
   * (`trinity-crypto:${userId}:${deviceId}`) so accounts don't share an Olm store and a
   * fresh login (new device id) never reopens a store the Rust OlmMachine would reject as an
   * account/device mismatch. Unset for a migrated pre-multi-account session, which keeps
   * the SDK default prefix (no re-verification on upgrade) until its device changes.
   */
  cryptoPrefix?: string;
  /**
   * Set when {@link cryptoPrefix}'s store was created with a store key (kept in secure
   * storage under that prefix). Non-secret. Absent for a store that predates store keys,
   * which stays unencrypted; a keyed store whose key is gone cannot be opened.
   */
  cryptoStoreKeyed?: true;
  /**
   * Names the sign-in whose tokens the stored record holds. Storage mints a new one on each
   * save and a token refresh keeps it, so a refresh never overwrites a newer sign-in's
   * tokens for the same account. Non-secret. Absent for sessions saved before it existed.
   */
  lineage?: string;
}

/** Non-secret OIDC provider binding persisted with a {@link MatrixSession}. */
export interface OidcSessionBinding {
  /** The OIDC issuer (OpenID Provider) that minted the tokens. */
  issuer: string;
  /** This client's id as registered with the provider (dynamic or static registration). */
  clientId: string;
  /**
   * The redirect URI registered for this platform; repeated in the code exchange. Absent
   * for a QR sign-in, whose device grant has no redirect.
   */
  redirectUri?: string;
  /**
   * The issuer's token endpoint as verified at sign-in. Token refresh refuses homeserver
   * metadata that names another. Absent for sessions saved before it was recorded, until
   * their first refresh records it.
   */
  tokenEndpoint?: string;
  /** The issuer's revocation endpoint as verified at sign-in; absent like {@link tokenEndpoint}. */
  revocationEndpoint?: string;
  /**
   * Set once the issuer's own document disagreed with the homeserver's endpoints for a
   * binding without them. From then on only endpoints that document confirms are pinned
   * or used, since a failed fetch looks the same as an issuer that publishes none.
   */
  requiresIssuerConfirmation?: boolean;
  /**
   * @deprecated Not written since matrix-js-sdk 42. That release dropped `oidc-client-ts`
   * and with it the id_token entirely, so there are no claims to capture and nothing reads
   * these any more. The field stays optional rather than deleted because sessions written
   * before the upgrade still carry it on disk, and the registry is parsed with a bare
   * `JSON.parse ... as AccountRegistry` — the type's job is to describe what is actually
   * stored. Remove once those records have aged out.
   */
  idTokenClaims?: OidcIdTokenClaims;
}

/**
 * The subset of OIDC id_token claims persisted by sessions created before
 * matrix-js-sdk 42. Structurally compatible with the `IdTokenClaims` the SDK used to
 * take (from `oidc-client-ts`) — the mandatory JWT claims plus an open index signature.
 *
 * Deliberately NOT marked `@deprecated`, even though nothing writes it any more: it is
 * still the accurate type of data sitting in existing account registries, and the
 * deprecated member is the field that holds it, not the shape itself. Marking both also
 * made `no-deprecated` fire on that field's own type annotation.
 */
export interface OidcIdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  [claim: string]: unknown;
}
