import { Injectable, inject, signal } from '@angular/core';
import { latestGuard, type LatestToken } from '@trinity/util/ui';
import {
  AuthType,
  InteractiveAuth,
  MatrixError,
  createClient,
  type AuthDict,
  type IAuthData,
  type IStageStatus,
  type MatrixClient,
  type RegisterRequest,
  type RegisterResponse,
} from 'matrix-js-sdk';
import {
  EMPTY,
  Observable,
  ReplaySubject,
  catchError,
  defer,
  finalize,
  from,
  map,
  of,
  switchMap,
  take,
  tap,
} from 'rxjs';
import {
  EMAIL_STAGE,
  NATIVE_REGISTRATION_STAGES,
  RegistrationSessionError,
  authenticatedRegistrationResponse,
  chooseRegistrationFlow,
  readRegistrationPolicies,
  readRegistrationUiaChallenge,
  registrationErrorMessage,
  registrationLocalpart,
  registrationProbeLocalpart,
  type RegistrationAvailability,
  type ExpectedRegistrationIdentity,
  type RegistrationStage,
  type RegistrationUiaData,
} from './registration-uia';
import {
  AccountRuntimeService,
  type AccountEstablishmentOutcome,
} from '@trinity/data-access/accounts';
import { accountEstablishment, type LoginMode } from './account-establishment';

export type {
  RegistrationAvailability,
  RegistrationPolicy,
  RegistrationStage,
} from './registration-uia';

const DEVICE_DISPLAY_NAME = 'Trinity';
type InitialRegistrationResult =
  | { kind: 'registered'; response: RegisterResponse }
  | { kind: 'uia'; data: RegistrationUiaData };

/**
 * Legacy Matrix registration with user-interactive authentication (UIA).
 *
 * The SDK owns request serialization, partial-401 repair, flow progress, dummy stages,
 * email secrets, and polling. This adapter keeps SDK types below the data-access boundary
 * and projects each stage into a small app-owned discriminated union for the UI.
 */
@Injectable({ providedIn: 'root' })
export class RegistrationService {
  private readonly accounts = inject(AccountRuntimeService);

  private readonly stageState = signal<RegistrationStage>({ kind: 'idle' });
  readonly stage = this.stageState.asReadonly();
  private readonly busyState = signal(false);
  readonly busy = this.busyState.asReadonly();
  private readonly errorState = signal<string | null>(null);
  readonly error = this.errorState.asReadonly();

  private readonly attempt = latestGuard();
  // Re-minted by cancel(), so the token that later steps read is always the live one.
  private token = this.attempt.next();
  private activeAuth?: InteractiveAuth<RegisterResponse>;
  private emailInput?: ReplaySubject<string>;
  private createdResponse?: RegisterResponse;
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
    return defer(() => {
      const client = createClient({ baseUrl });
      return from(client.isUsernameAvailable(registrationProbeLocalpart()));
    }).pipe(
      map(() => 'open' as const),
      catchError((error: unknown) =>
        of(
          error instanceof MatrixError && error.errcode === 'M_FORBIDDEN'
            ? ('closed' as const)
            : ('unknown' as const),
        ),
      ),
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
    const client = createClient({ baseUrl });
    const request: RegisterRequest = {
      username: localpart,
      password,
      refresh_token: true,
      inhibit_login: false,
      initial_device_display_name: DEVICE_DISPLAY_NAME,
    };

    const initial = defer(() =>
      from(this.withBusy(token, client.registerRequest(request))),
    ).pipe(
      map((response): InitialRegistrationResult => ({
        kind: 'registered',
        response,
      })),
      catchError((error: unknown) => {
        const data = readRegistrationUiaChallenge(error);
        return data
          ? of<InitialRegistrationResult>({ kind: 'uia', data })
          : (() => {
              throw error;
            })();
      }),
    );

    return initial.pipe(
      tap(() => this.ensureActive(token)),
      switchMap((result) =>
        result.kind === 'registered'
          ? this.establishCreated(token, result.response)
          : this.prepareInteractiveAuth(token, client, request, result.data),
      ),
      catchError((error: unknown) => this.handleFailure(token, error)),
    );
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
    return this.submitAuth({ type: AuthType.Terms });
  }

  /** Submit the stable or unstable registration-token stage currently being shown. */
  submitRegistrationToken(token: string): Observable<void> {
    const stage = this.stageState();
    if (stage.kind !== 'registration-token') return EMPTY;
    return this.submitAuth({ type: stage.authType, token: token.trim() });
  }

  /** Request another verification email using the SDK's incremented send attempt. */
  resendEmail(): Observable<void> {
    const auth = this.activeAuth;
    if (!auth || this.stageState().kind !== 'email-verification') return EMPTY;
    const token = this.token;
    return defer(() =>
      from(this.withBusy(token, auth.requestEmailToken())),
    ).pipe(
      tap(() => {
        this.ensureActive(token);
        this.stageState.set({ kind: 'email-verification', sent: true });
      }),
      map(() => void 0),
      catchError((error: unknown) => this.handleActionFailure(error)),
    );
  }

