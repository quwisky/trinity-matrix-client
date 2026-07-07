import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { Observable, map, switchMap, throwError } from 'rxjs';
import { HlmButton } from '@trinity/helm/button';
import { HlmCardImports } from '@trinity/helm/card';
import { HlmInput } from '@trinity/helm/input';
import { HlmLabel } from '@trinity/helm/label';
import { HlmSpinner } from '@trinity/helm/spinner';
import { AuthService, type LoginMode } from '@trinity/data-access-auth';
import { SessionStorageService } from '@trinity/platform-native';
import { runWithBusy } from '@trinity/ui';
import { SsoStateStore } from '../sso-state.store';

@Component({
  selector: 'trn-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'login.page.html',
  styleUrl: 'login.page.scss',
  imports: [
    FormsModule,
    HlmButton,
    HlmCardImports,
    HlmInput,
    HlmLabel,
    HlmSpinner,
  ],
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly ssoState = inject(SsoStateStore);
  private readonly storage = inject(SessionStorageService);
  private readonly destroyRef = inject(DestroyRef);

  /** `/login?add` — add a second account instead of replacing the current one. */
  readonly addMode = this.route.snapshot.queryParamMap.has('add');
  /** `/login?reauth=<userId>` — re-authenticate a soft-logged-out account (add mode,
   * reusing its existing device so no re-verification is needed). */
  readonly reauthUserId = signal<string | null>(
    this.route.snapshot.queryParamMap.get('reauth'),
  );
  /** The device id to re-authenticate (from the stored record), when in re-auth mode. */
  private reauthDeviceId: string | null = null;

  constructor() {
    const reauth = this.reauthUserId();
    if (reauth) {
      // Skip the homeserver step: load the stored record and discover its flows.
      this.username.set(reauth);
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
            return this.auth.getSupportedFlows(record.baseUrl);
          }),
        ),
      ).subscribe((flows) => {
        this.passwordSupported.set(flows.includes('m.login.password'));
        this.ssoSupported.set(flows.includes('m.login.sso'));
      });
    }
  }

  /** Re-auth and add both keep the other accounts; a plain login replaces them. */
  private loginMode(): LoginMode {
    return this.addMode || this.reauthUserId() ? 'add' : 'replace';
  }

  // Form state.
  readonly homeserverInput = signal('matrix.org');
  readonly username = signal('');
  readonly password = signal('');

  // Resolved homeserver + capabilities after discovery.
  readonly baseUrl = signal<string | null>(null);
  readonly ssoSupported = signal(false);
  readonly passwordSupported = signal(false);

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /** Step 1: resolve the homeserver and discover its login flows. */
  discover(): void {
    this.withBusy(
      this.auth
        .discoverHomeserver(this.homeserverInput())
        .pipe(
          switchMap((baseUrl) =>
            this.auth
              .getSupportedFlows(baseUrl)
              .pipe(map((flows) => ({ baseUrl, flows }))),
          ),
        ),
    ).subscribe(({ baseUrl, flows }) => {
      this.baseUrl.set(baseUrl);
      this.passwordSupported.set(flows.includes('m.login.password'));
      this.ssoSupported.set(flows.includes('m.login.sso'));
    });
  }

  /** Step 2a: password login. */
  loginPassword(): void {
    const baseUrl = this.baseUrl();
    if (!baseUrl) return;
    this.withBusy(
      this.auth.loginWithPassword(
        baseUrl,
        this.username(),
        this.password(),
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

    const native = Capacitor.isNativePlatform();
    const electron =
      (globalThis as { trinityDesktop?: { isElectron?: boolean } })
        .trinityDesktop?.isElectron === true;
    // Native and the Electron desktop shell deep-link back via the OS-registered
    // `eu.qwky.trinity://` scheme. The bare web origin is wrong on Electron — there
    // it's `trinity://app` (an internal, non-OS scheme that can't be launched).
    const base =
      native || electron
        ? 'eu.qwky.trinity://sso-callback'
        : `${window.location.origin}/sso-callback`;
    const redirect = `${base}?sso_state=${encodeURIComponent(state)}`;
    const ssoUrl = this.auth.getSsoUrl(baseUrl, redirect);

    if (native) {
      // Open the system browser so the app's webview — and the appUrlOpen
      // listener in AppComponent — stay alive; the homeserver redirects back via
      // the eu.qwky.trinity:// scheme, which the OS hands to the running app.
      void Browser.open({ url: ssoUrl });
    } else if (electron) {
      // Electron's main process opens https externally (setWindowOpenHandler) and
      // routes the eu.qwky.trinity:// callback back to the renderer (onDeepLink).
      window.open(ssoUrl, '_blank');
    } else {
      window.location.href = ssoUrl;
    }
  }

  /** A random, single-use SSO state token (hex). */
  private generateState(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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
