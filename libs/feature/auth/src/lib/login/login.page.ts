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
} from '@trinity/components/controls';
import { TrnCardImports } from '@trinity/components/navigation-layout';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import {
  AuthService,
  AUTHENTICATION_HOMESERVER_DISCOVERY,
  RegistrationService,
  type LoginMode,
  type OidcAuthorizationRequest,
  type AuthMetadata,
  type RegistrationAvailability,
} from '@trinity/data-access/auth';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import {
  AppRestartService,
  SessionStorageService,
} from '@trinity/platform-native';
import { TrnAlertService } from '@trinity/components/overlay';
import { runWithBusy } from '@trinity/util/ui';
import { SsoStateStore } from '../sso-state.store';
import {
  CLEAR_DATA_MISTYPED_MESSAGE,
  CLEAR_DATA_RESIDUE_WARNING,
  confirmClearDataIntent,
} from './clear-all-data';
import { AuthCardComponent } from '../auth-card/auth-card.component';
import { OidcStateStore } from '../oidc-state.store';
import { TrnIconComponent } from '@trinity/components/foundations';
import { accountEstablishmentError } from '../account-establishment-outcome';
import { HostAuthenticationHandoffService } from '@trinity/runtime/host';

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
    TrnSpinnerComponent,
    TrnIconComponent,
  ],
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly discovery = inject(AUTHENTICATION_HOMESERVER_DISCOVERY);
  private readonly registration = inject(RegistrationService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly authenticationHandoff = inject(
    HostAuthenticationHandoffService,
  );
  private readonly ssoState = inject(SsoStateStore);
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
              return throwError(
                () => new Error('That account is no longer stored.'),
              );
            }
            this.reauthDeviceId = record.deviceId;
            this.baseUrl.set(record.baseUrl);
            return this.discoverCapabilities(record.baseUrl);
          }),
        ),
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

  readonly passwordVisible = signal(false);

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
  readonly error = signal<string | null>(null);
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
    ).subscribe((outcome) => {
      const error = accountEstablishmentError(outcome);
      if (error) {
        this.error.set(error);
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
  async startSso(): Promise<void> {
    const baseUrl = this.baseUrl();
    if (!baseUrl) return;
    // Single-use state bound to this round-trip; verified on the callback to prevent
    // login CSRF / token injection (esp. on the native deep-link, which any app can
    // invoke). Stashed in Preferences (not sessionStorage) so a native cold-start
    // relaunch — whose WebView has empty sessionStorage — can still validate. Await
    // the write so the stash is durable before the SSO redirect can return.
    const state = this.generateState();
    await this.ssoState.save(
      state,
      baseUrl,
      this.loginMode(),
      this.reauthDeviceId ?? undefined,
    );

    const callback = this.authenticationHandoff.callback({
      webUrl: `${window.location.origin}/sso-callback`,
      appUrl: 'eu.qwky.trinity://sso-callback',
    });
    const redirect = `${callback.url}?sso_state=${encodeURIComponent(state)}`;
    const ssoUrl = this.auth.getSsoUrl(baseUrl, redirect);
    this.dispatchRedirect(ssoUrl);
  }

  /**
   * Step 2c: OIDC ("next-gen auth") — hand off to the provider's authorization page.
   * Builds the PKCE authorization request (registering this client with the provider
   * if needed), durably stashes the sign-in state, then redirects. Pass `prompt`
   * (`'create'`) to send the user to the provider's registration flow instead of login.
   */
  startOidc(prompt?: string): void {
    const baseUrl = this.baseUrl();
    const config = this.oidcMetadata();
    if (!baseUrl || !config?.issuer) {
      return;
    }
    // The redirect_uri must byte-match a value registered with the provider — a clean
    // callback with no extra query params (the CSRF `state` rides OAuth's own param).
    // Private-use scheme redirects take the RFC 8252 §7.1 form: no authority, so a
    // SINGLE slash after the scheme. `//sso-callback` parses the callback as the
    // authority with an empty path, which providers that enforce the rule reject at
    // dynamic registration ("must not have an authority") before login can start.
    const callback = this.authenticationHandoff.callback({
      webUrl: `${window.location.origin}/sso-callback`,
      appUrl: 'eu.qwky.trinity:/sso-callback',
    });
    const redirectUri = callback.url;

    this.withBusy(
      this.auth.buildOidcAuthorizationRequest({
        baseUrl,
        metadata: config,
        redirectUri,
        applicationType: callback.applicationType,
        ...(prompt ? { prompt } : {}),
        // Re-auth reuses the stored device so the account comes back without needing a
        // fresh verification — the same reason it is threaded into the password and SSO
        // paths above.
        ...(this.reauthDeviceId ? { deviceId: this.reauthDeviceId } : {}),
      }),
    ).subscribe((request) => {
      void this.stashAndRedirect(request, baseUrl, config.issuer, redirectUri);
    });
  }

  /**
   * Persist the PKCE sign-in state (awaited, so it survives a native cold-start before
   * the provider can redirect back), then redirect to the authorization URL.
   */
  private async stashAndRedirect(
    request: OidcAuthorizationRequest,
    baseUrl: string,
    issuer: string,
    redirectUri: string,
  ): Promise<void> {
    // Persisted on every platform. Web used to be skipped because the SDK kept its own
    // sessionStorage copy of the sign-in state; matrix-js-sdk 42 keeps nothing, so this
    // stash is the only copy and omitting it on web would simply break web login.
    await this.oidcState.save({
      state: request.state,
      baseUrl,
      mode: this.loginMode(),
      redirectUri,
      issuer,
      clientId: request.clientId,
      deviceId: request.deviceId,
      codeVerifier: request.codeVerifier,
      // Re-auth reuses this account's device id, so the callback must also check the
      // grant came back as this account — a provider with a live browser session can
      // authorize silently as a different one.
      expectedUserId: this.reauthUserId(),
    });
    this.dispatchRedirect(request.url);
  }

  /** Execute the selected host's cold, finite authentication handoff command. */
  private dispatchRedirect(url: string): void {
    this.authenticationHandoff
      .open({ url })
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** A random, single-use state/nonce token (hex). */
  private generateState(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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
  async clearAllData(): Promise<void> {
    const intent = await confirmClearDataIntent(
      this.alert,
      this.storedUserIds(),
    );
    if (intent === 'cancelled') {
      return; // they stopped it themselves; saying anything would be nagging
    }
    if (intent === 'mistyped') {
      this.error.set(CLEAR_DATA_MISTYPED_MESSAGE);
      return;
    }

    this.error.set(null);
    this.erasing.set(true);
    // Deliberately NOT `takeUntilDestroyed`: after cleanup begins, a page transition must
    // not abandon the restart while storage is already being erased.
    this.accounts.resetInstallation().subscribe((outcome) => {
      if (outcome.kind === 'transition-in-progress') {
        this.erasing.set(false);
        this.error.set(
          'Another account change is still in progress. Try again.',
        );
        return;
      }
      if (outcome.kind === 'partial-cleanup') {
        // Not surfaced to the user: the wipe finished, and what is left is an orphaned
        // scope that the typed recovery guidance handles on the next cold start.
        console.warn(
          CLEAR_DATA_RESIDUE_WARNING,
          outcome.issues.map((issue) => ({
            scope: issue.scope,
            recovery: issue.recovery,
          })),
        );
      }
      // `erasing` stays true: the app is about to be replaced, and releasing the button now
      // would let a second press race the navigation.
      this.restart.restart();
    });
  }

  /** Wrap a one-shot action with shared busy/error handling. */
  private withBusy<T>(source: Observable<T>): Observable<T> {
    return runWithBusy(source, {
      busy: this.busy,
      error: this.error,
      destroyRef: this.destroyRef,
    });
  }
}
