import { Injectable, inject, signal } from '@angular/core';
import { latestGuard, type LatestToken } from '@trinity/util/ui';
import {
  EMPTY,
  Observable,
  ReplaySubject,
  catchError,
  defer,
  finalize,
  firstValueFrom,
  from,
  map,
  of,
  switchMap,
  take,
  tap,
} from 'rxjs';
import {
  EngineRequestError,
  uiaFallbackUrl,
  unwrapEngineResult,
  type EngineResult,
  type UiaChallenge,
} from '@trinity/util/matrix';
import {
  DUMMY_STAGE,
  EMAIL_STAGE,
  REGISTRATION_TOKEN_STAGES,
  RegistrationSessionError,
  TERMS_STAGE,
  authenticatedRegistrationResponse,
  chooseRegistrationFlow,
  readRegistrationPolicies,
  readRegistrationUiaChallenge,
  registrationErrorMessage,
  registrationLocalpart,
  registrationProbeLocalpart,
  serverMessageOf,
  type RegistrationAvailability,
  type ExpectedRegistrationIdentity,
  type RegistrationStage,
} from './registration-uia';
import {
  AccountRuntimeService,
  type AccountEstablishmentOutcome,
} from '@trinity/data-access/accounts';
import { SESSION_ENGINE } from '@trinity/data-access/matrix-client';
import {
  accountEstablishment,
  type AuthenticatedSessionResponse,
  type LoginMode,
} from './account-establishment';
import { HostAuthenticationHandoffService } from '@trinity/runtime/host';
import type {
  RegisteredAccount,
  Registration,
  RegistrationAuth,
} from './auth-engine';
import { AUTH_ENGINE } from './auth-engine.token';
import { newClientSecret } from './password-reset.workflow';

export type {
  RegistrationAvailability,
  RegistrationPolicy,
  RegistrationStage,
} from './registration-uia';

/** One attempt's user-interactive auth: the chosen flow and the server's latest answer. */
interface RegistrationUia {
  readonly registration: Registration;
  /** Chosen from the first challenge; later challenges only report progress on it. */
  readonly flow: readonly string[];
  challenge: UiaChallenge;
  /** The stage shown or submitted last, and the server's text on it. */
  stage: string;
  message: string | undefined;
  readonly email: string;
  readonly clientSecret: string;
  emailSid: string | undefined;
  emailAttempt: number;
  submitting: boolean;
  ended: boolean;
  /** Emits the created account once, or errors with the failure that ended the attempt. */
  readonly created: ReplaySubject<RegisteredAccount>;
}

/** A stage's own `auth` fields; the UIA session is added when sent. */
type StageAuth = Readonly<Record<string, unknown>>;

/**
 * Legacy Matrix registration with user-interactive authentication (UIA).
 *
 * The engine sends each request; this service chooses one flow from the first challenge
 * and walks its stages: the dummy stage is submitted on its own, the email stage after
 * the explicit first token request, the terms and token stages when the person answers,
 * and any other stage through the homeserver's fallback page. Each stage is projected
 * into a small app-owned discriminated union for the UI.
 */
@Injectable({ providedIn: 'root' })
export class RegistrationService {
  private readonly accounts = inject(AccountRuntimeService);
  private readonly handoff = inject(HostAuthenticationHandoffService);
  private readonly engine = inject(AUTH_ENGINE);
  private readonly sessionEngine = inject(SESSION_ENGINE);

  private readonly stageState = signal<RegistrationStage>({ kind: 'idle' });
  readonly stage = this.stageState.asReadonly();
  private readonly busyState = signal(false);
  readonly busy = this.busyState.asReadonly();
  private readonly errorState = signal<string | null>(null);
  readonly error = this.errorState.asReadonly();

  private readonly attempt = latestGuard();
  // Re-minted by cancel(), so the token that later steps read is always the live one.
  private token = this.attempt.next();
  private activeUia?: RegistrationUia;
  private emailInput?: ReplaySubject<string>;
  private createdResponse?: RegisteredAccount;
  private activeBaseUrl = '';
  private activeMode: LoginMode = 'replace';
  private activeIdentity?: ExpectedRegistrationIdentity;

