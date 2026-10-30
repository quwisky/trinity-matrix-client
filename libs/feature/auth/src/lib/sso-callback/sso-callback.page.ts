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
import { TrnButton } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import {
  AuthService,
  OidcStateStore,
  SsoStateStore,
  type OidcGrantContext,
} from '@trinity/data-access/auth';
import { EngineRequestError } from '@trinity/util/matrix';
import { AuthCardComponent } from '../auth-card/auth-card.component';
import { accountEstablishmentError } from '../account-establishment-outcome';

/**
 * Landing route for the auth redirect, for both login flows: legacy SSO returns
 * `?loginToken=` (+ our `sso_state`), OIDC returns `?code=&state=` (or `?error=`). Each is
 * exchanged for a session using the state stashed before the redirect.
 *
 * It subscribes to the query params so a SECOND navigation still runs: the native deep
 * link reuses this component, so the genuine callback must be processed even if a forged
 * one lands first. The stash is only consumed once the callback's state matches, so a
 * forged callback (any app can fire the shared deep-link scheme) can't wipe an in-flight
 * login. A `claimed` latch makes the exchange run at most once.
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
  /** Set once a callback's state matches and the exchange begins; later ones are ignored. */
  private claimed = false;
  /** Tail of the serialized handler chain; see the comment in {@link ngOnInit}. */
  private inFlight: Promise<void> = Promise.resolve();

  ngOnInit(): void {
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      // Serialized: `claimed` is set only after the state is verified (so a forged
      // deep-link can't lock out the genuine one), but verifying awaits, so two emissions
      // in the same tick would both pass the guard and redeem the code twice.
      .subscribe((params) => {
        this.inFlight = this.inFlight
          .then(() => this.handle(params))
          // A failure must not poison the queue. handle() reports anticipated errors, but
          // a THROW (rejecting stash read, deep-link plugin failure) escapes it, and
          // swallowing it leaves a spinner with no Back button. Skipped once a callback
          // has claimed the exchange: that one owns the outcome.
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
      return; // e.g. our own replaceState
    }

    // Strip the single-use token/code + state so they can't leak via the address bar,
    // history, or a Referer header.
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
    // Peek without clearing, so a forged callback can't wipe a live stash. The store
    // survives a native cold start, unlike sessionStorage.
    const stash = await this.ssoState.peek();
    if (!stash.state || returnedState !== stash.state) {
      this.reportUnverified(stash.state);
      return;
    }
    this.claimed = true;
    // A genuine callback is in charge: drop any message an earlier straggler left.
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
        stash.expectedUserId ?? undefined,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (outcome) => {
          const error = accountEstablishmentError(outcome);
          if (error) {
            this.error.set(error);
            return;
          }
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
    // forged deep-link callback that any app can fire on the shared scheme).
    if (!stash.state || returnedState !== stash.state) {
      this.reportUnverified(stash.state);
      return;
    }
    this.claimed = true;
    // A genuine callback is in charge: drop any message an earlier straggler left.
    this.error.set(null);
    await this.oidcState.clear();

    if (authError) {
      this.error.set(
        params.get('error_description') || `Sign-in failed (${authError}).`,
      );
      return;
    }
    // Every field is needed to redeem the code; nothing else keeps sign-in state, so the
    // stash is the only source.
    if (
      !code ||
      !stash.baseUrl ||
      !stash.redirectUri ||
      !stash.clientId ||
      !stash.deviceId ||
      !stash.codeVerifier ||
      !stash.issuer ||
      !stash.authorizationEndpoint ||
      !stash.tokenEndpoint
    ) {
      this.error.set('Missing sign-in details. Please sign in again.');
      return;
    }

    // RFC 9207 `iss`: the exchange checks that the sign-in response comes from the
    // provider it started with.
    const iss = params.get('iss');
    const context: OidcGrantContext = {
      baseUrl: stash.baseUrl,
      redirectUri: stash.redirectUri,
      clientId: stash.clientId,
      deviceId: stash.deviceId,
      codeVerifier: stash.codeVerifier,
      issuer: stash.issuer,
      authorizationEndpoint: stash.authorizationEndpoint,
      tokenEndpoint: stash.tokenEndpoint,
      ...(stash.revocationEndpoint
        ? { revocationEndpoint: stash.revocationEndpoint }
        : {}),
      ...(iss !== null ? { iss } : {}),
    };
    this.auth
      .completeOidcLogin(code, context, stash.mode, stash.expectedUserId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (outcome) => {
          const error = accountEstablishmentError(outcome);
          if (error) {
            this.error.set(error);
            return;
          }
          void this.router.navigateByUrl('/rooms', { replaceUrl: true });
        },
        error: (err) => {
          // A provider that pruned our dynamic registration rejects the client forever;
          // forget the cached client id so the next attempt re-registers.
          if (
            err instanceof EngineRequestError &&
            err.failure.code === 'oauth-client-rejected'
          ) {
            this.auth
              .forgetOidcClientId(
                context.baseUrl,
                context.issuer,
                context.clientId,
              )
              .pipe(takeUntilDestroyed(this.destroyRef))
              .subscribe({ error: () => undefined });
          }
          this.error.set(this.messageOf(err));
        },
      });
  }

  /**
   * Report a callback whose state we couldn't verify. A mismatch against a live stash is a
   * forged callback: stay silent so the genuine one can still complete; report only when
   * nothing is pending.
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
