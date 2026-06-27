import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { Location } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import {
  IonContent,
  IonSpinner,
  IonText,
  IonButton,
} from '@ionic/angular/standalone';
import { AuthService } from '@trinity/core';

/**
 * Landing route for the homeserver's SSO redirect. Reads the `loginToken` query
 * param, exchanges it for a session (using the homeserver stashed before redirect),
 * then routes into the app. Native deep-link delivery of the token is a follow-up.
 */
@Component({
  selector: 'trn-sso-callback',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-content class="ion-padding ion-text-center">
      <h1 class="sr-only">Completing sign in</h1>
      @if (error(); as e) {
        <p>
          <ion-text color="danger">{{ e }}</ion-text>
        </p>
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
  private readonly location = inject(Location);
  private readonly destroyRef = inject(DestroyRef);

  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    const loginToken = this.route.snapshot.queryParamMap.get('loginToken');
    const baseUrl = sessionStorage.getItem('sso.baseUrl');

    // Strip the single-use token from the URL/history immediately so it can't
    // leak via the address bar, browser history, or a Referer header — including
    // on the error path below.
    if (loginToken) {
      this.location.replaceState('/sso-callback');
    }

    if (!loginToken || !baseUrl) {
      this.error.set(
        'Missing SSO login token or homeserver. Please sign in again.',
      );
      return;
    }

    this.auth
      .completeSsoLogin(baseUrl, loginToken)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          sessionStorage.removeItem('sso.baseUrl');
          void this.router.navigateByUrl('/rooms', { replaceUrl: true });
        },
        error: (err) =>
          this.error.set(err instanceof Error ? err.message : String(err)),
      });
  }

  back(): void {
    this.router.navigateByUrl('/login', { replaceUrl: true });
  }
}
