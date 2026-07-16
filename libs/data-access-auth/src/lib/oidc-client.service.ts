import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import {
  completeAuthorizationCodeGrant,
  createClient,
  generateOidcAuthorizationUrl,
  registerOidcClient,
  type OidcClientConfig,
  type OidcRegistrationClientMetadata,
} from 'matrix-js-sdk';
import { Observable, catchError, defer, from, map, of, switchMap } from 'rxjs';
import type { OidcSessionBinding } from '@trinity/util-matrix';

/** How this client identifies itself to an OIDC provider during dynamic registration. */
const CLIENT_NAME = 'Trinity';
/** Stable https identifier for the app (dynamic-registration `client_uri`). */
const CLIENT_URI = 'https://trinity.qwky.eu';
/**
 * Preferences key prefix for the dynamic-registration client id, cached per issuer.
 * Versioned: a registration pins the redirect_uris it was created with, so changing the
 * redirect_uri we send strands every id cached under the old shape (the provider then
 * rejects the authorization with a redirect mismatch, which is NOT the `invalid_client`
 * that {@link OidcClientService.forgetClientId} recovers from). Bump on any change to
 * the registered metadata to force a clean re-registration.
 */
const CLIENT_ID_KEY_PREFIX = 'oidc.clientId.v2:';
/**
 * sessionStorage key prefix oidc-client-ts (via matrix-js-sdk) uses to persist the
 * PKCE sign-in state (`mx_oidc_<state>`). We harvest that entry so it can be re-seeded
 * for a callback that returns to a different browsing context (native/Electron) or
 * after a cold-start relaunch, where sessionStorage would otherwise be empty.
 */
const SIGNIN_STATE_PREFIX = 'mx_oidc_';

/** What platform this build registers as (drives redirect-uri + registration policy). */
export type OidcApplicationType = 'web' | 'native';

/** Inputs for building an OIDC authorization request. */
export interface OidcAuthorizationParams {
  baseUrl: string;
  config: OidcClientConfig;
  redirectUri: string;
  applicationType: OidcApplicationType;
  /** A single-use nonce (also used as the id_token nonce). */
  nonce: string;
  /** OIDC `prompt` (e.g. `create` for registration); omitted for a normal login. */
  prompt?: string;
}

/**
 * The authorization URL to redirect to, plus the PKCE sign-in state the SDK persisted
 * in sessionStorage — returned so the caller can durably stash it (Preferences) and
 * re-seed it before completing the grant on a fresh/off-origin callback context.
 */
export interface OidcAuthorizationRequest {
  url: string;
  /** The provider-facing OAuth `state` oidc-client-ts generated (verified on callback). */
  state: string;
  /** The exact sessionStorage key holding the sign-in state (`mx_oidc_<state>`). */
  sessionStateKey: string;
  /** The serialized sign-in state (contains the PKCE code_verifier), or null if absent. */
  sessionStateBlob: string | null;
}

/** A completed OIDC login: tokens + resolved identity + the provider binding to persist. */
export interface OidcGrant {
  homeserverUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;
  oidc: OidcSessionBinding;
}

/**
 * Owns the matrix-js-sdk OIDC ("next-gen auth", MSC3861) orchestration: dynamic client
 * registration (cached per issuer), building the PKCE authorization URL, and exchanging
 * the returned code for tokens + identity. {@link AuthService} composes this with its
 * shared session-establishment funnel; components never touch it or the SDK directly.
 */
@Injectable({ providedIn: 'root' })
export class OidcClientService {
  /**
   * Build the authorization URL to redirect to. Registers this client with the provider
   * (dynamic registration, cached per issuer) if needed, generates a PKCE authorization
   * request, and harvests the sign-in state the SDK stored in sessionStorage.
   */
  buildAuthorizationRequest(
    params: OidcAuthorizationParams,
  ): Observable<OidcAuthorizationRequest> {
    return this.ensureClientId(params.config, params.applicationType, [
      params.redirectUri,
    ]).pipe(switchMap((clientId) => from(this.buildUrl(params, clientId))));
  }

  /**
   * Exchange the authorization `code` for tokens and resolve the account identity.
   * The caller MUST have re-seeded sessionStorage with the stashed sign-in state first,
   * so the SDK can read back the PKCE code_verifier. OIDC token responses carry no
   * user/device id, so we resolve them via `whoami`.
   */
  completeGrant(
    code: string,
    state: string,
    redirectUri: string,
  ): Observable<OidcGrant> {
    return defer(() => from(completeAuthorizationCodeGrant(code, state))).pipe(
      switchMap((grant) => {
        const token = grant.tokenResponse;
        return from(
          createClient({
            baseUrl: grant.homeserverUrl,
            accessToken: token.access_token,
          }).whoami(),
        ).pipe(
          map((who) => {
            if (!who.device_id) {
              throw new Error(
                'The provider returned no device for this session.',
              );
            }
            const expiresAt = this.expiresAt(token);
            const result: OidcGrant = {
              homeserverUrl: grant.homeserverUrl,
              userId: who.user_id,
              deviceId: who.device_id,
              accessToken: token.access_token,
              ...(token.refresh_token
                ? { refreshToken: token.refresh_token }
                : {}),
              ...(expiresAt !== undefined
                ? { accessTokenExpiresAt: expiresAt }
                : {}),
              oidc: {
                issuer: grant.oidcClientSettings.issuer,
                clientId: grant.oidcClientSettings.clientId,
                redirectUri,
                idTokenClaims: grant.idTokenClaims,
              },
            };
            return result;
          }),
        );
      }),
    );
  }