  /**
   * Probe the side-effect-free username-availability endpoint. A 200 response means
   * registration is open even if the random probe name happens to be occupied; a
   * definitive M_FORBIDDEN means closed, and unsupported/network failures fail closed
   * as `unknown` so the login page never advertises a dead action.
   */
  getAvailability(baseUrl: string): Observable<RegistrationAvailability> {
    return defer(() =>
      this.engine.usernameAvailable(baseUrl, registrationProbeLocalpart()),
    ).pipe(
      map((result): RegistrationAvailability => {
        if (result.ok) return 'open';
        return result.failure.code === 'forbidden' ? 'closed' : 'unknown';
      }),
      catchError(() => of('unknown' as const)),
    );
  }

  /** Start one account-creation attempt. Emits only after local session setup succeeds. */
  begin(
    baseUrl: string,
    username: string,
    password: string,
    expectedServerName: string,
    mode: LoginMode = 'replace',
  ): Observable<void> {
    const localpart = registrationLocalpart(username);
    const token = this.beginGeneration(baseUrl, mode, {
      localpart,
      serverName: expectedServerName,
    });

    // The request is built on subscription: naming the device can fail on a broken
    // desktop shell, and that failure must reach handleFailure like any other.
    return defer(() => {
      const registration: Registration = {
        localpart,
        password,
        deviceDisplayName: this.handoff.deviceDisplayName(),
      };
      return defer(() =>
        from(this.withBusy(token, this.register(registration, null))),
      ).pipe(
        tap(() => this.ensureActive(token)),
        switchMap((result) => {
          if (result.ok) return this.establishCreated(token, result.value);
          const { failure } = result;
          if (failure.code !== 'uia-required') {
            throw new EngineRequestError(failure);
          }
          return this.prepareInteractiveAuth(
            token,
            registration,
            readRegistrationUiaChallenge(failure.params.challenge),
            failure.params.serverMessage,
          );
        }),
      );
    }).pipe(catchError((error: unknown) => this.handleFailure(token, error)));
  }

  /** Supply the email address after the chosen server flow reveals that it needs one. */
  provideEmail(email: string): void {
    if (this.stageState().kind !== 'email-address') return;
    this.errorState.set(null);
    this.emailInput?.next(email.trim());
    this.emailInput?.complete();
  }

  /** Accept the server-provided terms stage after the user has opened and read its links. */
  acceptTerms(): Observable<void> {
    if (this.stageState().kind !== 'terms') return EMPTY;
    return this.submitAuth({ type: TERMS_STAGE });
  }

  /** Submit the stable or unstable registration-token stage currently being shown. */
  submitRegistrationToken(token: string): Observable<void> {
    const stage = this.stageState();
    if (stage.kind !== 'registration-token') return EMPTY;
    return this.submitAuth({ type: stage.authType, token: token.trim() });
  }

  /** Request another verification email with the next send attempt. */
  resendEmail(): Observable<void> {
    const uia = this.activeUia;
    if (!uia || this.stageState().kind !== 'email-verification') return EMPTY;
    const token = this.token;
    return defer(() =>
      from(this.withBusy(token, this.requestEmailToken(uia))),
    ).pipe(
      tap(() => {
        this.ensureActive(token);
        this.stageState.set({ kind: 'email-verification', sent: true });
      }),
      map(() => void 0),
      catchError((error: unknown) => this.handleActionFailure(error)),
    );
  }

  /**
   * User-triggered check after an email or hosted fallback step completes out-of-band. The
   * stage is submitted again in the background, where a failure changes nothing.
   */
  poll(): Observable<void> {
    const uia = this.activeUia;
    const stage = this.stageState();
    if (
      !uia ||
      (stage.kind !== 'email-verification' && stage.kind !== 'fallback')
    ) {
      return EMPTY;
    }
    const token = this.token;
    return defer(() =>
      from(this.withBusy(token, this.startPoll(token, uia))),
    ).pipe(
      map(() => void 0),
      catchError((error: unknown) => this.handleActionFailure(error)),
    );
  }

