import type { Observable } from 'rxjs';
import type { EngineResult } from '@trinity/util/matrix';

/** A third-party identifier bound to the account on its homeserver. */
export interface ThreePid {
  readonly medium: string;
  readonly address: string;
}

/** An OpenID token from the homeserver, which an identity server exchanges for its own token. */
export interface OpenIdToken {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly matrixServerName: string;
  readonly expiresIn: number;
}

/**
 * The homeserver side of an account's contact addresses. Identity-server HTTP is not here
 * (`identity-server-http.ts`). Every member emits once and completes; without a live client
 * it fails `account-not-live`, otherwise `request-failed` with the server's `errcode` and
 * `httpStatus` in the diagnostic.
 */
export interface ContactAddressesEngine {
  /** Rust: `Account::get_3pids()` + `Client::get_capabilities()` (`m.3pid_changes`, on unless disabled). */
  threePids(accountId: string): Observable<
    EngineResult<{
      readonly addresses: readonly ThreePid[];
      readonly canChange: boolean;
    }>
  >;

  /**
   * `m.identity_server` account data from the server (`account` null when it was never
   * written) and the client well-known's identity server, unchecked.
   * Rust: `Account::fetch_account_data`, `Client::well_known()`.
   */
  identityServerSetting(accountId: string): Observable<
    EngineResult<{
      readonly account: { readonly baseUrl: string | null } | null;
      readonly wellKnown: string | null;
    }>
  >;

  /** Writes `m.identity_server`; null records "no identity server". */
  setIdentityServer(
    accountId: string,
    baseUrl: string | null,
  ): Observable<EngineResult<null>>;

  /** The policy URLs in `m.accepted_terms`, read from the server. */
  acceptedTerms(accountId: string): Observable<EngineResult<readonly string[]>>;

  /** Replaces `m.accepted_terms` with `urls`. */
  setAcceptedTerms(
    accountId: string,
    urls: readonly string[],
  ): Observable<EngineResult<null>>;

  /** Rust: `Account::request_openid_token()`. */
  openIdToken(accountId: string): Observable<EngineResult<OpenIdToken>>;

  /** `idServer` is the identity server's host (and port), without a scheme. */
  bindThreePid(
    accountId: string,
    request: {
      readonly sid: string;
      readonly clientSecret: string;
      readonly idServer: string;
      readonly idAccessToken: string;
    },
  ): Observable<EngineResult<null>>;

  /** Unbinds at `idServer` (host and port, no scheme); 'no-support' when that server cannot. */
  unbindThreePid(
    accountId: string,
    request: {
      readonly medium: 'email';
      readonly address: string;
      readonly idServer: string;
    },
  ): Observable<EngineResult<'success' | 'no-support'>>;
}
