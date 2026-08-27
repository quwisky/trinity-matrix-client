import { Injectable, inject, signal } from '@angular/core';
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
  type RegistrationAvailability,
  type RegistrationStage,
  type RegistrationUiaData,
} from './registration-uia';
import {
  SessionEstablishmentService,
  type LoginMode,
} from './session-establishment.service';

export type {
  RegistrationAvailability,
  RegistrationPolicy,
  RegistrationStage,
} from './registration-uia';

const DEVICE_DISPLAY_NAME = 'Trinity';
const REGISTRATION_PROBE_PREFIX = 'trinity_registration_probe_';
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
  private readonly sessions = inject(SessionEstablishmentService);

  private readonly stageState = signal<RegistrationStage>({ kind: 'idle' });
  readonly stage = this.stageState.asReadonly();
  private readonly busyState = signal(false);
  readonly busy = this.busyState.asReadonly();
  private readonly errorState = signal<string | null>(null);
  readonly error = this.errorState.asReadonly();

  private generation = 0;
  private activeAuth?: InteractiveAuth<RegisterResponse>;
  private emailInput?: ReplaySubject<string>;
  private createdResponse?: RegisterResponse;
  private activeBaseUrl = '';
  private activeMode: LoginMode = 'replace';

  /**
   * Probe the side-effect-free username-availability endpoint. A 200 response means
   * registration is open even if the random probe name happens to be occupied; a
   * definitive M_FORBIDDEN means closed, and unsupported/network failures fail closed
   * as `unknown` so the login page never advertises a dead action.
   */
  getAvailability(baseUrl: string): Observable<RegistrationAvailability> {
    return defer(() => {
      const client = createClient({ baseUrl });
      return from(client.isUsernameAvailable(this.probeLocalpart()));
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
    mode: LoginMode = 'replace',
  ): Observable<void> {
    const generation = this.beginGeneration(baseUrl, mode);
    const client = createClient({ baseUrl });
    const request: RegisterRequest = {
      username: this.localpart(username),
      password,
      refresh_token: true,
      inhibit_login: false,
      initial_device_display_name: DEVICE_DISPLAY_NAME,
    };

    const initial = defer(() =>
      from(this.withBusy(generation, client.registerRequest(request))),
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
      tap(() => this.ensureActive(generation)),
      switchMap((result) =>
        result.kind === 'registered'
          ? this.establishCreated(generation, result.response)
          : this.prepareInteractiveAuth(
              generation,
              client,
              request,
              result.data,
            ),
      ),
      catchError((error: unknown) => this.handleFailure(generation, error)),
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
    const generation = this.generation;
    return defer(() =>
      from(this.withBusy(generation, auth.requestEmailToken())),
    ).pipe(
      tap(() => {
        this.ensureActive(generation);
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
    const generation = this.generation;
    return defer(() => from(this.withBusy(generation, auth.poll()))).pipe(
      map(() => void 0),
      catchError((error: unknown) => this.handleActionFailure(error)),
    );
  }

  /** Retry only local persistence/client initialization after the server created the account. */
  retryEstablishment(): Observable<void> {
    const response = this.createdResponse;
    if (!response || this.stageState().kind !== 'session-error') return EMPTY;
    const generation = this.generation;
    this.errorState.set(null);
    return this.establishCreated(generation, response).pipe(
      catchError((error: unknown) => this.handleFailure(generation, error)),
    );
  }

  /** Invalidate callbacks from the current route and discard unpersisted UIA state. */
  cancel(): void {
    this.generation += 1;
    this.emailInput?.complete();
    this.emailInput = undefined;
    this.activeAuth = undefined;
    this.createdResponse = undefined;
    this.activeBaseUrl = '';
    this.busyState.set(false);
    this.errorState.set(null);
    this.stageState.set({ kind: 'idle' });
  }

  private prepareInteractiveAuth(
    generation: number,
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
          generation,
          client,
          request,
          selectedData,
          emailAddress,
        ),
      ),
    );
  }

  private runInteractiveAuth(
    generation: number,
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
        this.ensureActive(generation);
        const response = await client.registerRequest({
          ...request,
          ...(auth === null ? {} : { auth }),
        });
        this.ensureActive(generation);
        return response;
      },
      requestEmailToken: (email, secret, attempt) =>
        client.requestRegisterEmailToken(email, secret, attempt),
      stateUpdated: (authType, status) => {
        if (generation !== this.generation) return;
        this.renderStage(client, interactiveAuth, authType, status);
      },
      busyChanged: (busy) => {
        if (generation === this.generation) this.busyState.set(busy);
      },
    });
    this.activeAuth = interactiveAuth;

    const attempt = async (): Promise<RegisterResponse> => {
      // Pre-seeding InteractiveAuth with the selected flow avoids an unsafe second
      // flow choice, but also skips its initial request hook. Request the email token
      // explicitly before starting so an email-first flow has a sid to poll with.
      if (emailAddress) {
        await this.withBusy(generation, interactiveAuth.requestEmailToken());
      }
      this.ensureActive(generation);
      return interactiveAuth.attemptAuth();
    };

    return defer(() => from(attempt())).pipe(
      tap(() => this.ensureActive(generation)),
      switchMap((response) => this.establishCreated(generation, response)),
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
    generation: number,
    response: RegisterResponse,
  ): Observable<void> {
    this.ensureActive(generation);
    this.createdResponse = response;
    const session = authenticatedRegistrationResponse(response);
    return defer(() => {
      this.ensureActive(generation);
      this.busyState.set(true);
      return this.sessions.establish(
        this.activeBaseUrl,
        session,
        this.activeMode,
      );
    }).pipe(
      tap(() => this.ensureActive(generation)),
      finalize(() => {
        if (generation === this.generation) this.busyState.set(false);
      }),
    );
  }

  private beginGeneration(baseUrl: string, mode: LoginMode): number {
    this.cancel();
    this.activeBaseUrl = baseUrl;
    this.activeMode = mode;
    this.stageState.set({ kind: 'credentials' });
    return this.generation;
  }

  private handleFailure(generation: number, error: unknown): Observable<never> {
    if (
      generation !== this.generation ||
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
        'Your account was created, but Trinity could not finish signing in. ' +
          (retryable
            ? 'Retry local setup or sign in normally.'
            : 'Sign in normally to continue.'),
      );
      return EMPTY;
    }
    this.stageState.set({ kind: 'credentials' });
    this.errorState.set(this.errorMessage(error));
    return EMPTY;
  }

  private handleActionFailure(error: unknown): Observable<never> {
    this.errorState.set(this.errorMessage(error));
    return EMPTY;
  }

  private errorMessage(error: unknown): string {
    if (error instanceof MatrixError) {
      return error.error || 'The homeserver rejected this registration step.';
    }
    return error instanceof Error ? error.message : 'Registration failed.';
  }

  private async withBusy<T>(
    generation: number,
    promise: Promise<T>,
  ): Promise<T> {
    this.ensureActive(generation);
    this.busyState.set(true);
    try {
      const result = await promise;
      this.ensureActive(generation);
      return result;
    } finally {
      if (generation === this.generation) this.busyState.set(false);
    }
  }

  private ensureActive(generation: number): void {
    if (generation !== this.generation) throw new StaleRegistrationError();
  }

  private probeLocalpart(): string {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return (
      REGISTRATION_PROBE_PREFIX +
      Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
    );
  }

  private localpart(username: string): string {
    const trimmed = username.trim().replace(/^@/, '');
    const colon = trimmed.indexOf(':');
    return colon >= 0 ? trimmed.slice(0, colon) : trimmed;
  }
}

class StaleRegistrationError extends Error {}