  /** Retry only local persistence/client initialization after the server created the account. */
  retryEstablishment(): Observable<void> {
    const response = this.createdResponse;
    if (!response || this.stageState().kind !== 'session-error') return EMPTY;
    const token = this.token;
    this.errorState.set(null);
    return this.establishCreated(token, response).pipe(
      catchError((error: unknown) => this.handleFailure(token, error)),
    );
  }

  /** Invalidate callbacks from the current route and discard unpersisted UIA state. */
  cancel(): void {
    this.token = this.attempt.next();
    this.emailInput?.complete();
    this.emailInput = undefined;
    this.activeUia = undefined;
    this.createdResponse = undefined;
    this.activeBaseUrl = '';
    this.activeIdentity = undefined;
    this.busyState.set(false);
    this.errorState.set(null);
    this.stageState.set({ kind: 'idle' });
  }

  private prepareInteractiveAuth(
    token: LatestToken,
    registration: Registration,
    challenge: UiaChallenge,
    message: string | undefined,
  ): Observable<void> {
    const flow = chooseRegistrationFlow(challenge.flows);
    const needsEmail =
      flow.includes(EMAIL_STAGE) &&
      !(challenge.completed ?? []).includes(EMAIL_STAGE);

    const email = needsEmail
      ? (() => {
          this.stageState.set({ kind: 'email-address' });
          this.emailInput = new ReplaySubject<string>(1);
          return this.emailInput.pipe(take(1));
        })()
      : of('');

    return email.pipe(
      switchMap((emailAddress) => {
        const uia: RegistrationUia = {
          registration,
          flow,
          challenge,
          stage: '',
          message,
          email: emailAddress,
          clientSecret: newClientSecret(),
          emailSid: undefined,
          emailAttempt: 1,
          submitting: false,
          ended: false,
          created: new ReplaySubject<RegisteredAccount>(1),
        };
        this.activeUia = uia;
        return this.runInteractiveAuth(token, uia);
      }),
    );
  }

  private runInteractiveAuth(
    token: LatestToken,
    uia: RegistrationUia,
  ): Observable<void> {
    return defer(async () => {
      // The flow is already chosen, so the email goes out before the first stage: an
      // email-first flow needs a sid to poll with.
      if (uia.email) {
        await this.withBusy(token, this.requestEmailToken(uia));
      }
      this.ensureActive(token);
      this.advance(token, uia, uia.message);
    }).pipe(
      switchMap(() => uia.created),
      take(1),
      tap(() => this.ensureActive(token)),
      switchMap((response) => this.establishCreated(token, response)),
    );
  }

  /** Move to the chosen flow's first stage not completed yet. */
  private advance(
    token: LatestToken,
    uia: RegistrationUia,
    message: string | undefined,
  ): void {
    const completed = uia.challenge.completed ?? [];
    const stage = uia.flow.find((name) => !completed.includes(name));
    if (!stage) {
      throw new Error('No incomplete flows from the server');
    }
    uia.stage = stage;
    uia.message = message;
    if (stage === DUMMY_STAGE) {
      this.submit(token, uia, { type: DUMMY_STAGE }, false).subscribe();
      return;
    }
    if (this.attempt.isCurrent(token)) this.renderStage(uia, stage, message);
  }

  /**
   * Send the registration again with a stage's answer. The answer moves the attempt on;
   * in the background (a poll) a failure is ignored and the stage stays as it is.
   */
  private submit(
    token: LatestToken,
    uia: RegistrationUia,
    stageAuth: StageAuth,
    background: boolean,
  ): Observable<void> {
    return defer(async () => {
      const { session } = uia.challenge;
      let result: EngineResult<RegisteredAccount>;
      if (!background && this.attempt.isCurrent(token)) {
        this.busyState.set(true);
      }
      uia.submitting = true;
      try {
        result = await this.register(uia.registration, {
          ...(session ? { session } : {}),
          ...stageAuth,
        });
        this.ensureActive(token);
      } catch (error: unknown) {
        if (!background) this.end(uia, { error });
        return;
      } finally {
        uia.submitting = false;
        if (!background && this.attempt.isCurrent(token)) {
          this.busyState.set(false);
        }
      }
      this.answer(token, uia, result, background);
    });
  }

