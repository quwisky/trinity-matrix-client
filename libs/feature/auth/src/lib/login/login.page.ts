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
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import {
  Observable,
  catchError,
  forkJoin,
  map,
  of,
  switchMap,
  throwError,
} from 'rxjs';
import { HlmButton } from '@trinity/helm/button';
import { TrnCardImports } from '@trinity/components/card';
import { TrnInput } from '@trinity/components/input';
import { TrnLabel } from '@trinity/components/label';
import { TrnSpinnerComponent } from '@trinity/components/spinner';
import {
  AuthService,
  FactoryResetService,
  type LoginMode,
  type OidcApplicationType,
  type OidcAuthorizationRequest,
  type AuthMetadata,
} from '@trinity/data-access/auth';
import {
  AppRestartService,
  SessionStorageService,
} from '@trinity/platform-native';
import { TrnAlertService } from '@trinity/components/overlay';
import { runWithBusy } from '@trinity/ui';
import { SsoStateStore } from '../sso-state.store';
import {
  CLEAR_DATA_MISTYPED_MESSAGE,
  CLEAR_DATA_RESIDUE_WARNING,
  confirmClearDataIntent,
} from './clear-all-data';
import { OidcStateStore } from '../oidc-state.store';
import { TrnIconComponent } from '@trinity/components/icon';

@Component({
  selector: 'trn-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'login.page.html',
  styleUrl: 'login.page.scss',
  imports: [
    FormField,
    HlmButton,
    TrnCardImports,
    TrnInput,
    TrnLabel,
    TrnSpinnerComponent,
    TrnIconComponent,
  ],
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly ssoState = inject(SsoStateStore);
  private readonly oidcState = inject(OidcStateStore);
  private readonly storage = inject(SessionStorageService);
  private readonly alert = inject(TrnAlertService);
  private readonly factoryReset = inject(FactoryResetService);
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
      ).subscribe(({ flows, oidc }) => this.applyFlows(flows, oidc));
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
      this.auth
        .discoverHomeserver(this.homeserverModel().homeserver)
        .pipe(
          switchMap((baseUrl) =>
            this.discoverCapabilities(baseUrl).pipe(
              map((res) => ({ baseUrl, ...res })),
            ),
          ),
        ),
    ).subscribe(({ baseUrl, flows, oidc }) => {
      this.baseUrl.set(baseUrl);
      this.applyFlows(flows, oidc);
    });
  }

  /**
   * Discover the login flows and delegated OIDC config in parallel. A failing
   * `loginFlows()` must NOT hide an available OIDC provider (an OIDC-native homeserver
   * may not serve the legacy `/login` flows at all), so its error degrades to "no
   * flows" rather than aborting the whole discovery.
   */
  private discoverCapabilities(
    baseUrl: string,
  ): Observable<{ flows: string[]; oidc: AuthMetadata | null }> {
    return forkJoin({
      flows: this.auth
        .getSupportedFlows(baseUrl)
        .pipe(catchError(() => of<string[]>([]))),
      oidc: this.auth.getDelegatedAuthConfig(baseUrl),
    });
  }

  /**
   * Apply the discovered capabilities. An OIDC-native homeserver owns credentials at the
   * provider, so prefer its "Continue" button and suppress the legacy password/SSO ones
   * (a homeserver mid-migration may still advertise m.login.sso for compatibility).
   */
  private applyFlows(flows: string[], oidc: AuthMetadata | null): void {
    this.oidcMetadata.set(oidc);
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
    ).subscribe(() => {
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

    const { native, electron } = this.platform();
    // Native and the Electron desktop shell deep-link back via the OS-registered
    // `eu.qwky.trinity://` scheme. The bare web origin is wrong on Electron — there
    // it's `trinity://app` (an internal, non-OS scheme that can't be launched).
    const base =
      native || electron
        ? 'eu.qwky.trinity://sso-callback'
        : `${window.location.origin}/sso-callback`;
    const redirect = `${base}?sso_state=${encodeURIComponent(state)}`;
    const ssoUrl = this.auth.getSsoUrl(baseUrl, redirect);
    this.dispatchRedirect(ssoUrl, native, electron);
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
    const { native, electron } = this.platform();
    // The redirect_uri must byte-match a value registered with the provider — a clean
    // callback with no extra query params (the CSRF `state` rides OAuth's own param).
    // Private-use scheme redirects take the RFC 8252 §7.1 form: no authority, so a
    // SINGLE slash after the scheme. `//sso-callback` parses the callback as the
    // authority with an empty path, which providers that enforce the rule reject at
    // dynamic registration ("must not have an authority") before login can start.
    const redirectUri =
      native || electron
        ? 'eu.qwky.trinity:/sso-callback'
        : `${window.location.origin}/sso-callback`;
    const applicationType: OidcApplicationType =
      native || electron ? 'native' : 'web';

    this.withBusy(
      this.auth.buildOidcAuthorizationRequest({
        baseUrl,
        metadata: config,
        redirectUri,
        applicationType,
        ...(prompt ? { prompt } : {}),
        // Re-auth reuses the stored device so the account comes back without needing a
        // fresh verification — the same reason it is threaded into the password and SSO
        // paths above.
        ...(this.reauthDeviceId ? { deviceId: this.reauthDeviceId } : {}),
      }),
    ).subscribe((request) => {
      void this.stashAndRedirect(
        request,
        baseUrl,
        config.issuer,
        redirectUri,
        native,
        electron,
      );
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
    native: boolean,
    electron: boolean,
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
    this.dispatchRedirect(request.url, native, electron);
  }

  /** Whether this build runs as a native app and/or the Electron desktop shell. */
  private platform(): { native: boolean; electron: boolean } {
    return {
      native: Capacitor.isNativePlatform(),
      electron:
        (globalThis as { trinityDesktop?: { isElectron?: boolean } })
          .trinityDesktop?.isElectron === true,
    };
  }

  /** Redirect the user to an external auth URL, per platform. */
  private dispatchRedirect(
    url: string,
    native: boolean,
    electron: boolean,
  ): void {
    if (native) {
      // Open the system browser so the app's webview — and the appUrlOpen listener in
      // AppComponent — stay alive; the provider redirects back via the OS-registered
      // eu.qwky.trinity:// scheme, which the OS hands to the running app.
      void Browser.open({ url });
    } else if (electron) {
      // Electron's main process opens https externally (setWindowOpenHandler) and
      // routes the eu.qwky.trinity:// callback back to the renderer (onDeepLink).
      window.open(url, '_blank');
    } else {
      window.location.href = url;
    }
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
    // Deliberately NOT `takeUntilDestroyed`: the wipe is an un-cancellable promise, so
    // unsubscribing would abandon the restart while the data is already gone — leaving the
    // app running against erased storage with every client torn down. If this page goes
    // away mid-wipe, the restart is more necessary, not less.
    this.factoryReset.clearAllData().subscribe((report) => {
      const residue = [...report.blocked, ...report.failed];
      if (residue.length > 0) {
        // Not surfaced to the user: the wipe finished, and what is left is an orphaned
        // database that the next cold start sweeps, when nothing holds a connection.
        console.warn(CLEAR_DATA_RESIDUE_WARNING, residue);
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
