import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
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
import { AuthService } from '../../core/matrix/auth.service';

@Component({
  selector: 'app-login',
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
  async discover(): Promise<void> {
    this.run(async () => {
      const baseUrl = await this.auth.discoverHomeserver(this.homeserverInput());
      const flows = await this.auth.getSupportedFlows(baseUrl);
      this.baseUrl.set(baseUrl);
      this.passwordSupported.set(flows.includes('m.login.password'));
      this.ssoSupported.set(flows.includes('m.login.sso'));
    });
  }

  /** Step 2a: password login. */
  async loginPassword(): Promise<void> {
    const baseUrl = this.baseUrl();
    if (!baseUrl) return;
    this.run(async () => {
      await this.auth.loginWithPassword(baseUrl, this.username(), this.password());
      await this.router.navigateByUrl('/rooms', { replaceUrl: true });
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

  /** Run an async action with shared busy/error handling. */
  private async run(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
