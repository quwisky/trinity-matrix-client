import { type Observable, defer, of } from 'rxjs';
import {
  NOT_SIGNED_IN,
  engineFail,
  engineOk,
  type EngineFailure,
  type EngineResult,
  type LoginRefusal,
  type UiaAuth,
} from '@trinity/util/matrix';
import type {
  AuthEngine,
  EmailTokenRequest,
  PasswordLogin,
  PasswordReset,
  SignedInSession,
  TokenLogin,
} from '../lib/auth-engine';
import type { AuthMetadata } from '../lib/auth-metadata';

interface FakeUser {
  password: string;
  deactivated?: boolean;
  email?: string;
}

interface PendingResetLink {
  readonly email: string;
  readonly clientSecret: string;
  confirmed: boolean;
}

function httpFailure(httpStatus: number, errcode: string): EngineFailure {
  return {
    kind: 'http',
    code: 'request-failed',
    diagnostic: { kind: 'http', httpStatus, errcode },
  };
}

function refused(reason: LoginRefusal): EngineFailure {
  return {
    kind: 'permission',
    code: 'login-refused',
    diagnostic: { kind: 'permission', httpStatus: 403 },
    params: { reason },
  };
}

function challenge(session: string, stage: string): EngineFailure {
  return {
    kind: 'http',
    code: 'uia-required',
    diagnostic: { kind: 'http', httpStatus: 401 },
    params: { challenge: { session, flows: [{ stages: [stage] }] } },
  };
}

/** One in-memory homeserver: users by localpart, live accounts, login tokens and reset links. */
export class FakeAuthEngine implements AuthEngine {
  readonly calls: string[] = [];
  serverName = 'example.org';
  flows: readonly string[] = ['m.login.password'];
  metadata: AuthMetadata | null = null;
  /** False when the server does not register accounts. */
  registrationOpen = true;
  readonly users = new Map<string, FakeUser>();
  /** User ids with a live session, the accounts `changePassword` can reach. */
  readonly accounts = new Set<string>();
  /** Access tokens the homeserver accepts; changing a password keeps them all. */
  readonly accessTokens = new Set<string>();
  /** Login tokens by token, naming a localpart. */
  readonly loginTokens = new Map<string, string>();
  readonly resetLinks = new Map<string, PendingResetLink>();
  /** A failure every command answers with instead, until cleared. */
  failure: EngineFailure | null = null;
  private devices = 0;
  private sessions = 0;

  loginFlows(baseUrl: string): Observable<EngineResult<readonly string[]>> {
    return this.command(`loginFlows:${baseUrl}`, () => engineOk(this.flows));
  }

  authMetadata(baseUrl: string): Observable<EngineResult<AuthMetadata | null>> {
    return this.command(`authMetadata:${baseUrl}`, () =>
      engineOk(this.metadata),
    );
  }

  usernameAvailable(
    baseUrl: string,
    localpart: string,
  ): Observable<EngineResult<boolean>> {
    return this.command(`usernameAvailable:${localpart}`, () =>
      this.registrationOpen
        ? engineOk(!this.users.has(localpart))
        : engineFail({
            kind: 'permission',
            code: 'forbidden',
            diagnostic: { kind: 'permission', httpStatus: 403 },
          }),
    );
  }

  ssoLoginUrl(
    baseUrl: string,
    redirectUrl: string,
  ): Observable<EngineResult<string>> {
    return this.command(`ssoLoginUrl:${baseUrl}`, () =>
      engineOk(
        `${baseUrl}/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent(redirectUrl)}`,
      ),
    );
  }

  loginWithPassword(
    baseUrl: string,
    login: PasswordLogin,
  ): Observable<EngineResult<SignedInSession>> {
    return this.command(`loginWithPassword:${login.localpart}`, () => {
      const user = this.users.get(login.localpart);
      if (user?.deactivated) return engineFail(refused('deactivated'));
      if (user?.password !== login.password) {
        return engineFail(refused('invalid-credentials'));
      }
      return engineOk(this.session(login.localpart, login.deviceId));
    });
  }

  loginWithToken(
    baseUrl: string,
    login: TokenLogin,
  ): Observable<EngineResult<SignedInSession>> {
    return this.command('loginWithToken', () => {
      const localpart = this.loginTokens.get(login.token);
      if (localpart === undefined) {
        return engineFail(refused('invalid-token'));
      }
      this.loginTokens.delete(login.token);
      if (this.users.get(localpart)?.deactivated) {
        return engineFail(refused('deactivated'));
      }
      return engineOk(this.session(localpart, login.deviceId));
    });
  }

  requestPasswordResetToken(
    baseUrl: string,
    request: EmailTokenRequest,
  ): Observable<EngineResult<{ readonly sid: string }>> {
    return this.command('requestPasswordResetToken', () => {
      if (![...this.users.values()].some((u) => u.email === request.email)) {
        return engineFail(httpFailure(400, 'M_THREEPID_NOT_FOUND'));
      }
      const sid = `sid-${this.resetLinks.size + 1}`;
      this.resetLinks.set(sid, {
        email: request.email,
        clientSecret: request.clientSecret,
        confirmed: false,
      });
      return engineOk({ sid });
    });
  }

  resetPassword(
    baseUrl: string,
    reset: PasswordReset,
  ): Observable<EngineResult<null>> {
    return this.command('resetPassword', () => {
      const link = this.resetLinks.get(reset.sid);
      if (!link?.confirmed || link.clientSecret !== reset.clientSecret) {
        return engineFail(challenge('reset', 'm.login.email.identity'));
      }
      const user = [...this.users.values()].find((u) => u.email === link.email);
      if (user) user.password = reset.newPassword;
      return engineOk(null);
    });
  }

  /** Confirms the newest reset link sent with `clientSecret`, as the person would. */
  confirmResetLink(clientSecret: string): void {
    const links = [...this.resetLinks.values()];
    const link = links.reverse().find((l) => l.clientSecret === clientSecret);
    if (link) link.confirmed = true;
  }

  changePassword(
    accountId: string,
    newPassword: string,
    auth: UiaAuth | null,
  ): Observable<EngineResult<null>> {
    return this.command(
      `changePassword:${accountId}:${auth ? 'auth' : 'probe'}`,
      () => {
        if (!this.accounts.has(accountId)) return engineFail(NOT_SIGNED_IN);
        const user = this.users.get(this.localpartOf(accountId));
        const session = `uia-${++this.sessions}`;
        if (
          !user ||
          !auth ||
          !('password' in auth) ||
          auth.password !== user.password
        ) {
          return engineFail(challenge(session, 'm.login.password'));
        }
        user.password = newPassword;
        return engineOk(null);
      },
    );
  }

  private session(localpart: string, deviceId: string | null): SignedInSession {
    const accessToken = `token-${localpart}-${this.accessTokens.size + 1}`;
    this.accessTokens.add(accessToken);
    return {
      userId: `@${localpart}:${this.serverName}`,
      deviceId: deviceId ?? `DEVICE${++this.devices}`,
      accessToken,
      refreshToken: null,
    };
  }

  private localpartOf(userId: string): string {
    return userId.slice(1, userId.indexOf(':'));
  }

  private command<T>(
    call: string,
    run: () => EngineResult<T>,
  ): Observable<EngineResult<T>> {
    return defer(() => {
      this.calls.push(call);
      return of(this.failure ? engineFail(this.failure) : run());
    });
  }
}
