import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import {
  OAuth2,
  createClient,
  type BearerTokenResponse,
  type OAuthRegistrationRequest,
  type ValidatedAuthMetadata,
} from 'matrix-js-sdk';
import {
  Observable,
  catchError,
  defer,
  from,
  map,
  of,
  switchMap,
  throwError,
} from 'rxjs';
import type { OidcSessionBinding } from '@trinity/util/matrix';

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

/** What platform this build registers as (drives redirect-uri + registration policy). */
export type OidcApplicationType = 'web' | 'native';

/** Inputs for building an OIDC authorization request. */
export interface OidcAuthorizationParams {
  baseUrl: string;
  metadata: ValidatedAuthMetadata;
  redirectUri: string;
  applicationType: OidcApplicationType;
  /** OIDC `prompt` (e.g. `create` for registration); omitted for a normal login. */
  prompt?: string;
  /**
   * Re-authenticate this existing device instead of minting a new one. Set only by the
   * re-auth flow, whose whole purpose is to recover a soft-logged-out account WITHOUT
   * the user having to verify a fresh device again. matrix-js-sdk 41 could not express
   * this — `generateOidcAuthorizationUrl` took no device id and always generated one —
   * so an OIDC re-auth silently produced a new device; v42's OAuth2 context accepts one.
   */
  deviceId?: string;
}

/**
 * The authorization URL to redirect to, plus the PKCE context needed to complete the
 * grant afterwards.
 *
 * The SDK used to keep this itself, in a `mx_oidc_<state>` sessionStorage entry written
 * by oidc-client-ts. matrix-js-sdk 42 dropped that dependency and persists nothing, so
 * the context is handed back here and the caller is now its sole custodian: it must be
 * stashed durably (Preferences) and fed back to {@link OidcClientService.completeGrant},
 * which is what lets a callback complete in a different browsing context (native /
 * Electron) or after a cold-start relaunch.
 */
export interface OidcAuthorizationRequest {
  url: string;
  /** The provider-facing OAuth `state`, echoed on callback and verified against the stash. */
  state: string;
  clientId: string;
  deviceId: string;
  /** SECRET. The PKCE code_verifier; single-use, and never logged. */
  codeVerifier: string;
}

/** The PKCE context recovered from the stash, needed to exchange the code for tokens. */
export interface OidcGrantContext {
  baseUrl: string;
  redirectUri: string;
  clientId: string;
  deviceId: string;
  codeVerifier: string;
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
   * request, and returns the context the callback needs to complete it — the SDK keeps
   * none of it, so the caller must stash what comes back.
   */
  buildAuthorizationRequest(
    params: OidcAuthorizationParams,
  ): Observable<OidcAuthorizationRequest> {
    return this.ensureClientId(params.metadata, params.applicationType, [
      params.redirectUri,
    ]).pipe(switchMap((clientId) => from(this.buildUrl(params, clientId))));
  }

