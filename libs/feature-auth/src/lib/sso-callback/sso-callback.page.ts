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
import { HlmButton } from '@trinity/helm/button';
import { HlmSpinner } from '@trinity/helm/spinner';
import { AuthService } from '@trinity/data-access-auth';
import { SsoStateStore } from '../sso-state.store';

/**
 * Landing route for the homeserver's SSO redirect. Reads the `loginToken` query
 * param, exchanges it for a session (using the homeserver stashed before redirect),
 * then routes into the app. Native deep-link delivery of the token is a follow-up.
 */
@Component({
  selector: 'trn-sso-callback',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sso-callback.page.html',
  imports: [HlmButton, HlmSpinner],
})
export class SsoCallbackPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly ssoState = inject(SsoStateStore);
  private readonly destroyRef = inject(DestroyRef);

  readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    const params = this.route.snapshot.queryParamMap;
    const loginToken = params.get('loginToken');
    const returnedState = params.get('sso_state');

    // Strip the single-use token + state from the URL/history immediately so they
    // can't leak via the address bar, browser history, or a Referer header —
    // including on the error paths below.
    if (loginToken) {
      this.location.replaceState('/sso-callback');
    }

    // Single-use read from Preferences (survives a native cold-start, unlike
    // sessionStorage); consuming clears it so a nonce can't be replayed.
    const stash = await this.ssoState.consume();

    if (!loginToken || !stash.baseUrl) {
      this.error.set(
        'Missing SSO login token or homeserver. Please sign in again.',
      );
      return;
    }

    // Verify the state we generated round-trips — rejects a forged/injected
    // callback (login CSRF / token injection), notably via the native deep link.
    if (!stash.state || returnedState !== stash.state) {
      this.error.set(
        'This sign-in could not be verified. Please sign in again.',
      );
      return;
    }

    this.auth
      .completeSsoLogin(
        stash.baseUrl,
        loginToken,
        stash.mode,
        stash.deviceId ?? undefined,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
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
