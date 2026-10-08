import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  type WritableSignal,
} from '@angular/core';
import { FormField, disabled, form } from '@angular/forms/signals';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import {
  Observable,
  catchError,
  forkJoin,
  map,
  of,
  switchMap,
  take,
  throwError,
} from 'rxjs';
import {
  TrnButton,
  TrnFieldImports,
  TrnInput,
  TrnPasswordInputComponent,
} from '@trinity/components/controls';
import { TrnCardImports } from '@trinity/components/navigation-layout';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import {
  AuthService,
  AUTHENTICATION_HOMESERVER_DISCOVERY,
  OidcStateStore,
  RegistrationService,
  SignInRedirectService,
  type LoginMode,
  type AuthMetadata,
  type RegistrationAvailability,
} from '@trinity/data-access/auth';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import {
  AppRestartService,
  SessionStorageService,
} from '@trinity/platform-native';
import { TrnAlertService } from '@trinity/components/overlay';
import {
  HTTPError,
  MatrixError,
  describeMatrixRequestFailure,
} from '@trinity/util/matrix';
import { runWithBusy } from '@trinity/util/ui';
import {
  CLEAR_DATA_MISTYPED_MESSAGE,
  CLEAR_DATA_RESIDUE_WARNING,
  confirmClearDataIntent,
  installationResetFailureMessage,
} from './clear-all-data';
import { AuthCardComponent } from '../auth-card/auth-card.component';
import { accountEstablishmentError } from '../account-establishment-outcome';

const ACCOUNT_NOT_STORED = 'That account is no longer stored.';
const DISCOVERY_FALLBACK =
  "We couldn't find a homeserver at that address. Check it and try again.";
const SIGN_IN_FALLBACK = "We couldn't sign you in. Try again.";

/**
 * Plain-language text for a failed discovery or sign-in request. A 401/403 from the
 * login endpoint means the credentials were refused, not "no permission", so it is
 * mapped here rather than by the shared formatter. Anything unrecognised gets the
 * fallback: raw SDK messages carry status lines and request URLs.
 */
function describeSignInError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message === ACCOUNT_NOT_STORED) {
    return error.message;
  }
  if (
    error instanceof HTTPError &&
    (error.httpStatus === 401 ||
      error.httpStatus === 403 ||
      (error instanceof MatrixError && error.errcode === 'M_FORBIDDEN'))
  ) {
    return 'Incorrect username or password.';
  }
  return describeMatrixRequestFailure(error, fallback).message;
}