  /**
   * Exchange the authorization `code` for tokens and resolve the account identity.
   *
   * `context` is the stash written when the request was built: the SDK no longer keeps
   * the PKCE verifier anywhere, so rebuilding an {@link OAuth2} around the same context
   * is what makes the exchange possible at all. `baseUrl` is passed rather than recovered
   * from the grant because v42 no longer round-trips the homeserver through OAuth state.
   *
   * Token responses carry no user/device id, so identity comes from `whoami`.
   */
  completeGrant(
    code: string,
    context: OidcGrantContext,
  ): Observable<OidcGrant> {
    return defer(() => from(this.exchange(code, context))).pipe(
      switchMap(({ token, metadata, requestedAt }) =>
        from(
          createClient({
            baseUrl: context.baseUrl,
            accessToken: token.access_token,
          }).whoami(),
        ).pipe(
          map((who) => {
            if (!who.device_id) {
              throw new Error(
                'The provider returned no device for this session.',
              );
            }
            const expiresAt = this.expiresAt(token, requestedAt);
            const result: OidcGrant = {
              homeserverUrl: context.baseUrl,
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
                issuer: metadata.issuer,
                clientId: context.clientId,
                redirectUri: context.redirectUri,
              },
            };
            return result;
          }),
          // The exchange succeeded, so live tokens exist — and under MSC3861 the OAuth
          // session IS the Matrix device. The code is spent and the caller has already
          // cleared the stash, so this grant is unrecoverable; without a revocation the
          // provider is left holding a ghost device and a long-lived refresh token that
          // nothing will ever use, one more per retry. Best-effort, and the ORIGINAL
          // failure is what propagates: a revocation error must not displace it.
          catchError((err: unknown) =>
            from(
              this.revokeGranted(metadata, context, token).catch(
                () => undefined,
              ),
            ).pipe(switchMap(() => throwError(() => err))),
          ),
        ),
      ),
    );
  }

  private async exchange(
    code: string,
    context: OidcGrantContext,
  ): Promise<{
    token: BearerTokenResponse;
    metadata: ValidatedAuthMetadata;
    requestedAt: number;
  }> {
    const metadata = await createClient({
      baseUrl: context.baseUrl,
    }).getAuthMetadata();
    const auth = new OAuth2(metadata, {
      clientId: context.clientId,
      redirectUri: context.redirectUri,
      codeVerifier: context.codeVerifier,
      deviceId: context.deviceId,
    });
    // Stamped BEFORE the POST: `expires_in` is relative to when the provider issued the
    // token, so measuring from after a slow round-trip would over-state the lifetime.
    const requestedAt = Date.now();
    const token = await auth.completeAuthorizationCodeGrant(code);
    return { token, metadata, requestedAt };
  }

  /** Hand back tokens from a grant that succeeded but could not be turned into a session. */
  private revokeGranted(
    metadata: ValidatedAuthMetadata,
    context: OidcGrantContext,
    token: BearerTokenResponse,
  ): Promise<void> {
    const auth = new OAuth2(metadata, {
      clientId: context.clientId,
      redirectUri: context.redirectUri,
    });
    return this.revokeBoth(auth, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
    });
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
    const metadata = await createClient({
      baseUrl: homeserverUrl,
    }).getAuthMetadata();
    // The RFC 7009 POST used to be hand-rolled here because the SDK exposed no revocation
    // helper. It does now, and `revocation_endpoint` is required on ValidatedAuthMetadata,
    // so the old "no endpoint, give up quietly" guard is gone with it.
    const auth = new OAuth2(metadata, {
      clientId: binding.clientId,
      redirectUri: binding.redirectUri,
    });
    await this.revokeBoth(auth, tokens);
  }

  /** POST a revocation for each token present. Concurrent: neither gates the other. */
  private async revokeBoth(
    auth: OAuth2,
    tokens: { accessToken?: string; refreshToken?: string },
  ): Promise<void> {
    const calls: Promise<void>[] = [];
    if (tokens.refreshToken) {
      calls.push(auth.revokeToken(tokens.refreshToken, 'refresh_token'));
    }
    if (tokens.accessToken) {
      calls.push(auth.revokeToken(tokens.accessToken, 'access_token'));
    }
    await Promise.all(calls);
  }

  /**
   * Resolve the dynamic-registration client id for an issuer, registering once and
   * caching it in Preferences so a later launch (or account) reuses it instead of
   * minting a fresh registration each time.
   */
  private ensureClientId(
    metadata: ValidatedAuthMetadata,
    applicationType: OidcApplicationType,
    redirectUris: string[],
  ): Observable<string> {
    return defer(() =>
      from(this.resolveClientId(metadata, applicationType, redirectUris)),
    );
  }

  private async resolveClientId(
    metadata: ValidatedAuthMetadata,
    applicationType: OidcApplicationType,
    redirectUris: string[],
  ): Promise<string> {
    const key = CLIENT_ID_KEY_PREFIX + metadata.issuer;
    const cached = (await Preferences.get({ key })).value;
    if (cached) {
      return cached;
    }
    // snake_case in v42 (the registration request is now the wire shape verbatim);
    // v41 took a camelCase wrapper. The fields a provider pins a later authorization
    // against — redirect_uris, application_type, client_uri — are otherwise unchanged,
    // which is why the cache key above does NOT need a version bump.
    const request: OAuthRegistrationRequest = {
      client_name: CLIENT_NAME,
      client_uri: CLIENT_URI,
      application_type: applicationType,
      redirect_uris: redirectUris as OAuthRegistrationRequest['redirect_uris'],
    };
    const clientId = await OAuth2.registerClient(metadata, request);
    await Preferences.set({ key, value: clientId });
    return clientId;
  }

  private async buildUrl(
    params: OidcAuthorizationParams,
    clientId: string,
  ): Promise<OidcAuthorizationRequest> {
    const auth = new OAuth2(params.metadata, {
      clientId,
      redirectUri: params.redirectUri,
      // Omitted for a normal login, where OAuth2 mints one (`?? secureRandomString(10)`).
      ...(params.deviceId ? { deviceId: params.deviceId } : {}),
    });
    // The `state` is ours to mint now — v41 let oidc-client-ts generate one and we read
    // it back out of the URL. It is what the provider echoes on callback and what the
    // stash is keyed on.
    const state = crypto.randomUUID();
    // 'query' is LOAD-BEARING. v42 defaults responseMode to 'fragment'; v41 defaulted to
    // 'query'. Every callback reader here takes query params only (sso-callback.page.ts
    // via queryParamMap, app.component.ts via searchParams), so accepting the default
    // would put the code somewhere nothing looks and hang the login on every platform.
    // Moving to 'fragment' (it keeps the code out of server logs) means teaching both
    // readers to parse a fragment first — a separate change.
    const url = await auth.generateAuthorizationCodeGrantUrl(
      state,
      'query',
      params.prompt,
    );
    return {
      url,
      state,
      clientId,
      deviceId: auth.context.deviceId,
      codeVerifier: auth.context.codeVerifier,
    };
  }

  /**
   * Absolute epoch-ms access-token expiry, measured from `requestedAt` (stamped before
   * the token POST). v42's BearerTokenResponse carries only the relative `expires_in`;
   * the old absolute `expires_at` branch went with oidc-client-ts.
   */
  private expiresAt(
    token: BearerTokenResponse,
    requestedAt: number,
  ): number | undefined {
    return typeof token.expires_in === 'number'
      ? requestedAt + token.expires_in * 1000
      : undefined;
  }
}
