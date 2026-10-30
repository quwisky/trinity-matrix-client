import type { Observable } from 'rxjs';
import type { EngineResult, UiaAuth } from '@trinity/util/matrix';
import type { AuthMetadata } from './auth-metadata';

/** The credentials a sign-in produced, before TypeScript establishes them as an account. */
export interface SignedInSession {
  readonly userId: string;
  readonly deviceId: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

export interface PasswordLogin {
  readonly localpart: string;
  readonly password: string;
  readonly deviceDisplayName: string;
  /** The existing device a re-authentication signs back in on, else null for a new one. */
  readonly deviceId: string | null;
}

export interface TokenLogin {
  readonly token: string;
  readonly deviceDisplayName: string;
  readonly deviceId: string | null;
}

export interface Registration {
  readonly localpart: string;
  readonly password: string;
  readonly deviceDisplayName: string;
}

/** A registration stage's `auth`: the UIA session, the stage `type` and its own fields. */
export interface RegistrationAuth {
  readonly session?: string;
  readonly type?: string;
  readonly [field: string]: unknown;
}

/**
 * What the homeserver answered for a created account, as it sent it: the caller checks the
 * identity and the tokens before establishing anything.
 */
export interface RegisteredAccount {
  readonly userId: string;
  readonly deviceId: string | null;
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  /** The access token's lifetime from now, when it expires. */
  readonly expiresInMs: number | null;
}

export interface EmailTokenRequest {
  readonly email: string;
  readonly clientSecret: string;
  readonly sendAttempt: number;
}

/** Who an access token belongs to; a session without a device has `deviceId` null. */
export interface TokenOwner {
  readonly userId: string;
  readonly deviceId: string | null;
}

export interface PasswordReset {
  readonly sid: string;
  readonly clientSecret: string;
  readonly newPassword: string;
  readonly logoutDevices: boolean;
}

/**
 * Sign-in and password commands, as plain data. Every command is cold, emits once and
 * completes; expected failures are values. A request the server answers with user-interactive
 * auth fails `uia-required` with the challenge, and is sent again with an `auth` for it.
 */
export interface AuthEngine {
  loginFlows(baseUrl: string): Observable<EngineResult<readonly string[]>>;
  /**
   * The metadata document as the homeserver serves it, every field Trinity reads passed
   * through unchanged, `authorization_response_iss_parameter_supported` included: the RFC
   * 9207 callback check depends on it. Null when the server answers without OAuth 2.0
   * metadata; a failure when it cannot be asked.
   */
  authMetadata(baseUrl: string): Observable<EngineResult<AuthMetadata | null>>;
  /** A server that does not register accounts fails `forbidden`. */
  usernameAvailable(
    baseUrl: string,
    localpart: string,
  ): Observable<EngineResult<boolean>>;
  ssoLoginUrl(
    baseUrl: string,
    redirectUrl: string,
  ): Observable<EngineResult<string>>;
  /** A refused password or deactivated account fails `login-refused`. */
  loginWithPassword(
    baseUrl: string,
    login: PasswordLogin,
  ): Observable<EngineResult<SignedInSession>>;
  /** A refused token (expired or already used) or deactivated account fails `login-refused`. */
  loginWithToken(
    baseUrl: string,
    login: TokenLogin,
  ): Observable<EngineResult<SignedInSession>>;
  /**
   * Creates an account and signs it in on a new device. The server's user-interactive auth
   * fails `uia-required` with the challenge, its stage params and the server's text; a
   * refused step's text crosses as `serverMessage` too.
   */
  register(
    baseUrl: string,
    registration: Registration,
    auth: RegistrationAuth | null,
  ): Observable<EngineResult<RegisteredAccount>>;
  /** A refused address carries the server's text as `serverMessage`. */
  requestRegistrationEmailToken(
    baseUrl: string,
    request: EmailTokenRequest,
  ): Observable<EngineResult<{ readonly sid: string }>>;
  requestPasswordResetToken(
    baseUrl: string,
    request: EmailTokenRequest,
  ): Observable<EngineResult<{ readonly sid: string }>>;
  /** A link not confirmed yet fails `uia-required`. */
  resetPassword(
    baseUrl: string,
    reset: PasswordReset,
  ): Observable<EngineResult<null>>;
  /** The user and device an access token was issued for, asked of the homeserver. */
  whoami(
    baseUrl: string,
    accessToken: string,
  ): Observable<EngineResult<TokenOwner>>;
  /** Keeps the account's other sessions signed in; the probe sends no `auth` at all. */
  changePassword(
    accountId: string,
    newPassword: string,
    auth: UiaAuth | null,
  ): Observable<EngineResult<null>>;
}
