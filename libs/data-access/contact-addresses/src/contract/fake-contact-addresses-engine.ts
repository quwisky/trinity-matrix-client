import { type Observable, defer, of } from 'rxjs';
import {
  type EngineFailure,
  type EngineResult,
  type UiaAuth,
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
  /** What the one re-authentication stage, a password, accepts. */
  password: string;
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

function passwordRequired(session: string): EngineFailure {
  return {
    kind: 'http',
    code: 'uia-required',
    diagnostic: { kind: 'http', httpStatus: 401 },
    params: {
      challenge: {
        session,
        flows: [{ stages: ['m.login.password'] }],
        completed: [],
      },
    },
  };
}

/** In-memory homeserver with one identity server's validation sessions and bindings. */
export class FakeContactAddressesEngine implements ContactAddressesEngine {
  private nextId = 0;
  /** Re-authentication sessions a right password was sent in. */
  private readonly reauthenticated = new Set<string>();

  readonly accounts = new Map<string, FakeContactAccount>();
  wellKnown: string | null = null;
  /** Validation sessions by sid, the homeserver's and the identity server's alike. */
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
      password: 'password',
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

  requestAddEmailToken(
    accountId: string,
    request: {
      readonly email: string;
      readonly clientSecret: string;
      readonly sendAttempt: number;
    },
  ): Observable<EngineResult<{ readonly sid: string }>> {
    return this.live(accountId, () => {
      const sid = `hs-sid-${++this.nextId}`;
      this.sessions.set(sid, {
        clientSecret: request.clientSecret,
        address: request.email,
        validated: false,
      });
      return { sid };
    });
  }

  addThreePid(
    accountId: string,
    request: { readonly sid: string; readonly clientSecret: string },
    auth: UiaAuth | null,
  ): Observable<EngineResult<null>> {
    return defer(() => {
      const account = this.accounts.get(accountId);
      if (!account) return of(engineFail(NOT_LIVE));
      if (auth && 'password' in auth && auth.password === account.password) {
        this.reauthenticated.add(auth.session);
      }
      if (!auth || !this.reauthenticated.has(auth.session)) {
        return of(
          engineFail(passwordRequired(auth?.session ?? `uia-${++this.nextId}`)),
        );
      }
      const session = this.sessions.get(request.sid);
      if (
        !session?.validated ||
        session.clientSecret !== request.clientSecret
      ) {
        return of(engineFail(refused(400, 'M_THREEPID_AUTH_FAILED')));
      }
      if (!account.threePids.some((pid) => pid.address === session.address)) {
        account.threePids.push({ medium: 'email', address: session.address });
      }
      return of(engineOk(null));
    });
  }

  deleteThreePid(
    accountId: string,
    medium: string,
    address: string,
  ): Observable<EngineResult<{ readonly unbind: 'success' | 'no-support' }>> {
    return this.live(accountId, (account) => {
      account.threePids = account.threePids.filter(
        (pid) => pid.medium !== medium || pid.address !== address,
      );
      const bound = [...this.bindings.keys()].filter((key) =>
        key.endsWith(`\n${address}`),
      );
      for (const key of bound) this.bindings.delete(key);
      return { unbind: bound.length ? 'success' : 'no-support' } as const;
    });
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
