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

/** The tokens a QR sign-in's device grant issued; TypeScript revokes them until they are established. */
export interface QrGrantTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Epoch ms, stamped when the tokens arrived. */
  readonly accessTokenExpiresAt: number | null;
}

/**
 * The new device's QR sign-in (MSC4108). Updates that carry a `flowId` pause the flow until
 * TypeScript answers; `done` and `failed` end it. QR bytes cross as base64.
 */
export type QrSignInUpdate =
  | {
      readonly kind: 'showing-code';
      readonly qr: string;
      readonly expiresAt: number;
    }
  /** Answer `server-accepted` once the other device's account is on the server entered. */
  | {
      readonly kind: 'server-reported';
      readonly flowId: string;
      readonly serverName: string | null;
    }
  | { readonly kind: 'confirm-check-code'; readonly code: string }
  /** The provider refused the client id before anything reached the other device. */
  | { readonly kind: 'client-rejected'; readonly flowId: string }
  | { readonly kind: 'waiting-for-approval'; readonly userCode: string }
  | { readonly kind: 'signing-in'; readonly tokens: QrGrantTokens }
  /** The tokens' account exists on the server; establish it, then `continueQrSignIn`. */
  | {
      readonly kind: 'signed-in';
      readonly flowId: string;
      readonly userId: string;
      readonly deviceId: string;
    }
  | { readonly kind: 'done'; readonly verified: boolean }
  | { readonly kind: 'failed'; readonly reason: QrSignInFailure };

export type QrSignInAnswer =
  | { readonly kind: 'server-accepted' }
  | { readonly kind: 'retry-grant'; readonly clientId: string };

/** The existing device's side of a QR sign-in, which links the device whose code it scanned. */
export type QrLinkUpdate =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'not-sign-in-code' }
  /** Answer with `confirmQrLink`; nothing beyond the protocol offer is sent before it. */
  | {
      readonly kind: 'confirm-check-code';
      readonly flowId: string;
      readonly code: string;
    }
  | { readonly kind: 'approve-in-browser'; readonly verificationUri: string }
  | { readonly kind: 'sharing-secrets' }
  | { readonly kind: 'done' }
  | { readonly kind: 'failed'; readonly reason: QrSignInFailure };

export interface QrLinkAnswer {
  /** Whether the person saw the same check code on both devices. */
  readonly match: boolean;
  /** Whether this device holds the cross-signing identity the server publishes. */
  readonly identityHeld: boolean;
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
  /** OAuth 2.0 metadata with the device grant, and MSC4108; a failure when it cannot be asked. */
  supportsQrRendezvous(baseUrl: string): Observable<EngineResult<boolean>>;
  /**
   * Shows a new code for another device to scan. Unsubscribing cancels the sign-in on both
   * devices. The secrets the other device shares are imported here and never emitted.
   */
  signInWithQr(
    baseUrl: string,
    request: {
      readonly grantMetadata: AuthMetadata;
      readonly clientId: string;
    },
  ): Observable<QrSignInUpdate>;
  /** A flow that is over, or not paused for this answer, fails `qr-flow-gone`. */
  answerQrSignIn(
    flowId: string,
    answer: QrSignInAnswer,
  ): Observable<EngineResult<null>>;
  /**
   * The `signed-in` session is established as `accountId`: share and import the secrets.
   * `accountId` must be that update's user, and its live session must be on that update's
   * device; otherwise nothing is imported and the sign-in ends `done` unverified.
   */
  continueQrSignIn(
    flowId: string,
    accountId: string,
  ): Observable<EngineResult<null>>;
  /**
   * Links the device whose code `accountId`'s device scanned; unsubscribing cancels it. The
   * engine refuses an MSC4388 code (`not-sign-in-code`), opens the approval link only on the
   * account's own issuer or device-authorization origin (else `failed insecure`), stops
   * sending a decline once the identity check passed, so a cancel reaches the session first,
   * and leaves the rendezvous session for the new device to delete.
   */
  linkDeviceWithQr(accountId: string, qr: string): Observable<QrLinkUpdate>;
  /** A mismatch ends the link as insecure; an identity not held ends it before any grant. */
  confirmQrLink(
    flowId: string,
    answer: QrLinkAnswer,
  ): Observable<EngineResult<null>>;
}
