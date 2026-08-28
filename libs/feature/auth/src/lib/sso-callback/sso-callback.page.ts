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
import { TrnButton } from '@trinity/components/button';
import { TrnSpinnerComponent } from '@trinity/components/spinner';
import { AuthService } from '@trinity/data-access/auth';
import { AuthCardComponent } from '../auth-card/auth-card.component';
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
  imports: [TrnButton, TrnSpinnerComponent, AuthCardComponent],
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
  /** Tail of the serialized handler chain; see the comment in {@link ngOnInit}. */
  private inFlight: Promise<void> = Promise.resolve();

  ngOnInit(): void {
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      // Serialized, not fire-and-forget. `claimed` cannot be set until the callback's
      // state has been verified against the stash — that ordering is what stops a forged
      // deep-link from latching and locking out the genuine one — but verifying requires
      // an await, so two emissions delivered in the same tick would BOTH pass the guard
      // and both redeem the code. Queueing means the second runs only once the first has
      // finished and set the latch, which preserves the ordering and closes the race.
      .subscribe((params) => {
        this.inFlight = this.inFlight
          .then(() => this.handle(params))
          // A failure must not poison the queue: later emissions still need to run.
          // handle() reports its own errors through `error` for everything it can
          // anticipate, but not for a THROW — a rejecting stash read (storage blocked,
          // quota exhausted, a native deep-link plugin failure) escapes it. Swallowing
          // that silently leaves the template on its spinner with no Back button, so
          // surface it — unless a callback already claimed the exchange, in which case
          // that one owns the outcome and this emission is a straggler.
          .catch(() => {
            if (!this.claimed) {
              this.error.set(
                'This sign-in could not be completed. Please sign in again.',
              );
            }
          });
      });
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
    // A genuine callback is now in charge, so any message an earlier straggler left
    // behind is obsolete — don't show it alongside a sign-in that is going through.
    this.error.set(null);
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

  /** OIDC ("next-gen auth"): verify the state, then exchange the code for tokens. */
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
    // A genuine callback is now in charge, so any message an earlier straggler left
    // behind is obsolete — don't show it alongside a sign-in that is going through.
    this.error.set(null);
    await this.oidcState.clear();

    if (authError) {
      this.error.set(
        params.get('error_description') || `Sign-in failed (${authError}).`,
      );
      return;
    }
    // Every field below is required to rebuild the OAuth2 client for the exchange —
    // matrix-js-sdk 42 keeps no sign-in state of its own, so the stash is the only source.
    if (
      !code ||
      !stash.baseUrl ||
      !stash.redirectUri ||
      !stash.clientId ||
      !stash.deviceId ||
      !stash.codeVerifier
    ) {
      this.error.set('Missing sign-in details. Please sign in again.');
      return;
    }

    this.auth
      .completeOidcLogin(
        code,
        {
          baseUrl: stash.baseUrl,
          redirectUri: stash.redirectUri,
          clientId: stash.clientId,
          deviceId: stash.deviceId,
          codeVerifier: stash.codeVerifier,
        },
        stash.mode,
        stash.expectedUserId,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          void this.router.navigateByUrl('/rooms', { replaceUrl: true });
        },
        error: (err) => {
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

  back(): void {
    this.router.navigateByUrl('/login', { replaceUrl: true });
  }
}
