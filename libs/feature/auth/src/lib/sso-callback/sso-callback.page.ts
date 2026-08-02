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
import { ActivatedRoute, Router, type ParamMap } from '@angular/router';
import { HlmButton } from '@trinity/helm/button';
import { HlmSpinner } from '@trinity/helm/spinner';
import { AuthService } from '@trinity/data-access/auth';
import { SsoStateStore } from '../sso-state.store';
import { OidcStateStore } from '../oidc-state.store';

/**
 * Landing route for the auth redirect. Handles BOTH login flows, which are mutually
 * exclusive and distinguished by their callback params: legacy SSO returns
 * `?loginToken=` (+ our `sso_state`), while OIDC ("next-gen auth") returns
 * `?code=&state=` (or `?error=`). Each is exchanged for a session using the state
 * stashed before the redirect, then routes into the app.
 *
 * It subscribes to the query params (rather than reading the snapshot once) so that a
 * SECOND navigation to this route still runs — the native deep link reuses this
 * component, so if a forged callback lands first, the genuine one must still be
 * processed. The stash is only consumed once the callback's state matches, so a
 * forged/mismatched callback (any app can fire the shared deep-link scheme) can't wipe
 * an in-flight login. A `claimed` latch makes the exchange run at most once.
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
  private readonly oidcState = inject(OidcStateStore);
  private readonly destroyRef = inject(DestroyRef);

  readonly error = signal<string | null>(null);
  /** Set once a callback's state matches and we begin the exchange — ignore further ones. */
  private claimed = false;

  ngOnInit(): void {
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => void this.handle(params));
  }

  private async handle(params: ParamMap): Promise<void> {
    if (this.claimed) {
      return;
    }
    const loginToken = params.get('loginToken');
    const code = params.get('code');
    const authError = params.get('error');
    if (!loginToken && !code && !authError) {
      return; // no callback params on this emission (e.g. our own replaceState)
    }

    // Strip the single-use token/code + state from the URL/history immediately so they
    // can't leak via the address bar, browser history, or a Referer header.
    this.location.replaceState('/sso-callback');

    if (code || authError) {
      await this.completeOidc(params, code, authError);
    } else {
      await this.completeSso(params, loginToken);
    }
  }

  /** Legacy SSO: verify state, then exchange the returned `loginToken` for a session. */
  private async completeSso(
    params: ParamMap,
    loginToken: string | null,
  ): Promise<void> {
    const returnedState = params.get('sso_state');
    // Peek (survives a native cold-start, unlike sessionStorage) WITHOUT clearing, so a
    // forged callback can't wipe a live stash.
    const stash = await this.ssoState.peek();
    if (!stash.state || returnedState !== stash.state) {
      // A mismatch against a live stash is a forged callback — stay quiet and let the
      // genuine one arrive; only report when there's genuinely no pending login.
      this.reportUnverified(stash.state);
      return;
    }
    this.claimed = true;
    await this.ssoState.clear();

    if (!loginToken || !stash.baseUrl) {
      this.error.set(
        'Missing SSO login token or homeserver. Please sign in again.',
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

  /** OIDC ("next-gen auth"): verify state, re-seed the PKCE state, then exchange the code. */
  private async completeOidc(
    params: ParamMap,
    code: string | null,
    authError: string | null,
  ): Promise<void> {
    const returnedState = params.get('state');
    const stash = await this.oidcState.peek();
    // Verify the OAuth state round-trips BEFORE consuming (defence-in-depth against a
    // forged/injected deep-link callback that any app can fire on the shared scheme).
    if (!stash.state || returnedState !== stash.state) {
      this.reportUnverified(stash.state);
      return;
    }
    this.claimed = true;
    await this.oidcState.clear();

    if (authError) {
      this.error.set(
        params.get('error_description') || `Sign-in failed (${authError}).`,
      );
      return;
    }
    if (!code || !stash.baseUrl || !stash.redirectUri) {
      this.error.set('Missing sign-in details. Please sign in again.');
      return;
    }
    // Re-seed the PKCE sign-in state the SDK persisted in sessionStorage: it is empty in
    // a native/Electron WebView after a system-browser round-trip or a cold-start
    // relaunch (harmless on web, where it survived the same-tab redirect).
    if (stash.sessionStateKey && stash.sessionStateBlob) {
      globalThis.sessionStorage?.setItem(
        stash.sessionStateKey,
        stash.sessionStateBlob,
      );
    }

    this.auth
      .completeOidcLogin(code, stash.state, stash.redirectUri, stash.mode)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.clearSigninState(stash.sessionStateKey);
          void this.router.navigateByUrl('/rooms', { replaceUrl: true });
        },
        error: (err) => {
          this.clearSigninState(stash.sessionStateKey);
          // A provider that pruned our dynamic registration fails with invalid_client
          // forever; forget the cached client id so the next attempt re-registers.
          if (stash.issuer && /invalid_client/i.test(this.messageOf(err))) {
            this.auth
              .forgetOidcClientId(stash.issuer)
              .pipe(takeUntilDestroyed(this.destroyRef))
              .subscribe({ error: () => undefined });
          }
          this.error.set(this.messageOf(err));
        },
      });
  }

  /**
   * Report a callback whose state we couldn't verify. When a live stash exists the
   * mismatch means a forged callback — stay silent so the genuine callback (which reuses
   * this component) can still complete; only surface an error when nothing is pending.
   */
  private reportUnverified(pendingState: string | null): void {
    if (!pendingState) {
      this.error.set(
        'This sign-in could not be verified. Please sign in again.',
      );
    }
  }

  private messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /** Drop the spent re-seeded sign-in state — it holds the now-used code_verifier. */
  private clearSigninState(key: string | null): void {
    if (key) {
      globalThis.sessionStorage?.removeItem(key);
    }
  }

  back(): void {
    this.router.navigateByUrl('/login', { replaceUrl: true });
  }
}