  /**
   * Revoke an account's tokens at the provider's revocation endpoint (RFC 7009), so a
   * sign-out invalidates the OAuth session at the source — not just locally. Best-effort:
   * discovery or a revocation POST failing must never block logout, so errors resolve to
   * void. Complements the CSAPI logout the caller also performs.
   *
   * `homeserverUrl` is the account's own `baseUrl`: discovery goes through the
   * homeserver's auth metadata, which is the provider config the session was actually
   * established against.
   */
  revokeTokens(
    homeserverUrl: string,
    binding: OidcSessionBinding,
    tokens: { accessToken?: string; refreshToken?: string },
  ): Observable<void> {
    return defer(() => from(this.revoke(homeserverUrl, binding, tokens))).pipe(
      catchError(() => of(undefined)),
    );
  }

  /**
   * Forget the cached dynamic-registration client id for an issuer, so the next login
   * re-registers instead of reusing an id the provider has rejected (e.g. `invalid_client`
   * after the provider pruned or expired the registration).
   */
  forgetClientId(issuer: string): Observable<void> {
    return defer(() =>
      from(Preferences.remove({ key: CLIENT_ID_KEY_PREFIX + issuer })),
    );
  }

  private async revoke(
    homeserverUrl: string,
    binding: OidcSessionBinding,
    tokens: { accessToken?: string; refreshToken?: string },
  ): Promise<void> {
    const config = await createClient({
      baseUrl: homeserverUrl,
    }).getAuthMetadata();
    const endpoint = config.revocation_endpoint;
    if (!endpoint) {
      return;
    }
    const revokeOne = (token: string, hint: string): Promise<unknown> =>
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token,
          token_type_hint: hint,
          client_id: binding.clientId,
        }).toString(),
      });
    const calls: Promise<unknown>[] = [];
    if (tokens.refreshToken) {
      calls.push(revokeOne(tokens.refreshToken, 'refresh_token'));
    }
    if (tokens.accessToken) {
      calls.push(revokeOne(tokens.accessToken, 'access_token'));
    }
    await Promise.all(calls);
  }

  /**
   * Resolve the dynamic-registration client id for an issuer, registering once and
   * caching it in Preferences so a later launch (or account) reuses it instead of
   * minting a fresh registration each time.
   */
  private ensureClientId(
    config: OidcClientConfig,
    applicationType: OidcApplicationType,
    redirectUris: string[],
  ): Observable<string> {
    return defer(() =>
      from(this.resolveClientId(config, applicationType, redirectUris)),
    );
  }

  private async resolveClientId(
    config: OidcClientConfig,
    applicationType: OidcApplicationType,
    redirectUris: string[],
  ): Promise<string> {
    const key = CLIENT_ID_KEY_PREFIX + config.issuer;
    const cached = (await Preferences.get({ key })).value;
    if (cached) {
      return cached;
    }
    const metadata: OidcRegistrationClientMetadata = {
      clientName: CLIENT_NAME,
      clientUri: CLIENT_URI,
      applicationType,
      redirectUris:
        redirectUris as OidcRegistrationClientMetadata['redirectUris'],
      contacts: undefined,
      tosUri: undefined,
      policyUri: undefined,
    };
    const clientId = await registerOidcClient(config, metadata);
    await Preferences.set({ key, value: clientId });
    return clientId;
  }

  private async buildUrl(
    params: OidcAuthorizationParams,
    clientId: string,
  ): Promise<OidcAuthorizationRequest> {
    const url = await generateOidcAuthorizationUrl({
      metadata: params.config,
      clientId,
      homeserverUrl: params.baseUrl,
      redirectUri: params.redirectUri,
      nonce: params.nonce,
      ...(params.prompt ? { prompt: params.prompt } : {}),
    });
    // oidc-client-ts mints its OWN `state` (not our nonce); read it back from the URL —
    // it both keys the stored sign-in state and is what the provider echoes on callback.
    const state = new URL(url).searchParams.get('state');
    if (!state) {
      throw new Error(
        'The OIDC authorization URL is missing a state parameter.',
      );
    }
    const harvested = this.harvestSigninState(state);
    return {
      url,
      state,
      sessionStateKey: harvested?.key ?? SIGNIN_STATE_PREFIX + state,
      sessionStateBlob: harvested?.blob ?? null,
    };
  }

  /**
   * Read back the sign-in state the SDK just wrote to sessionStorage for `state`. Prefers
   * the deterministic `mx_oidc_<state>` key but falls back to scanning for any `mx_oidc_*`
   * entry ending in the state, so a future change to the SDK's prefix can't silently break
   * the durable stash the cross-context callback depends on.
   */
  private harvestSigninState(
    state: string,
  ): { key: string; blob: string } | null {
    const store = globalThis.sessionStorage;
    if (!store) {
      return null;
    }
    const exactKey = SIGNIN_STATE_PREFIX + state;
    const exact = store.getItem(exactKey);
    if (exact !== null) {
      return { key: exactKey, blob: exact };
    }
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(SIGNIN_STATE_PREFIX) && key.endsWith(state)) {
        const blob = store.getItem(key);
        if (blob !== null) {
          return { key, blob };
        }
      }
    }
    return null;
  }

  /** Absolute epoch-ms access-token expiry: `expires_at` (epoch seconds) preferred. */
  private expiresAt(token: {
    expires_at?: number;
    expires_in?: number;
  }): number | undefined {
    if (typeof token.expires_at === 'number') {
      return token.expires_at * 1000;
    }
    if (typeof token.expires_in === 'number') {
      return Date.now() + token.expires_in * 1000;
    }
    return undefined;
  }
}
