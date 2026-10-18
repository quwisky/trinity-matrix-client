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
  type Signal,
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
  ReauthAccountMismatchError,
  UnacceptableAccountError,
  AuthService,
  AUTHENTICATION_HOMESERVER_DISCOVERY,
  NewDeviceSignInCancelledError,
  OidcStateStore,
  UnprotectedStorageDeclinedError,
  RegistrationService,
  SignInRedirectService,
  type LoginMode,
  type AuthMetadata,
  type RegistrationAvailability,
} from '@trinity/data-access/auth';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import {
  ACCOUNT_DELETION_LAUNCHER,
  AppRestartService,
  BUG_REPORT_LAUNCHER,
  SessionStorageService,
  isNativeAndroid,
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
 * login endpoint means refused credentials, not "no permission", so it is mapped here.
 * Anything unrecognised gets the fallback: raw SDK messages carry status lines and URLs.
 */
function describeSignInError(error: unknown, fallback: string): string {
  if (
    error instanceof ReauthAccountMismatchError ||
    error instanceof UnacceptableAccountError ||
    error instanceof NewDeviceSignInCancelledError ||
    error instanceof UnprotectedStorageDeclinedError ||
    (error instanceof Error && error.message === ACCOUNT_NOT_STORED)
  ) {
    return error.message;
  }
  if (error instanceof MatrixError && error.errcode === 'M_USER_DEACTIVATED') {
    return 'This account has been deleted.';
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
  private readonly bugReport = inject(BUG_REPORT_LAUNCHER, { optional: true });
  private readonly usernameInput =
    viewChild<ElementRef<HTMLInputElement>>('usernameInput');
  private readonly deletedNoticeHeading =
    viewChild<ElementRef<HTMLElement>>('deletedNotice');
  private readonly deletion = inject(ACCOUNT_DELETION_LAUNCHER, {
    optional: true,
  });

  /** The account whose deletion left none behind; its confirmation is read first. */
  readonly deletedAccountId: Signal<string | null> =
    this.deletion?.deletedNotice ?? signal(null);

  /** `/login?add` — add a second account instead of replacing the current one. */
  readonly addMode = this.route.snapshot.queryParamMap.has('add');
  /** Report a bug needs the app's launcher; a host without one leaves it out. */
  readonly canReportBug = this.bugReport !== null;
  /** `/login?reauth=<userId>` — re-authenticate a soft-logged-out account (add mode,
   * reusing its device so no re-verification is needed). */
  readonly reauthUserId = signal<string | null>(
    this.route.snapshot.queryParamMap.get('reauth'),
  );
  /** The stored device id to re-authenticate, in re-auth mode. */
  private reauthDeviceId: string | null = null;
  /** The server discovery resolved from what the person entered. */
  private enteredServerName: string | null = null;
  /**
   * `&device=new` on a re-auth: sign in as a new device even when the stored one could be
   * reused. A store created without a key stays unencrypted on its own device; a new device
   * gets an encrypted store, and saving it removes the old one.
   */
  private readonly reauthAsNewDevice =
    this.route.snapshot.queryParamMap.get('device') === 'new';

  /**
   * Accounts stored on this device, for the erase confirmation to name: `/login?add` is
   * reachable while accounts are live, so erasing would take them with it.
   */
  private readonly storedUserIds = signal<readonly string[] | null>(null);

  constructor() {
    // Sweep an abandoned OIDC stash: the TTL is only enforced on read, so an abandoned
    // login leaves a PKCE code_verifier on disk until something peeks. A stash inside its
    // TTL (even from another tab) is untouched. Best-effort: a rejected read must not
    // surface as an unhandled rejection.
    void this.oidcState.peek().catch(() => undefined);

    this.storage
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (records) => this.storedUserIds.set(records.map((r) => r.userId)),
        // Stays null on failure, which the confirmation renders as "any accounts signed in
        // will be signed out": an unreadable registry is a state this button exists for,
        // and silence would read as "nothing is signed in".
        error: () => undefined,
      });

    const reauth = this.reauthUserId();
    if (reauth) {
      this.credentials.update((current) => ({ ...current, username: reauth }));
      this.withBusy(
        this.storage.record(reauth).pipe(
          switchMap((record) => {
            if (!record) {
              return throwError(() => new Error(ACCOUNT_NOT_STORED));
            }
            this.baseUrl.set(record.baseUrl);
            // Reuse the device unless its stored keys can no longer be unlocked here:
            // then only a new device, with a new store and key, can sign back in.
            const reusable = this.reauthAsNewDevice
              ? of(null)
              : this.storage.reusableDeviceId(record);
            return reusable.pipe(
              switchMap((deviceId) => {
                this.reauthDeviceId = deviceId;
                return this.discoverCapabilities(record.baseUrl);
              }),
            );
          }),
        ),
        this.error,
        DISCOVERY_FALLBACK,
      ).subscribe(({ flows, oidc, registration }) =>
        this.applyFlows(flows, oidc, registration),
      );
    }

    effect(() => {
      if (this.deletedAccountId()) {
        afterNextRender(
          () => this.deletedNoticeHeading()?.nativeElement.focus(),
          { injector: this.injector },
        );
      }
    });
    this.destroyRef.onDestroy(() => {
      if (this.deletedAccountId()) this.deletion?.dismissDeletedNotice();
    });

    // The username step appears after discovery, and a document flushes `autofocus` only
    // once (on the homeserver step), so focus it programmatically.
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

  readonly baseUrl = signal<string | null>(null);
  readonly ssoSupported = signal(false);
  /** The homeserver offers legacy SSO, but this app can't (Android). */
  readonly ssoUnavailable = signal(false);
  readonly ssoUnavailableNotice = isNativeAndroid()
    ? "This server's single sign-on isn't supported in the Android app yet. Sign in on the web or desktop app."
    : "This server's single sign-on isn't available in this app. Sign in on the web or desktop app.";
  readonly passwordSupported = signal(false);
  readonly registrationAvailability =
    signal<RegistrationAvailability>('unknown');
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
   * The factory reset in flight, separate from {@link busy} on purpose: the escape hatch
   * must stay reachable while `busy` is stuck (unreachable homeserver; set from first
   * paint on `/login?reauth=`).
   */
  readonly erasing = signal(false);

  // Two forms because the page is two steps; the credentials step only exists once
  // discovery reports a password flow. Declared after `busy`, which the schemas read.
  //
  // Disabled rules live in the schema: Signal Forms owns disabled state, and binding
  // [disabled] on a [formField] node is a compile error (NG8022).
  private readonly homeserverModel = signal({ homeserver: 'matrix.org' });
  readonly homeserverForm = form(this.homeserverModel, (path) => {
    disabled(path.homeserver, { when: () => this.busy() });
  });
  private readonly credentials = signal({ username: '', password: '' });
  readonly credentialsForm = form(this.credentials, (path) => {
    // In re-auth the pre-filled username must stay fixed.
    disabled(path.username, {
      when: () => this.busy() || !!this.reauthUserId(),
    });
    disabled(path.password, { when: () => this.busy() });
  });

  /** Step 1: resolve the homeserver and discover its login flows and OIDC config. */
  discover(): void {
    this.withBusy(
      this.discovery
        .discover(this.homeserverModel().homeserver)
        .pipe(
          switchMap(({ domain, baseUrl }) =>
            this.discoverCapabilities(baseUrl).pipe(
              map((res) => ({ domain, baseUrl, ...res })),
            ),
          ),
        ),
      this.homeserverError,
      DISCOVERY_FALLBACK,
    ).subscribe(({ domain, baseUrl, flows, oidc, registration }) => {
      this.enteredServerName = domain;
      this.baseUrl.set(baseUrl);
      this.applyFlows(flows, oidc, registration);
    });
  }

  /**
   * Discover login flows and OIDC config in parallel. A failing `loginFlows()` must not
   * hide an OIDC provider (an OIDC-native homeserver may not serve legacy `/login`), so
   * its error degrades to "no flows".
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
        // Delegated OIDC owns registration; only a legacy password homeserver needs the
        // availability GET.
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
   * An OIDC-native homeserver owns credentials at the provider, so prefer its "Continue"
   * button and suppress password/SSO (a mid-migration homeserver may still advertise
   * m.login.sso).
   */
  private applyFlows(
    flows: string[],
    oidc: AuthMetadata | null,
    registration: RegistrationAvailability = 'unknown',
  ): void {
    this.oidcMetadata.set(oidc);
    this.registrationAvailability.set(registration);
    this.passwordSupported.set(!oidc && flows.includes('m.login.password'));
    const sso = !oidc && flows.includes('m.login.sso');
    const ssoAvailable = this.signInRedirect.ssoAvailable();
    this.ssoSupported.set(sso && ssoAvailable);
    this.ssoUnavailable.set(sso && !ssoAvailable);
    if (
      !oidc &&
      !this.passwordSupported() &&
      !this.ssoSupported() &&
      !this.ssoUnavailable()
    ) {
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
        this.reauthUserId() ?? undefined,
        this.enteredServerName ?? undefined,
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
    if (!baseUrl || !this.signInRedirect.ssoAvailable()) return;
    this.withBusy(
      this.signInRedirect.startSso(
        baseUrl,
        this.loginMode(),
        this.reauthDeviceId ?? undefined,
        this.reauthUserId() ?? undefined,
      ),
      this.error,
      SIGN_IN_FALLBACK,
    ).subscribe();
  }

  /** Step 2c: OIDC — hand off to the provider; `prompt: 'create'` opens its registration. */
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
        // Re-auth reuses the stored device (no fresh verification); the callback must see
        // this same account return.
        ...(this.reauthDeviceId ? { deviceId: this.reauthDeviceId } : {}),
        expectedUserId: this.reauthUserId(),
      }),
      this.error,
      SIGN_IN_FALLBACK,
    ).subscribe();
  }

  /** Report a bug without signing in; here because Settings is behind `authGuard`. */
  reportBug(): void {
    this.bugReport?.open();
  }

  /**
   * Erase everything Trinity has stored on this device, then restart into a clean app.
   * Lives here because Settings is behind `authGuard`.
   *
   * Not wrapped in `withBusy`: `runWithBusy` turns a failure into `EMPTY`, so `next` would
   * never run and the app would silently not restart after its data is gone.
   */
  clearAllData(): void {
    confirmClearDataIntent(this.alert, this.storedUserIds())
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe((intent) => {
        if (intent === 'cancelled') {
          return;
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
    // Account Runtime owns the attempt: it continues if this observer detaches, and a
    // reopened surface joins it.
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
          // `erasing` stays true: a second press would race the restart.
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