  /** User-triggered check after an email or hosted fallback step completes out-of-band. */
  poll(): Observable<void> {
    const auth = this.activeAuth;
    const stage = this.stageState();
    if (
      !auth ||
      (stage.kind !== 'email-verification' && stage.kind !== 'fallback')
    ) {
      return EMPTY;
    }
    const token = this.token;
    return defer(() => from(this.withBusy(token, auth.poll()))).pipe(
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
    this.activeAuth = undefined;
    this.createdResponse = undefined;
    this.activeBaseUrl = '';
    this.activeIdentity = undefined;
    this.busyState.set(false);
    this.errorState.set(null);
    this.stageState.set({ kind: 'idle' });
  }

  private prepareInteractiveAuth(
    token: LatestToken,
    client: MatrixClient,
    request: RegisterRequest,
    data: RegistrationUiaData,
  ): Observable<void> {
    const chosenFlow = chooseRegistrationFlow(data.flows);
    const selectedData: IAuthData = {
      ...data,
      flows: [{ stages: [...chosenFlow.stages] }],
      completed: [...(data.completed ?? [])],
      params: { ...(data.params ?? {}) },
    };
    const needsEmail =
      chosenFlow.stages.includes(EMAIL_STAGE) &&
      !(data.completed ?? []).includes(EMAIL_STAGE);

    const email = needsEmail
      ? (() => {
          this.stageState.set({ kind: 'email-address' });
          this.emailInput = new ReplaySubject<string>(1);
          return this.emailInput.pipe(take(1));
        })()
      : of('');

    return email.pipe(
      switchMap((emailAddress) =>
        this.runInteractiveAuth(
          token,
          client,
          request,
          selectedData,
          emailAddress,
        ),
      ),
    );
  }

  private runInteractiveAuth(
    token: LatestToken,
    client: MatrixClient,
    request: RegisterRequest,
    authData: IAuthData,
    emailAddress: string,
  ): Observable<void> {
    const interactiveAuth = new InteractiveAuth<RegisterResponse>({
      matrixClient: client,
      authData,
      inputs: emailAddress ? { emailAddress } : {},
      supportedStages: [...NATIVE_REGISTRATION_STAGES],
      doRequest: async (auth) => {
        this.ensureActive(token);
        const response = await client.registerRequest({
          ...request,
          ...(auth === null ? {} : { auth }),
        });
        this.ensureActive(token);
        return response;
      },
      requestEmailToken: (email, secret, attempt) =>
        client.requestRegisterEmailToken(email, secret, attempt),
      stateUpdated: (authType, status) => {
        if (!this.attempt.isCurrent(token)) return;
        this.renderStage(client, interactiveAuth, authType, status);
      },
      busyChanged: (busy) => {
        if (this.attempt.isCurrent(token)) this.busyState.set(busy);
      },
    });
    this.activeAuth = interactiveAuth;

    const attempt = async (): Promise<RegisterResponse> => {
      // Pre-seeding InteractiveAuth with the selected flow avoids an unsafe second
      // flow choice, but also skips its initial request hook. Request the email token
      // explicitly before starting so an email-first flow has a sid to poll with.
      if (emailAddress) {
        await this.withBusy(token, interactiveAuth.requestEmailToken());
      }
      this.ensureActive(token);
      return interactiveAuth.attemptAuth();
    };

    return defer(() => from(attempt())).pipe(
      tap(() => this.ensureActive(token)),
      switchMap((response) => this.establishCreated(token, response)),
    );
  }

  private submitAuth(auth: AuthDict): Observable<void> {
    const interactiveAuth = this.activeAuth;
    if (!interactiveAuth || this.busyState()) return EMPTY;
    return defer(() => from(interactiveAuth.submitAuthDict(auth))).pipe(
      map(() => void 0),
      catchError((error: unknown) => this.handleActionFailure(error)),
    );
  }

  private renderStage(
    client: MatrixClient,
    interactiveAuth: InteractiveAuth<RegisterResponse>,
    authType: string,
    status: IStageStatus,
  ): void {
    const message = status.error || undefined;
    if (authType === AuthType.Terms) {
      const policies = readRegistrationPolicies(
        interactiveAuth.getStageParams(authType),
      );
      if (policies.length > 0) {
        this.stageState.set({
          kind: 'terms',
          policies,
          ...(message ? { message } : {}),
        });
        return;
      }
    }
    if (
      authType === AuthType.RegistrationToken ||
      authType === AuthType.UnstableRegistrationToken
    ) {
      this.stageState.set({
        kind: 'registration-token',
        authType,
        ...(message ? { message } : {}),
      });
      return;
    }
    if (authType === EMAIL_STAGE) {
      this.stageState.set({
        kind: 'email-verification',
        sent: Boolean(status.emailSid || interactiveAuth.getEmailSid()),
        ...(message ? { message } : {}),
      });
      return;
    }

    const session = interactiveAuth.getSessionId();
    if (!session) {
      throw new Error(
        'The homeserver returned a registration stage without a UIA session.',
      );
    }
    this.stageState.set({
      kind: 'fallback',
      authType,
      url: client.getFallbackAuthUrl(authType, session),
      ...(message ? { message } : {}),
    });
  }

  private establishCreated(
    token: LatestToken,
    response: RegisterResponse,
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
        this.handleEstablishmentOutcome(outcome);
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
        userId: this.createdResponse.user_id,
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
  ): void {
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

class StaleRegistrationError extends Error {}
