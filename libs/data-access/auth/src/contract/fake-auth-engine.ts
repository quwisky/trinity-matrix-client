import { Observable, defer, of, type Subscriber } from 'rxjs';
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
  QrLinkAnswer,
  QrLinkUpdate,
  QrSignInAnswer,
  QrSignInUpdate,
  RegisteredAccount,
  Registration,
  RegistrationAuth,
  SignedInSession,
  TokenLogin,
  TokenOwner,
} from '../lib/auth-engine';
import type { AuthMetadata } from '../lib/auth-metadata';
import type { QrSignInFailure } from '../lib/qr-sign-in/qr-sign-in.model';

interface FakeUser {
  password: string;
  deactivated?: boolean;
  email?: string;
}

interface PendingEmailLink {
  readonly email: string;
  readonly clientSecret: string;
  confirmed: boolean;
}

function httpFailure(
  httpStatus: number,
  errcode: string,
  serverMessage?: string,
): EngineFailure {
  return {
    kind: 'http',
    code: 'request-failed',
    diagnostic: { kind: 'http', httpStatus, errcode },
    ...(serverMessage ? { params: { serverMessage } } : {}),
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

const REGISTRATION_FLOWS = [['m.login.dummy'], ['m.login.email.identity']];

function challenge(session: string, stage: string): EngineFailure {
  return {
    kind: 'http',
    code: 'uia-required',
    diagnostic: { kind: 'http', httpStatus: 401 },
    params: { challenge: { session, flows: [{ stages: [stage] }] } },
  };
}

function confirmNewest(
  links: ReadonlyMap<string, PendingEmailLink>,
  clientSecret: string,
): void {
  const link = [...links.values()]
    .reverse()
    .find((l) => l.clientSecret === clientSecret);
  if (link) link.confirmed = true;
}

const QR_FLOW_GONE: EngineFailure = {
  kind: 'unexpected',
  code: 'qr-flow-gone',
  diagnostic: { kind: 'unexpected' },
};
const STOPPED = Symbol('stopped');

/** A QR flow the fake runs: it emits until it pauses for an answer, ends or is stopped. */
class FakeQrRun<U extends { kind: string }> {
  readonly id = crypto.randomUUID();
  ended = false;
  private waiting?: { pause: string; resolve: (value: never) => void };

  constructor(
    private readonly subscriber: Subscriber<U>,
    private readonly stop: { after: string; reason?: QrSignInFailure } | null,
  ) {}

  emit(update: U): void {
    if (this.ended) throw STOPPED;
    this.subscriber.next(update);
    if (this.stop?.after !== update.kind) return;
    const { reason } = this.stop;
    if (reason) this.end({ kind: 'failed', reason } as unknown as U);
    throw STOPPED;
  }

  end(update: U): void {
    if (this.ended) return;
    this.ended = true;
    this.subscriber.next(update);
    this.subscriber.complete();
  }

  /** Emits `update`, then waits for the answer to `pause`. */
  pause<T>(pause: string, update: U): Promise<T> {
    const answer = new Promise<T>(
      (resolve) => (this.waiting = { pause, resolve }),
    );
    this.emit(update);
    return answer;
  }

  answer(pause: string, value: unknown): boolean {
    const waiting = this.waiting;
    if (this.ended || waiting?.pause !== pause) return false;
    this.waiting = undefined;
    (waiting.resolve as (value: unknown) => void)(value);
    return true;
  }
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
  /** Access tokens the homeserver accepts, by owner; changing a password keeps them all. */
  readonly accessTokens = new Map<string, TokenOwner>();
  /** Login tokens by token, naming a localpart. */
  readonly loginTokens = new Map<string, string>();
  readonly resetLinks = new Map<string, PendingEmailLink>();
  /** Registration's email links by sid. */
  readonly registrationLinks = new Map<string, PendingEmailLink>();
  /** The stages each registration UIA session has completed. */
  private readonly registrations = new Map<string, Set<string>>();
  /** A failure every command answers with instead, until cleared. */
  failure: EngineFailure | null = null;
  /** Whether the server offers QR sign-in: OAuth 2.0 with the device grant, and MSC4108. */
  qrRendezvous = false;
  /** The other device a QR sign-in meets. */
  readonly qrPeer = {
    serverName: 'example.org' as string | null,
    userId: '@alice:example.org',
    deviceId: 'QRDEVICE',
    /** Client ids the provider refuses for the device grant. */
    refusedClients: new Set<string>(),
    /** Whether the secrets it shares verify the new device. */
    verifies: true,
    verificationUri: 'https://auth.example.org/link',
  };
  /** Stops each QR flow after its update of this kind: failing with `reason`, else waiting. */
  qrStop: { after: string; reason?: QrSignInFailure } | null = null;
  private devices = 0;
  private sessions = 0;
  private readonly qrRuns = new Map<string, FakeQrRun<{ kind: string }>>();

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

  register(
    baseUrl: string,
    registration: Registration,
    auth: RegistrationAuth | null,
  ): Observable<EngineResult<RegisteredAccount>> {
    const step = auth ? (auth.type ?? 'session') : 'probe';
    return this.command(`register:${registration.localpart}:${step}`, () => {
      if (!this.registrationOpen) {
        return engineFail(httpFailure(403, 'M_FORBIDDEN'));
      }
      if (this.users.has(registration.localpart)) {
        return engineFail(
          httpFailure(400, 'M_USER_IN_USE', 'User ID already taken.'),
        );
      }
      if (
        auth?.session !== undefined &&
        !this.registrations.has(auth.session)
      ) {
        return engineFail(
          httpFailure(400, 'M_UNKNOWN', `Unknown session ID: ${auth.session}`),
        );
      }
      const session = auth?.session ?? `registration-${++this.sessions}`;
      const completed = this.registrations.get(session) ?? new Set<string>();
      this.registrations.set(session, completed);
      if (
        auth?.type === 'm.login.dummy' ||
        (auth?.type === 'm.login.email.identity' && this.confirmedEmail(auth))
      ) {
        completed.add(auth.type);
      }
      if (!REGISTRATION_FLOWS.some((f) => f.every((s) => completed.has(s)))) {
        return engineFail({
          kind: 'http',
          code: 'uia-required',
          diagnostic: { kind: 'http', httpStatus: 401 },
          params: {
            challenge: {
              session,
              flows: REGISTRATION_FLOWS.map((stages) => ({ stages })),
              completed: [...completed],
            },
          },
        });
      }
      this.registrations.delete(session);
      this.users.set(registration.localpart, {
        password: registration.password,
      });
      const { userId, deviceId, accessToken } = this.session(
        registration.localpart,
        null,
      );
      return engineOk({
        userId,
        deviceId,
        accessToken,
        refreshToken: null,
        expiresInMs: null,
      });
    });
  }

  requestRegistrationEmailToken(
    baseUrl: string,
    request: EmailTokenRequest,
  ): Observable<EngineResult<{ readonly sid: string }>> {
    return this.command('requestRegistrationEmailToken', () => {
      if ([...this.users.values()].some((u) => u.email === request.email)) {
        return engineFail(
          httpFailure(400, 'M_THREEPID_IN_USE', 'Email is already in use'),
        );
      }
      const sid = `registration-sid-${this.registrationLinks.size + 1}`;
      this.registrationLinks.set(sid, {
        email: request.email,
        clientSecret: request.clientSecret,
        confirmed: false,
      });
      return engineOk({ sid });
    });
  }

  /** Confirms the newest registration link sent with `clientSecret`, as the person would. */
  confirmRegistrationLink(clientSecret: string): void {
    confirmNewest(this.registrationLinks, clientSecret);
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
    confirmNewest(this.resetLinks, clientSecret);
  }

  whoami(
    baseUrl: string,
    accessToken: string,
  ): Observable<EngineResult<TokenOwner>> {
    return this.command(`whoami:${baseUrl}`, () => {
      const owner = this.accessTokens.get(accessToken);
      return owner
        ? engineOk(owner)
        : engineFail({
            kind: 'authentication',
            code: 'request-failed',
            diagnostic: {
              kind: 'authentication',
              httpStatus: 401,
              errcode: 'M_UNKNOWN_TOKEN',
            },
          });
    });
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

  supportsQrRendezvous(baseUrl: string): Observable<EngineResult<boolean>> {
    return this.command(`supportsQrRendezvous:${baseUrl}`, () =>
      engineOk(this.qrRendezvous),
    );
  }

  signInWithQr(
    baseUrl: string,
    request: {
      readonly grantMetadata: AuthMetadata;
      readonly clientId: string;
    },
  ): Observable<QrSignInUpdate> {
    return this.qrFlow<QrSignInUpdate>(
      `signInWithQr:${request.clientId}`,
      async (run) => {
        if (!this.qrRendezvous) {
          run.end({ kind: 'failed', reason: 'unsupported' });
          return;
        }
        run.emit({
          kind: 'showing-code',
          qr: btoa(`MATRIX${run.id}`),
          expiresAt: Date.now() + 60_000,
        });
        await run.pause('server', {
          kind: 'server-reported',
          flowId: run.id,
          serverName: this.qrPeer.serverName,
        });
        run.emit({ kind: 'confirm-check-code', code: '42' });
        let clientId = request.clientId;
        while (this.qrPeer.refusedClients.has(clientId)) {
          clientId = await run.pause<string>('grant', {
            kind: 'client-rejected',
            flowId: run.id,
          });
        }
        run.emit({ kind: 'waiting-for-approval', userCode: 'ABCD' });
        run.emit({
          kind: 'signing-in',
          tokens: {
            accessToken: `qr-token-${clientId}`,
            refreshToken: `qr-refresh-${clientId}`,
            accessTokenExpiresAt: Date.now() + 300_000,
          },
        });
        const accountId = await run.pause<string>('established', {
          kind: 'signed-in',
          flowId: run.id,
          userId: this.qrPeer.userId,
          deviceId: this.qrPeer.deviceId,
        });
        run.end({
          kind: 'done',
          verified:
            this.qrPeer.verifies &&
            accountId === this.qrPeer.userId &&
            this.accounts.has(accountId),
        });
      },
    );
  }

  answerQrSignIn(
    flowId: string,
    answer: QrSignInAnswer,
  ): Observable<EngineResult<null>> {
    return answer.kind === 'retry-grant'
      ? this.command(`answerQrSignIn:retry-grant:${answer.clientId}`, () =>
          this.qrAnswer(flowId, 'grant', answer.clientId),
        )
      : this.command(`answerQrSignIn:${answer.kind}`, () =>
          this.qrAnswer(flowId, 'server', undefined),
        );
  }

  continueQrSignIn(
    flowId: string,
    accountId: string,
  ): Observable<EngineResult<null>> {
    return this.command(`continueQrSignIn:${accountId}`, () =>
      this.qrAnswer(flowId, 'established', accountId),
    );
  }

  /** Takes base64 whose bytes start with `MATRIX` as a sign-in code, as MSC4108 codes do. */
  linkDeviceWithQr(accountId: string, qr: string): Observable<QrLinkUpdate> {
    return this.qrFlow<QrLinkUpdate>(
      `linkDeviceWithQr:${accountId}`,
      async (run) => {
        run.emit({ kind: 'connecting' });
        if (!this.accounts.has(accountId)) {
          run.end({ kind: 'failed', reason: 'unknown' });
          return;
        }
        if (!isSignInCode(qr)) {
          run.end({ kind: 'not-sign-in-code' });
          return;
        }
        const { match, identityHeld } = await run.pause<QrLinkAnswer>(
          'check-code',
          { kind: 'confirm-check-code', flowId: run.id, code: '42' },
        );
        if (!match) {
          run.end({ kind: 'failed', reason: 'insecure' });
          return;
        }
        if (!identityHeld) {
          run.end({ kind: 'failed', reason: 'unknown' });
          return;
        }
        run.emit({
          kind: 'approve-in-browser',
          verificationUri: this.qrPeer.verificationUri,
        });
        run.emit({ kind: 'sharing-secrets' });
        run.end({ kind: 'done' });
      },
    );
  }

  confirmQrLink(
    flowId: string,
    answer: QrLinkAnswer,
  ): Observable<EngineResult<null>> {
    return this.command(
      `confirmQrLink:${answer.match}:${answer.identityHeld}`,
      () => this.qrAnswer(flowId, 'check-code', answer),
    );
  }

  private qrFlow<U extends { kind: string }>(
    call: string,
    body: (run: FakeQrRun<U>) => Promise<void>,
  ): Observable<U> {
    return new Observable<U>((subscriber) => {
      this.calls.push(call);
      const run = new FakeQrRun(subscriber, this.qrStop);
      this.qrRuns.set(run.id, run);
      body(run).catch(() => undefined);
      return () => {
        this.qrRuns.delete(run.id);
        if (!run.ended) this.calls.push('qr-cancelled');
        run.ended = true;
      };
    });
  }

  private qrAnswer(
    flowId: string,
    pause: string,
    value: unknown,
  ): EngineResult<null> {
    return this.qrRuns.get(flowId)?.answer(pause, value)
      ? engineOk(null)
      : engineFail(QR_FLOW_GONE);
  }

  private session(localpart: string, deviceId: string | null): SignedInSession {
    const accessToken = `token-${localpart}-${this.accessTokens.size + 1}`;
    const owner = {
      userId: `@${localpart}:${this.serverName}`,
      deviceId: deviceId ?? `DEVICE${++this.devices}`,
    };
    this.accessTokens.set(accessToken, owner);
    return { ...owner, accessToken, refreshToken: null };
  }

  private confirmedEmail(auth: RegistrationAuth): boolean {
    const creds = auth['threepid_creds'] as
      { readonly sid?: string; readonly client_secret?: string } | undefined;
    const link = this.registrationLinks.get(creds?.sid ?? '');
    return !!link?.confirmed && link.clientSecret === creds?.client_secret;
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

function isSignInCode(qr: string): boolean {
  try {
    return atob(qr).startsWith('MATRIX');
  } catch {
    return false;
  }
}