  private answer(
    token: LatestToken,
    uia: RegistrationUia,
    result: EngineResult<RegisteredAccount>,
    background: boolean,
  ): void {
    if (result.ok) {
      this.end(uia, { account: result.value });
      return;
    }
    const { failure } = result;
    if (failure.code === 'uia-required') {
      uia.challenge = progressOf(uia.challenge, failure.params.challenge);
    } else if (!background) {
      this.end(uia, { error: new EngineRequestError(failure) });
      return;
    }
    const message =
      failure.code === 'uia-required'
        ? failure.params.serverMessage
        : (serverMessageOf(failure) ?? uia.message);
    try {
      this.advance(token, uia, message);
    } catch (error: unknown) {
      this.end(uia, { error });
    }
  }

  private end(
    uia: RegistrationUia,
    outcome:
      { readonly account: RegisteredAccount } | { readonly error: unknown },
  ): void {
    if (uia.ended) return;
    uia.ended = true;
    if ('account' in outcome) uia.created.next(outcome.account);
    else uia.created.error(outcome.error);
  }

  /** Submit the current stage in the background unless a request is already out. */
  private async startPoll(
    token: LatestToken,
    uia: RegistrationUia,
  ): Promise<void> {
    if (!uia.challenge.session || uia.submitting || uia.ended) return;
    const auth: StageAuth =
      uia.stage === EMAIL_STAGE && uia.emailSid
        ? {
            type: EMAIL_STAGE,
            threepid_creds: {
              sid: uia.emailSid,
              client_secret: uia.clientSecret,
            },
          }
        : {};
    this.submit(token, uia, auth, true).subscribe();
  }

  private async requestEmailToken(uia: RegistrationUia): Promise<void> {
    const { sid } = await firstValueFrom(
      this.engine
        .requestRegistrationEmailToken(this.activeBaseUrl, {
          email: uia.email,
          clientSecret: uia.clientSecret,
          sendAttempt: uia.emailAttempt++,
        })
        .pipe(unwrapEngineResult()),
    );
    uia.emailSid = sid;
  }

  private register(
    registration: Registration,
    auth: RegistrationAuth | null,
  ): Promise<EngineResult<RegisteredAccount>> {
    return firstValueFrom(
      this.engine.register(this.activeBaseUrl, registration, auth),
    );
  }

  private submitAuth(stageAuth: StageAuth): Observable<void> {
    const uia = this.activeUia;
    if (!uia || this.busyState()) return EMPTY;
    return this.submit(this.token, uia, stageAuth, false);
  }

  private renderStage(
    uia: RegistrationUia,
    stage: string,
    message: string | undefined,
  ): void {
    const text = message ? { message } : {};
    if (stage === TERMS_STAGE) {
      const policies = readRegistrationPolicies(
        uia.challenge.params?.[TERMS_STAGE],
      );
      if (policies.length > 0) {
        this.stageState.set({ kind: 'terms', policies, ...text });
        return;
      }
    }
    if (REGISTRATION_TOKEN_STAGES.has(stage)) {
      this.stageState.set({
        kind: 'registration-token',
        authType: stage,
        ...text,
      });
      return;
    }
    if (stage === EMAIL_STAGE) {
      this.stageState.set({
        kind: 'email-verification',
        sent: Boolean(uia.emailSid),
        ...text,
      });
      return;
    }

    const { session } = uia.challenge;
    if (!session) {
      throw new Error(
        'The homeserver returned a registration stage without a UIA session.',
      );
    }
    this.stageState.set({
      kind: 'fallback',
      authType: stage,
      url: uiaFallbackUrl(this.activeBaseUrl, stage, session),
      ...text,
    });
  }

  private establishCreated(
    token: LatestToken,
    response: RegisteredAccount,
  ): Observable<void> {
    this.ensureActive(token);
    this.createdResponse = response;
    const identity = this.activeIdentity;
    if (!identity) throw new StaleRegistrationError();
    const session = authenticatedRegistrationResponse(response, identity);
    return defer(() => {
      this.ensureActive(token);
      this.busyState.set(true);
      const command = accountEstablishment(
        this.activeBaseUrl,
        session,
        this.activeMode,
        'new',
      );
      return this.accounts.establishAuthenticatedAccount(
        command.grant,
        command.intent,
      );
    }).pipe(
      switchMap((outcome) => {
        this.ensureActive(token);
        if (outcome.kind === 'ready') return of(void 0);
        this.handleEstablishmentOutcome(outcome, session);
        return EMPTY;
      }),
      finalize(() => {
        if (this.attempt.isCurrent(token)) this.busyState.set(false);
      }),
    );
  }

