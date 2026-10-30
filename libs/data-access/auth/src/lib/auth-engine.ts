import type { Observable } from 'rxjs';
import type { EngineResult, UiaAuth } from '@trinity/util/matrix';
import type { AuthMetadata } from './auth-metadata';
import type { QrSignInFailure } from './qr-sign-in/qr-sign-in.model';

/** The credentials a sign-in produced, before TypeScript establishes them as an account. */
export interface SignedInSession {
  readonly userId: string;
  readonly deviceId: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

/**
 * A QR sign-in's session. The engine holds it, with the secrets the other device shared, until
 * `SessionEngine.restorePersisted` adopts this user and device or `logoutSession` ends it.
 */
export interface QrSignedInSession {
  /** Where the session is: the engine may have followed the other device to its server. */
  readonly homeserverUrl: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Epoch ms, stamped when the tokens arrived. */
  readonly accessTokenExpiresAt: number | null;
}

/**
 * The new device's QR sign-in (MSC4108). `enter-check-code` pauses until TypeScript answers;
 * `done`, `client-rejected` and `failed` end it. QR bytes cross as base64.
 */
export type QrSignInUpdate =
  | {
      readonly kind: 'showing-code';
      readonly qr: string;
      readonly expiresAt: number;
    }
  /** Answer with the two digits the other device shows; a wrong code ends `failed insecure`. */
  | { readonly kind: 'enter-check-code'; readonly flowId: string }
  | { readonly kind: 'waiting-for-approval'; readonly userCode: string }
  | { readonly kind: 'signing-in' }
  | { readonly kind: 'done'; readonly session: QrSignedInSession }
  /** The provider refused the client id before any grant; register again and start over. */
  | { readonly kind: 'client-rejected' }
  | { readonly kind: 'failed'; readonly reason: QrSignInFailure };

export interface QrSignInAnswer {
  /** Exactly two digits, as typed: "07". */
  readonly checkCode: string;
}

/**
 * The existing device's side of a QR sign-in, which links the device whose code it scanned.
 * `approve` is the one pause; nothing beyond the protocol offer is sent before `confirmQrLink`.
 */
export type QrLinkUpdate =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'not-sign-in-code' }
  /** For the person to type on the new device; nothing to answer. */
  | { readonly kind: 'check-code'; readonly code: string }
  /** The new device asked for a grant. The URI is as the peer sent it: unchecked. */
  | {
      readonly kind: 'approve';
      readonly flowId: string;
      readonly verificationUri: string;
    }
  | { readonly kind: 'sharing-secrets' }
  | { readonly kind: 'done' }
  | { readonly kind: 'failed'; readonly reason: QrSignInFailure };

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
  /** OAuth 2.0 metadata with the device grant, and MSC4108; a failure when it cannot be asked. */
  supportsQrRendezvous(baseUrl: string): Observable<EngineResult<boolean>>;
  /**
   * Shows a new code for another device to scan; unsubscribing cancels the sign-in on both
   * devices. No grant is asked for before the typed code matches. Tokens the flow got are
   * revoked unless `done` hands them over. The secrets the other device shares stay in the
   * engine with the session and are never emitted.
   */
  signInWithQr(
    baseUrl: string,
    request: {
      readonly grantMetadata: AuthMetadata;
      readonly clientId: string;
    },
  ): Observable<QrSignInUpdate>;
  /** A flow that is over, or not paused for the code, fails `qr-flow-gone`. */
  answerQrSignIn(
    flowId: string,
    answer: QrSignInAnswer,
  ): Observable<EngineResult<null>>;
  /**
   * Links the device whose code `accountId`'s device scanned. The engine refuses an MSC4388
   * code (`not-sign-in-code`) and leaves the rendezvous session for the new device to
   * delete. Unsubscribing before `confirmQrLink` declines and cancels on the new device;
   * after it, it cancels at once, so the cancel reaches the session before the secrets.
   */
  linkDeviceWithQr(accountId: string, qr: string): Observable<QrLinkUpdate>;
  /**
   * Continues past `approve`: the engine accepts the grant and shares the secrets once the new
   * device is signed in. A flow not paused there fails `qr-flow-gone`.
   */
  confirmQrLink(flowId: string): Observable<EngineResult<null>>;
}
