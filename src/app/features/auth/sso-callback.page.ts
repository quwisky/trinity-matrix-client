import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { IonContent, IonSpinner, IonText, IonButton } from '@ionic/angular/standalone';
import { AuthService } from '../../core/matrix/auth.service';

/**
 * Landing route for the homeserver's SSO redirect. Reads the `loginToken` query
 * param, exchanges it for a session (using the homeserver stashed before redirect),
 * then routes into the app. Native deep-link delivery of the token is a follow-up.
 */
@Component({
  selector: 'app-sso-callback',
  template: `
    <ion-content class="ion-padding ion-text-center">
      @if (error(); as e) {
        <p><ion-text color="danger">{{ e }}</ion-text></p>
        <ion-button (click)="back()">Back to sign in</ion-button>
      } @else {
        <ion-spinner name="dots"></ion-spinner>
        <p>Completing sign in…</p>
      }
    </ion-content>
  `,
  imports: [IonContent, IonSpinner, IonText, IonButton],
})
export class SsoCallbackPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    const loginToken = this.route.snapshot.queryParamMap.get('loginToken');
    const baseUrl = sessionStorage.getItem('sso.baseUrl');

    if (!loginToken || !baseUrl) {
      this.error.set('Missing SSO login token or homeserver. Please sign in again.');
      return;
    }

    try {
      await this.auth.completeSsoLogin(baseUrl, loginToken);
      sessionStorage.removeItem('sso.baseUrl');
      await this.router.navigateByUrl('/rooms', { replaceUrl: true });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  back(): void {
    this.router.navigateByUrl('/login', { replaceUrl: true });
  }
}
