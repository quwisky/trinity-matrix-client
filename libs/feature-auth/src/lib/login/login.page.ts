import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { EMPTY, Observable, catchError, finalize, map, switchMap } from 'rxjs';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonList,
  IonItem,
  IonInput,
  IonButton,
  IonText,
  IonSpinner,
} from '@ionic/angular/standalone';
import { AuthService } from '@trinity/core';

@Component({
  selector: 'trn-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'login.page.html',
  imports: [
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonList,
    IonItem,
    IonInput,
    IonButton,
    IonText,
    IonSpinner,
  ],
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

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
      this.auth.loginWithPassword(baseUrl, this.username(), this.password()),
    ).subscribe(() => {
      void this.router.navigateByUrl('/rooms', { replaceUrl: true });
    });
  }

  /** Step 2b: SSO — hand off to the homeserver's SSO page. */
  startSso(): void {
    const baseUrl = this.baseUrl();
    if (!baseUrl) return;
    // Stash the homeserver so the callback (a fresh app load) can complete login.
    sessionStorage.setItem('sso.baseUrl', baseUrl);
    // On web we return to /sso-callback; native deep-link wiring is a follow-up.
    const redirect = Capacitor.isNativePlatform()
      ? 'eu.qwky.trinity://sso-callback'
      : `${window.location.origin}/sso-callback`;
    window.location.href = this.auth.getSsoUrl(baseUrl, redirect);
  }

  /** Wrap a one-shot action with shared busy/error handling. */
  private withBusy<T>(source: Observable<T>): Observable<T> {
    this.busy.set(true);
    this.error.set(null);
    return source.pipe(
      takeUntilDestroyed(this.destroyRef),
      catchError((err) => {
        this.error.set(err instanceof Error ? err.message : String(err));
        return EMPTY;
      }),
      finalize(() => this.busy.set(false)),
    );
  }
}