  private beginGeneration(
    baseUrl: string,
    mode: LoginMode,
    identity: ExpectedRegistrationIdentity,
  ): LatestToken {
    this.cancel();
    this.activeBaseUrl = baseUrl;
    this.activeMode = mode;
    this.activeIdentity = identity;
    this.stageState.set({ kind: 'credentials' });
    return this.token;
  }

  private handleFailure(token: LatestToken, error: unknown): Observable<never> {
    if (
      !this.attempt.isCurrent(token) ||
      error instanceof StaleRegistrationError
    ) {
      return EMPTY;
    }
    this.busyState.set(false);
    if (this.createdResponse) {
      const retryable =
        !(error instanceof RegistrationSessionError) || error.retryable;
      this.stageState.set({
        kind: 'session-error',
        userId: this.createdResponse.userId,
        retryable,
      });
      this.errorState.set(
        !retryable
          ? `${this.nonretryableSessionMessage(error)} No local account data was changed.`
          : 'Your account was created, but Trinity could not finish signing in. ' +
              'Retry local setup or sign in normally.',
      );
      return EMPTY;
    }
    this.stageState.set({ kind: 'credentials' });
    this.errorState.set(registrationErrorMessage(error));
    return EMPTY;
  }

  private handleActionFailure(error: unknown): Observable<never> {
    this.errorState.set(registrationErrorMessage(error));
    return EMPTY;
  }

  private nonretryableSessionMessage(error: unknown): string {
    if (error instanceof RegistrationSessionError) return error.message;
    return 'Trinity could not safely establish this registration session.';
  }

  private handleEstablishmentOutcome(
    outcome: Exclude<AccountEstablishmentOutcome, { kind: 'ready' }>,
    session: AuthenticatedSessionResponse,
  ): void {
    if (
      outcome.kind === 'failed' &&
      outcome.failure === 'unprotected-storage-declined'
    ) {
      // Nothing will use the created session, so hand it back as a declined sign-in does:
      // detached and best-effort.
      this.createdResponse = undefined;
      this.sessionEngine
        .logoutSession({
          baseUrl: this.activeBaseUrl,
          userId: session.user_id,
          deviceId: session.device_id,
          accessToken: session.access_token,
        })
        .subscribe({ error: () => undefined });
      this.stageState.set({
        kind: 'session-error',
        userId: outcome.accountId,
        retryable: false,
      });
      this.errorState.set(
        'Your account was created, but nothing was stored on this device. Sign in when you’re ready.',
      );
      return;
    }
    const retryable =
      outcome.kind !== 'failed' || outcome.failure !== 'account-already-stored';
    this.stageState.set({
      kind: 'session-error',
      userId: outcome.accountId,
      retryable,
    });
    this.errorState.set(
      retryable
        ? 'Your account was created, but Trinity could not finish signing in. ' +
            'Retry local setup or sign in normally.'
        : 'Trinity refused to replace an account already stored on this device. ' +
            'No local account data was changed.',
    );
  }

  private async withBusy<T>(
    token: LatestToken,
    promise: Promise<T>,
  ): Promise<T> {
    this.ensureActive(token);
    this.busyState.set(true);
    try {
      const result = await promise;
      this.ensureActive(token);
      return result;
    } finally {
      if (this.attempt.isCurrent(token)) this.busyState.set(false);
    }
  }

  private ensureActive(token: LatestToken): void {
    if (!this.attempt.isCurrent(token)) throw new StaleRegistrationError();
  }
}

/**
 * InteractiveAuth's repair: a challenge naming no flows, progress or session continues the
 * last one (Synapse has answered a poll that way).
 */
function progressOf(previous: UiaChallenge, next: UiaChallenge): UiaChallenge {
  return next.flows.length > 0 ||
    (next.completed ?? []).length > 0 ||
    next.session
    ? next
    : { ...previous, params: next.params };
}

class StaleRegistrationError extends Error {}
