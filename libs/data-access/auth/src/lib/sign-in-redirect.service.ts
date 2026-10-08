import { Injectable, inject } from '@angular/core';
import { HostAuthenticationHandoffService } from '@trinity/runtime/host';
import { Observable, defer, map, switchMap, take } from 'rxjs';
import type { ValidatedAuthMetadata } from 'matrix-js-sdk';
import type { LoginMode } from './account-establishment';
import { AuthService } from './auth.service';
import { OidcStateStore } from './oidc-state.store';
import { SsoStateStore } from './sso-state.store';

/** What an OIDC ("next-gen auth") redirect needs beyond the discovered provider. */
export interface OidcRedirectRequest {
  baseUrl: string;
  metadata: ValidatedAuthMetadata;
  mode: LoginMode;
  /** `'create'` sends the user to the provider's registration flow instead of login. */
  prompt?: string;
  /** Re-auth reuses the stored device so the account returns without re-verification. */
  deviceId?: string;
  /** Re-auth only: the account the callback must come back as; null for a plain login. */
  expectedUserId: string | null;
}

/**
 * The SSO/OIDC redirect handoff: durably stash the sign-in state, THEN send the user to
 * the homeserver or provider. Both methods are cold and finite, and a failed stash write
 * errors without redirecting, since a callback with nothing to validate against would
 * only fail later and less legibly.
 */
@Injectable({ providedIn: 'root' })
export class SignInRedirectService {
  private readonly auth = inject(AuthService);
  private readonly handoff = inject(HostAuthenticationHandoffService);
  private readonly ssoState = inject(SsoStateStore);
  private readonly oidcState = inject(OidcStateStore);

  /** Legacy SSO: stash a single-use state, then open the homeserver's SSO page. */
  startSso(
    baseUrl: string,
    mode: LoginMode,
    deviceId?: string,
  ): Observable<void> {
    return defer(() => {
      // Single-use state bound to this round-trip; verified on the callback to prevent
      // login CSRF / token injection (esp. on the native deep-link, which any app can
      // invoke). Stashed in Preferences (not sessionStorage) so a native cold-start
      // relaunch — whose WebView has empty sessionStorage — can still validate. The write
      // is awaited so the stash is durable before the SSO redirect can return.
      const state = generateState();
      return this.ssoState.save(state, baseUrl, mode, deviceId).then(() => {
        const callback = this.handoff.callback({
          webUrl: `${window.location.origin}/sso-callback`,
          appUrl: 'eu.qwky.trinity://sso-callback',
        });
        const redirect = `${callback.url}?sso_state=${encodeURIComponent(state)}`;
        return this.auth.getSsoUrl(baseUrl, redirect);
      });
    }).pipe(switchMap((url) => this.redirect(url)));
  }

  /**
   * OIDC: build the PKCE authorization request (registering this client with the
   * provider if needed), stash the sign-in state, then open the authorization URL.
   */
  startOidc(request: OidcRedirectRequest): Observable<void> {
    return defer(() => {
      // The redirect_uri must byte-match a value registered with the provider — a clean
      // callback with no extra query params (the CSRF `state` rides OAuth's own param).
      // Private-use scheme redirects take the RFC 8252 §7.1 form: no authority, so a
      // SINGLE slash after the scheme. `//sso-callback` parses the callback as the
      // authority with an empty path, which providers that enforce the rule reject at
      // dynamic registration ("must not have an authority") before login can start.
      const callback = this.handoff.callback({
        webUrl: `${window.location.origin}/sso-callback`,
        appUrl: 'eu.qwky.trinity:/sso-callback',
      });
      const redirectUri = callback.url;
      return this.auth
        .buildOidcAuthorizationRequest({
          baseUrl: request.baseUrl,
          metadata: request.metadata,
          redirectUri,
          applicationType: callback.applicationType,
          ...(request.prompt ? { prompt: request.prompt } : {}),
          ...(request.deviceId ? { deviceId: request.deviceId } : {}),
        })
        .pipe(
          // Persisted on every platform, and awaited so it survives a native cold start
          // before the provider can redirect back. matrix-js-sdk 42 keeps no sign-in
          // state of its own, so this stash is the only copy.
          switchMap((authorization) =>
            this.oidcState
              .save({
                state: authorization.state,
                baseUrl: request.baseUrl,
                mode: request.mode,
                redirectUri,
                issuer: request.metadata.issuer,
                clientId: authorization.clientId,
                deviceId: authorization.deviceId,
                codeVerifier: authorization.codeVerifier,
                expectedUserId: request.expectedUserId,
              })
              .then(() => authorization.url),
          ),
        );
    }).pipe(switchMap((url) => this.redirect(url)));
  }

  private redirect(url: string): Observable<void> {
    return this.handoff.open({ url }).pipe(
      take(1),
      map(() => undefined),
    );
  }
}

/** A random, single-use state/nonce token (hex). */
function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