@Component({
  selector: 'trn-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'login.page.html',
  styleUrl: 'login.page.scss',
  imports: [
    AuthCardComponent,
    FormField,
    TrnButton,
    TrnCardImports,
    TrnFieldImports,
    TrnInput,
    TrnPasswordInputComponent,
    TrnSpinnerComponent,
  ],
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly discovery = inject(AUTHENTICATION_HOMESERVER_DISCOVERY);
  private readonly registration = inject(RegistrationService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly signInRedirect = inject(SignInRedirectService);
  private readonly oidcState = inject(OidcStateStore);
  private readonly storage = inject(SessionStorageService);
  private readonly alert = inject(TrnAlertService);
  private readonly accounts = inject(AccountRuntimeService);
  private readonly restart = inject(AppRestartService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly usernameInput =
    viewChild<ElementRef<HTMLInputElement>>('usernameInput');

  /** `/login?add` — add a second account instead of replacing the current one. */
  readonly addMode = this.route.snapshot.queryParamMap.has('add');
  /** `/login?reauth=<userId>` — re-authenticate a soft-logged-out account (add mode,
   * reusing its existing device so no re-verification is needed). */
  readonly reauthUserId = signal<string | null>(
    this.route.snapshot.queryParamMap.get('reauth'),
  );
  /** The device id to re-authenticate (from the stored record), when in re-auth mode. */
  private reauthDeviceId: string | null = null;

  /**
   * Accounts currently stored on this device, for the erase confirmation to name.
   * `/login?add` is reachable while accounts are live, and someone who came here to ADD an
   * account needs to be told what erasing would take with it.
   */
  private readonly storedUserIds = signal<readonly string[] | null>(null);

  constructor() {
    // Sweep an abandoned OIDC stash. `peek()` bins one that has outlived its TTL, and the
    // TTL is only ever enforced on read — so a login the user walked away from leaves a
    // PKCE code_verifier on disk until something reads it, and only the callback page
    // otherwise does. Landing on /login means no round-trip is completing here, so this is
    // the natural place. It cannot disturb a live login: a stash inside its TTL is left
    // untouched, including one started in another tab. Best-effort like every other
    // cleanup on this path: a storage read that rejects must not take the page down with
    // an unhandled rejection when nothing here depends on the answer.
    void this.oidcState.peek().catch(() => undefined);

    this.storage
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (records) => this.storedUserIds.set(records.map((r) => r.userId)),
        // Stays null on failure, which the confirmation renders as "any accounts signed in
        // will be signed out" rather than as silence. A registry too broken to read is
        // itself one of the states this button exists for, and silence there is
        // indistinguishable from "nothing is signed in".
        error: () => undefined,
      });

    const reauth = this.reauthUserId();
    if (reauth) {
      // Skip the homeserver step: load the stored record and discover its flows.
      this.credentials.update((current) => ({ ...current, username: reauth }));
      this.withBusy(
        this.storage.record(reauth).pipe(
          switchMap((record) => {
            if (!record) {
              return throwError(() => new Error(ACCOUNT_NOT_STORED));
            }
            this.reauthDeviceId = record.deviceId;
            this.baseUrl.set(record.baseUrl);
            return this.discoverCapabilities(record.baseUrl);
          }),
        ),
        this.error,
        DISCOVERY_FALLBACK,
      ).subscribe(({ flows, oidc, registration }) =>
        this.applyFlows(flows, oidc, registration),
      );
    }

    // The username/password step is inserted after homeserver discovery, so the
    // field's static `autofocus` is ignored (a document flushes autofocus once — on
    // the homeserver step). Move focus there programmatically when it appears.
    effect(() => {
      if (this.passwordSupported()) {
        afterNextRender(() => this.usernameInput()?.nativeElement.focus(), {
          injector: this.injector,
        });
      }
    });
  }

  /** Re-auth and add both keep the other accounts; a plain login replaces them. */
  private loginMode(): LoginMode {
    return this.addMode || this.reauthUserId() ? 'add' : 'replace';
  }

  // Resolved homeserver + capabilities after discovery.
  readonly baseUrl = signal<string | null>(null);
  readonly ssoSupported = signal(false);
  readonly passwordSupported = signal(false);
  readonly registrationAvailability =
    signal<RegistrationAvailability>('unknown');
  /** The delegated OIDC provider config, when the homeserver uses next-gen auth. */
  readonly oidcMetadata = signal<AuthMetadata | null>(null);
  readonly oidcSupported = computed(() => this.oidcMetadata() !== null);
  /** Whether the OIDC provider supports account creation (MSC2965 `prompt=create`). */
  readonly oidcRegistrationSupported = computed(
    () =>
      this.oidcMetadata()?.prompt_values_supported?.includes('create') ?? false,
  );

  readonly busy = signal(false);
  /** Page-level failures with no field to attach to (erase, re-auth loading). */
  readonly error = signal<string | null>(null);
  /** Why discovery failed, shown beside the homeserver field. */
  readonly homeserverError = signal<string | null>(null);
  /** Why sign-in failed, shown beside the password field. */
  readonly credentialsError = signal<string | null>(null);
  /**
   * The factory reset in flight, separate from {@link busy} on purpose.
   *
   * `busy` is the page-wide discovery/login flag, and the escape hatch must stay reachable
   * exactly when that is stuck — someone whose homeserver is unreachable sits in `busy` for
   * the whole HTTP timeout, and on `/login?reauth=` it is set from first paint.
   */
  readonly erasing = signal(false);

  // Form state. Two forms, not one, because the page is two steps: the homeserver is
  // resolved first, and the credentials step only exists once discovery reports a
  // password flow. Declared after `busy` because the schemas below read it.
  //
  // The disabled rules live in the schema rather than as [disabled] on the inputs:
  // Signal Forms owns a field's disabled state, and binding [disabled] on a [formField]
  // node is a compile error (NG8022).
  private readonly homeserverModel = signal({ homeserver: 'matrix.org' });
  readonly homeserverForm = form(this.homeserverModel, (path) => {
    disabled(path.homeserver, { when: () => this.busy() });
  });
  private readonly credentials = signal({ username: '', password: '' });
  readonly credentialsForm = form(this.credentials, (path) => {
    // In re-auth the account is fixed: the username is pre-filled and must stay put.
    disabled(path.username, {
      when: () => this.busy() || !!this.reauthUserId(),
    });
    disabled(path.password, { when: () => this.busy() });
  });

  /** Step 1: resolve the homeserver and discover its login flows (+ OIDC, in parallel). */
  discover(): void {
    this.withBusy(
      this.discovery
        .discover(this.homeserverModel().homeserver)
        .pipe(
          switchMap(({ baseUrl }) =>
            this.discoverCapabilities(baseUrl).pipe(
              map((res) => ({ baseUrl, ...res })),
            ),
          ),
        ),
      this.homeserverError,
      DISCOVERY_FALLBACK,
    ).subscribe(({ baseUrl, flows, oidc, registration }) => {
      this.baseUrl.set(baseUrl);
      this.applyFlows(flows, oidc, registration);
    });
  }

  /**
   * Discover the login flows and delegated OIDC config in parallel. A failing
   * `loginFlows()` must NOT hide an available OIDC provider (an OIDC-native homeserver
   * may not serve the legacy `/login` flows at all), so its error degrades to "no
   * flows" rather than aborting the whole discovery.
   */
  private discoverCapabilities(baseUrl: string): Observable<{
    flows: string[];
    oidc: AuthMetadata | null;
    registration: RegistrationAvailability;
  }> {
    return forkJoin({
      flows: this.auth
        .getSupportedFlows(baseUrl)
        .pipe(catchError(() => of<string[]>([]))),
      oidc: this.auth.getDelegatedAuthConfig(baseUrl),
    }).pipe(
      switchMap(({ flows, oidc }) => {
        // Delegated OIDC owns registration, while add/reauth gating is handled by the
        // template. Only a legacy password homeserver needs the extra availability GET.
        if (oidc || !flows.includes('m.login.password')) {
          return of({ flows, oidc, registration: 'unknown' as const });
        }
        return this.registration
          .getAvailability(baseUrl)
          .pipe(map((registration) => ({ flows, oidc, registration })));
      }),
    );
  }

  /**
   * Apply the discovered capabilities. An OIDC-native homeserver owns credentials at the
   * provider, so prefer its "Continue" button and suppress the legacy password/SSO ones
   * (a homeserver mid-migration may still advertise m.login.sso for compatibility).
   */
  private applyFlows(
    flows: string[],
    oidc: AuthMetadata | null,
    registration: RegistrationAvailability = 'unknown',
  ): void {
    this.oidcMetadata.set(oidc);
    this.registrationAvailability.set(registration);
    this.passwordSupported.set(!oidc && flows.includes('m.login.password'));
    this.ssoSupported.set(!oidc && flows.includes('m.login.sso'));
    // No OIDC, password, or SSO flow — surface a clear message instead of leaving the
    // user on a blank card with no sign-in control and no explanation.
    if (!oidc && !this.passwordSupported() && !this.ssoSupported()) {
      this.error.set(
        "This homeserver doesn't offer a sign-in method Trinity supports.",
      );
    }
  }

  /** Continue from the shared homeserver step into legacy Matrix registration. */
  startRegistration(): void {
    if (this.registrationAvailability() !== 'open' || this.reauthUserId()) {
      return;
    }
    void this.router.navigate(['/register'], {
      queryParams: {
        homeserver: this.homeserverModel().homeserver,
        ...(this.addMode ? { add: '' } : {}),
      },
    });
  }

  /** Step 2a: password login. */
  loginPassword(): void {
    const baseUrl = this.baseUrl();
    if (!baseUrl) return;
    this.withBusy(
      this.auth.loginWithPassword(
        baseUrl,
        this.credentials().username,
        this.credentials().password,
        this.loginMode(),
        this.reauthDeviceId ?? undefined,
      ),
      this.credentialsError,
      SIGN_IN_FALLBACK,
    ).subscribe((outcome) => {
      const error = accountEstablishmentError(outcome);
      if (error) {
        this.credentialsError.set(error);
        return;
      }
      void this.router.navigateByUrl('/rooms', { replaceUrl: true });
    });
  }

  /** Abandon adding an account and return to the app. */
  cancelAdd(): void {
    void this.router.navigateByUrl('/rooms');
  }

  /** Step 2b: SSO — hand off to the homeserver's SSO page. */
  startSso(): void {
    const baseUrl = this.baseUrl();
    if (!baseUrl) return;
    this.withBusy(
      this.signInRedirect.startSso(
        baseUrl,
        this.loginMode(),
        this.reauthDeviceId ?? undefined,
      ),
      this.error,
      SIGN_IN_FALLBACK,
    ).subscribe();
  }

  /**
   * Step 2c: OIDC ("next-gen auth") — hand off to the provider's authorization page.
   * Pass `prompt` (`'create'`) to send the user to the provider's registration flow
   * instead of login.
   */
  startOidc(prompt?: string): void {
    const baseUrl = this.baseUrl();
    const metadata = this.oidcMetadata();
    if (!baseUrl || !metadata?.issuer) {
      return;
    }
    this.withBusy(
      this.signInRedirect.startOidc({
        baseUrl,
        metadata,
        mode: this.loginMode(),
        ...(prompt ? { prompt } : {}),
        // Re-auth reuses the stored device so the account comes back without needing a
        // fresh verification, and the callback must see this same account return.
        ...(this.reauthDeviceId ? { deviceId: this.reauthDeviceId } : {}),
        expectedUserId: this.reauthUserId(),
      }),
      this.error,
      SIGN_IN_FALLBACK,
    ).subscribe();
  }

  /**
   * Erase everything Trinity has stored on this device, then restart into a clean app.
   *
   * The way out of a wedged install, which is why it lives on the login page: Settings is
   * behind `authGuard`, and the whole point is to be reachable when you cannot sign in.
   *
   * Deliberately NOT wrapped in `withBusy`. `runWithBusy` turns a failure into `EMPTY`, so
   * its `next` never runs — here that would mean silently not restarting, leaving the user
   * looking at an app whose data is already gone. Busy and error are set by hand instead.
   */
  clearAllData(): void {
    confirmClearDataIntent(this.alert, this.storedUserIds())
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe((intent) => {
        if (intent === 'cancelled') {
          return; // they stopped it themselves; saying anything would be nagging
        }
        if (intent === 'mistyped') {
          this.error.set(CLEAR_DATA_MISTYPED_MESSAGE);
          return;
        }

        this.beginInstallationReset();
      });
  }

  private beginInstallationReset(): void {
    this.error.set(null);
    this.erasing.set(true);
    // Account Runtime owns the accepted attempt. This observer may detach with the page;
    // cleanup continues and a reopened surface joins or observes the same attempt.
    this.accounts
      .resetInstallation()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => {
        if (outcome.kind === 'partial-cleanup') {
          console.warn(
            CLEAR_DATA_RESIDUE_WARNING,
            outcome.issues.map((issue) => ({
              scope: issue.scope,
              recovery: issue.recovery,
            })),
          );
        }
        const failure = installationResetFailureMessage(outcome);
        if (failure === null) {
          // `erasing` stays true: the app is about to be replaced, and releasing the button
          // now would let a second press race the navigation.
          this.restart.restart();
          return;
        }
        this.erasing.set(false);
        this.error.set(failure);
      });
  }

  /** Wrap a one-shot action with shared busy/error handling. */
  private withBusy<T>(
    source: Observable<T>,
    error: WritableSignal<string | null>,
    fallback: string,
  ): Observable<T> {
    return runWithBusy(
      source,
      { busy: this.busy, error, destroyRef: this.destroyRef },
      { formatError: (err) => describeSignInError(err, fallback) },
    );
  }
}
