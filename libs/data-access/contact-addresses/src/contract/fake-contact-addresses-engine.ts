import { type Observable, defer, of } from 'rxjs';
import {
  type EngineFailure,
  type EngineResult,
  engineFail,
  engineOk,
} from '@trinity/util/matrix';
import type {
  ContactAddressesEngine,
  OpenIdToken,
  ThreePid,
} from '../lib/contact-addresses-engine';

/** One signed-in account's homeserver state. */
export interface FakeContactAccount {
  threePids: ThreePid[];
  canChange: boolean;
  /** `m.identity_server`; undefined until written. */
  identityServer?: { baseUrl: string | null };
  acceptedTerms: string[];
}

const NOT_LIVE: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

function refused(httpStatus: number, errcode: string): EngineFailure {
  return {
    kind: 'http',
    code: 'request-failed',
    diagnostic: { kind: 'http', httpStatus, errcode },
  };
}

/** In-memory homeserver with one identity server's validation sessions and bindings. */
export class FakeContactAddressesEngine implements ContactAddressesEngine {
  readonly accounts = new Map<string, FakeContactAccount>();
  wellKnown: string | null = null;
  /** Validation sessions by sid, as the identity server holds them. */
  readonly sessions = new Map<
    string,
    { clientSecret: string; address: string; validated: boolean }
  >();
  /** `idServer\naddress` to the account bound there. */
  readonly bindings = new Map<string, string>();
  readonly openId: OpenIdToken = {
    accessToken: 'openid-token',
    tokenType: 'Bearer',
    matrixServerName: 'example.org',
    expiresIn: 3600,
  };

  signIn(accountId: string, account: Partial<FakeContactAccount> = {}): void {
    this.accounts.set(accountId, {
      threePids: [],
      canChange: true,
      acceptedTerms: [],
      ...account,
    });
  }

  threePids(accountId: string): Observable<
    EngineResult<{
      readonly addresses: readonly ThreePid[];
      readonly canChange: boolean;
    }>
  > {
    return this.live(accountId, (account) => ({
      addresses: account.threePids.map((pid) => ({ ...pid })),
      canChange: account.canChange,
    }));
  }

  identityServerSetting(accountId: string): Observable<
    EngineResult<{
      readonly account: { readonly baseUrl: string | null } | null;
      readonly wellKnown: string | null;
    }>
  > {
    return this.live(accountId, (account) => ({
      account: account.identityServer ? { ...account.identityServer } : null,
      wellKnown: this.wellKnown,
    }));
  }

  setIdentityServer(
    accountId: string,
    baseUrl: string | null,
  ): Observable<EngineResult<null>> {
    return this.live(accountId, (account) => {
      account.identityServer = { baseUrl };
      return null;
    });
  }

  acceptedTerms(
    accountId: string,
  ): Observable<EngineResult<readonly string[]>> {
    return this.live(accountId, (account) => [...account.acceptedTerms]);
  }

  setAcceptedTerms(
    accountId: string,
    urls: readonly string[],
  ): Observable<EngineResult<null>> {
    return this.live(accountId, (account) => {
      account.acceptedTerms = [...urls];
      return null;
    });
  }

  openIdToken(accountId: string): Observable<EngineResult<OpenIdToken>> {
    return this.live(accountId, () => ({ ...this.openId }));
  }

  bindThreePid(
    accountId: string,
    request: {
      readonly sid: string;
      readonly clientSecret: string;
      readonly idServer: string;
      readonly idAccessToken: string;
    },
  ): Observable<EngineResult<null>> {
    return defer(() => {
      if (!this.accounts.has(accountId)) return of(engineFail(NOT_LIVE));
      const session = this.sessions.get(request.sid);
      if (!session || session.clientSecret !== request.clientSecret) {
        return of(engineFail(refused(400, 'M_NO_VALID_SESSION')));
      }
      if (!session.validated) {
        return of(engineFail(refused(400, 'M_SESSION_NOT_VALIDATED')));
      }
      this.bindings.set(`${request.idServer}\n${session.address}`, accountId);
      return of(engineOk(null));
    });
  }

  unbindThreePid(
    accountId: string,
    request: {
      readonly medium: 'email';
      readonly address: string;
      readonly idServer: string;
    },
  ): Observable<EngineResult<'success' | 'no-support'>> {
    return this.live(accountId, () =>
      this.bindings.delete(`${request.idServer}\n${request.address}`)
        ? 'success'
        : 'no-support',
    );
  }

  private live<T>(
    accountId: string,
    run: (account: FakeContactAccount) => T,
  ): Observable<EngineResult<T>> {
    return defer(() => {
      const account = this.accounts.get(accountId);
      return of(account ? engineOk(run(account)) : engineFail(NOT_LIVE));
    });
  }
}
