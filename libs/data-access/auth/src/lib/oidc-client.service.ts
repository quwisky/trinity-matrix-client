import { Injectable, inject } from '@angular/core';
import {
  Observable,
  catchError,
  defer,
  firstValueFrom,
  from,
  map,
  of,
  switchMap,
  throwError,
} from 'rxjs';
import { DevicePreferenceStorageService } from '@trinity/platform-native';
import { HostAuthenticationHandoffService } from '@trinity/runtime/host';
import {
  OIDC_PROVIDER_MISMATCH,
  type OidcSessionBinding,
  unwrapEngineResult,
  verifiedDeviceGrantMetadata,
  verifiedEndpoints,
  type VerifiedEndpoints,
} from '@trinity/util/matrix';
import { AUTH_ENGINE } from './auth-engine.token';
import type { AuthMetadata } from './auth-metadata';
import { checkIssuer, checkSavedEndpoints } from './oidc-issuer-check';
import {
  OAuthGrantType,
  authorizationCodeUrl,
  isValidAuthMetadata,
  redeemAuthorizationCode,
  registerClient,
  revokeToken,
  type BearerTokenResponse,
  type OAuthClientMetadata,
} from './oauth-http';

/** Stable https identifier for the app (dynamic-registration `client_uri`). */
const CLIENT_URI = 'https://trinity.trinityproject.dev';
/**
 * Preferences key prefix for the dynamic-registration client id, cached per homeserver
 * and issuer ({@link clientIdKey}).
 * Versioned: a registration pins the redirect_uris it was created with, so changing the
 * redirect_uri we send strands every id cached under the old shape (the provider then
 * rejects the authorization with a redirect mismatch, which is NOT the `invalid_client`
 * that {@link OidcClientService.forgetClientId} recovers from). Bump on any change to
 * the registered metadata to force a clean re-registration.
 */
const CLIENT_ID_KEY_PREFIX = 'oidc.clientId.v4:';
/**
 * Preferences key prefix for the QR sign-in client id, cached per homeserver and issuer
 * apart from the PKCE client. Versioned like {@link CLIENT_ID_KEY_PREFIX}.
 */
const DEVICE_GRANT_CLIENT_ID_KEY_PREFIX = 'oidc.deviceGrantClientId.v2:';

/** What platform this build registers as (drives redirect-uri + registration policy). */
export type OidcApplicationType = 'web' | 'native';

/** Inputs for building an OIDC authorization request. */
export interface OidcAuthorizationParams {
  baseUrl: string;
  metadata: AuthMetadata;
  redirectUri: string;
  applicationType: OidcApplicationType;
  /** OIDC `prompt` (e.g. `create` for registration); omitted for a normal login. */
  prompt?: string;
  /**
   * Re-authenticate this existing device instead of minting a new one. Set only by the
   * re-auth flow, whose whole purpose is to recover a soft-logged-out account WITHOUT
   * the user having to verify a fresh device again.
   */
  deviceId?: string;
}

/**
 * The authorization URL to redirect to, plus the PKCE context needed to complete the
 * grant afterwards.
 *
 * Nothing here persists it, so the caller is the sole custodian of the context: it must
 * be stashed durably (Preferences) and fed back to {@link OidcClientService.completeGrant},
 * which lets a callback complete in a different browsing context (native / Electron) or
 * after a cold-start relaunch.
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

/**
 * The PKCE context recovered from the stash, needed to exchange the code for tokens, plus
 * the callback's `iss`.
 */
export interface OidcGrantContext {
  baseUrl: string;
  redirectUri: string;
  clientId: string;
  deviceId: string;
  codeVerifier: string;
  /** The issuer the sign-in started with. The callback and the metadata must name it. */
  issuer: string;
  /**
   * The endpoints checked before the redirect. The code is redeemed at `tokenEndpoint`,
   * and the homeserver's metadata must still name all of them.
   */
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  /** The callback's RFC 9207 `iss` parameter, when the provider sent one. */
  iss?: string;
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
 * Owns the OIDC ("next-gen auth", MSC3861) orchestration: dynamic client registration,
 * building the PKCE authorization URL, and exchanging the returned code for tokens +
 * identity. The OAuth 2.0 requests are plain HTTP to the provider (`oauth-http.ts`); only
 * the homeserver's auth metadata and `whoami` go through the {@link AUTH_ENGINE}.
 * {@link AuthService} composes this with its Account Runtime establishment command;
 * components never touch it directly.
 */
@Injectable({ providedIn: 'root' })
export class OidcClientService {
  private readonly storage = inject(DevicePreferenceStorageService);
  /** Names the client after the host app; Trinity Next keeps its ids in its own storage. */
  private readonly handoff = inject(HostAuthenticationHandoffService);
  private readonly engine = inject(AUTH_ENGINE);

  /**
   * Build the authorization URL to redirect to. Registers this client with the provider
   * if needed (cached per homeserver and issuer), generates a PKCE authorization request,
   * and returns the context the callback needs, which the caller must stash.
   */
  buildAuthorizationRequest(
    params: OidcAuthorizationParams,
  ): Observable<OidcAuthorizationRequest> {
    return defer(() => {
      const { metadata } = params;
      // Only the engine's auth metadata reaches here, and it passed this check already.
      if (!isValidAuthMetadata(metadata)) {
        throw new Error(OIDC_PROVIDER_MISMATCH);
      }
      return this.ensureClientId(
        params.baseUrl,
        metadata,
        params.applicationType,
        [params.redirectUri],
      ).pipe(
        switchMap((clientId) =>
          from(this.buildUrl(params, metadata, clientId)),
        ),
      );
    });
  }

  /**
   * Exchange the authorization `code` for tokens and resolve the account identity.
   *
   * `context` is the stash written when the request was built; it holds the only copy of
   * the PKCE verifier. `baseUrl` is passed because the homeserver is not round-tripped
   * through OAuth state.
   *
   * Token responses carry no user/device id, so identity comes from `whoami`.
   */
  completeGrant(
    code: string,
    context: OidcGrantContext,
  ): Observable<OidcGrant> {
    return defer(() => from(this.exchange(code, context))).pipe(
      switchMap(({ token, metadata, endpoints, requestedAt }) =>
        this.engine.whoami(context.baseUrl, token.access_token).pipe(
          unwrapEngineResult(),
          map((who) => {
            if (!who.deviceId) {
              throw new Error(
                'The provider returned no device for this session.',
              );
            }
            const expiresAt = this.expiresAt(token, requestedAt);
            const result: OidcGrant = {
              homeserverUrl: context.baseUrl,
              userId: who.userId,
              deviceId: who.deviceId,
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
                ...endpoints,
              },
            };
            return result;
          }),
          // Live tokens exist and, under MSC3861, the OAuth session IS the Matrix device.
          // The code is spent and the caller has already cleared the stash, so this grant is
          // unrecoverable; without a revocation the provider is left holding a ghost device
          // and a long-lived refresh token nothing will use, one more per retry.
          //
          // DETACHED on purpose. These POSTs go to the provider, not the homeserver that
          // just failed, with no AbortSignal or timeout. Gating the error on them would hold
          // the callback page on its spinner (its only exit is the error branch) for a full
          // TCP connect timeout, or forever against a host that black-holes the connection.
          // Nothing consumes the result, so the user gets the real failure now.
          catchError((err: unknown) => {
            const { revocationEndpoint } = endpoints;
            if (revocationEndpoint) {
              void this.revokeBoth(revocationEndpoint, context.clientId, {
                accessToken: token.access_token,
                refreshToken: token.refresh_token,
              }).catch(() => undefined);
            }
            return throwError(() => err);
          }),
        ),
      ),
    );
  }

  private async exchange(
    code: string,
    context: OidcGrantContext,
  ): Promise<{
    token: BearerTokenResponse;
    metadata: AuthMetadata;
    endpoints: VerifiedEndpoints;
    requestedAt: number;
  }> {
    const metadata = await this.liveMetadata(context.baseUrl);
    // Check that the sign-in response comes from the provider it started with before the
    // code or the verifier is sent anywhere.
    checkIssuer(metadata, context);
    checkSavedEndpoints(metadata, context);
    const verified = await verifiedEndpoints(metadata);
    const endpoints: VerifiedEndpoints = {
      tokenEndpoint: context.tokenEndpoint,
      ...(verified.revocationEndpoint
        ? {
            revocationEndpoint:
              context.revocationEndpoint ?? verified.revocationEndpoint,
          }
        : {}),
    };
    // Stamped BEFORE the POST: `expires_in` is relative to when the provider issued the
    // token, so measuring from after a slow round-trip would over-state the lifetime.
    const requestedAt = Date.now();
    // Redeemed at the token endpoint saved before the redirect, never a re-fetched one.
    const token = await redeemAuthorizationCode(endpoints.tokenEndpoint, {
      clientId: context.clientId,
      codeVerifier: context.codeVerifier,
      redirectUri: context.redirectUri,
      code,
    });
    return { token, metadata, endpoints, requestedAt };
  }

  /** The homeserver's auth metadata now; throws unless it names a valid OAuth 2.0 provider. */
  private async liveMetadata(baseUrl: string): Promise<AuthMetadata> {
    const metadata = await firstValueFrom(
      this.engine.authMetadata(baseUrl).pipe(unwrapEngineResult()),
    );
    if (!metadata || !isValidAuthMetadata(metadata)) {
      throw new Error(OIDC_PROVIDER_MISMATCH);
    }
    return metadata;
  }

  /**
   * Revoke an account's tokens at the provider's revocation endpoint (RFC 7009), so a
   * sign-out invalidates the OAuth session at the source — not just locally. Best-effort:
   * discovery or a revocation POST failing must never block logout, so errors resolve to
   * void. Complements the CSAPI logout the caller also performs.
   *
   * Revokes at the endpoint pinned at sign-in. A binding saved before endpoints were
   * pinned takes it from the auth metadata of `homeserverUrl` (the account's own
   * `baseUrl`), only while that names the binding's issuer and agrees with the issuer's
   * own document, which must confirm it once it has disagreed.
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
   * Forget the cached dynamic-registration client id for a homeserver's issuer, so the
   * next login re-registers instead of reusing an id the provider has rejected (e.g.
   * `invalid_client` after the provider pruned or expired the registration). Only
   * `rejectedClientId` is forgotten.
   */
  forgetClientId(
    baseUrl: string,
    issuer: string,
    rejectedClientId: string,
  ): Observable<void> {
    const key = clientIdKey(baseUrl, issuer);
    // Compare-and-delete: a registration made since, by another sign-in, stays.
    return this.storage
      .get(key)
      .pipe(
        switchMap((cached) =>
          cached === rejectedClientId
            ? this.storage.remove(key)
            : of(undefined),
        ),
      );
  }

  /**
   * The client id QR sign-in uses for the device grant, registered apart from the PKCE
   * client and cached per homeserver and issuer.
   */
  deviceGrantClientId(
    metadata: AuthMetadata,
    homeserverUrl: string,
  ): Observable<string> {
    return defer(() =>
      from(this.resolveDeviceGrantClientId(metadata, homeserverUrl)),
    );
  }

  /** Forget the device-grant client id, so the next sign-in registers a new one. */
  forgetDeviceGrantClientId(
    metadata: AuthMetadata,
    homeserverUrl: string,
  ): Observable<void> {
    return this.storage.remove(
      clientIdKey(
        homeserverUrl,
        metadata.issuer,
        DEVICE_GRANT_CLIENT_ID_KEY_PREFIX,
      ),
    );
  }

  /**
   * The binding for a device-grant session, pinned to the endpoints the issuer's own
   * document confirms, as for a PKCE sign-in.
   */
  deviceGrantBinding(
    metadata: AuthMetadata,
    clientId: string,
  ): Observable<OidcSessionBinding> {
    return defer(() => from(verifiedEndpoints(metadata))).pipe(
      map(({ tokenEndpoint, revocationEndpoint }) => ({
        issuer: metadata.issuer,
        clientId,
        tokenEndpoint,
        ...(revocationEndpoint ? { revocationEndpoint } : {}),
      })),
    );
  }

  /**
   * The metadata the device grant runs on: its token and device endpoints are the ones the
   * issuer's own document confirms, or on the issuer's own origin. Errors otherwise.
   */
  deviceGrantMetadata<M extends AuthMetadata>(metadata: M): Observable<M> {
    return defer(() => from(verifiedDeviceGrantMetadata(metadata)));
  }

  private async resolveDeviceGrantClientId(
    metadata: AuthMetadata,
    homeserverUrl: string,
  ): Promise<string> {
    const key = clientIdKey(
      homeserverUrl,
      metadata.issuer,
      DEVICE_GRANT_CLIENT_ID_KEY_PREFIX,
    );
    const cached = await firstValueFrom(this.storage.get(key));
    if (cached) {
      return cached;
    }
    const clientId = await registerClient(metadata, {
      client_name: this.handoff.deviceDisplayName(),
      client_uri: CLIENT_URI,
      application_type: 'web',
      // The device grant never redirects, but providers require a redirect URI, and
      // Tuwunel accepts only https.
      redirect_uris: [`${CLIENT_URI}/sso-callback`],
      // Tuwunel registers no client without the authorization-code and refresh grants.
      grant_types: [
        OAuthGrantType.AuthorizationCode,
        OAuthGrantType.RefreshToken,
        OAuthGrantType.DeviceAuthorization,
      ],
    });
    await firstValueFrom(this.storage.set(key, clientId));
    return clientId;
  }

  private async revoke(
    homeserverUrl: string,
    binding: OidcSessionBinding,
    tokens: { accessToken?: string; refreshToken?: string },
  ): Promise<void> {
    const revocationEndpoint =
      binding.revocationEndpoint ??
      (await this.unpinnedRevocationEndpoint(homeserverUrl, binding));
    if (!revocationEndpoint) return;
    await this.revokeBoth(revocationEndpoint, binding.clientId, tokens);
  }

  /**
   * The revocation endpoint for a binding saved before endpoints were pinned, chosen as a
   * refresh pins it: the issuer's own where its document agrees, else the homeserver's
   * unless the issuer must confirm it. Throws when the homeserver names another issuer or
   * the endpoint is not confirmed; undefined when no revocation endpoint is usable.
   */
  private async unpinnedRevocationEndpoint(
    homeserverUrl: string,
    binding: OidcSessionBinding,
  ): Promise<string | undefined> {
    const live = await this.liveMetadata(homeserverUrl);
    if (live.issuer !== binding.issuer) {
      console.warn(
        `Not revoking tokens: the homeserver now names issuer ${live.issuer}, not ${binding.issuer}`,
      );
      throw new Error('The homeserver names another issuer.');
    }
    const { revocationEndpoint } = await verifiedEndpoints(
      live,
      binding.requiresIssuerConfirmation,
    );
    return revocationEndpoint;
  }

  /** POST a revocation for each token present. Concurrent: neither gates the other. */
  private async revokeBoth(
    revocationEndpoint: string,
    clientId: string,
    tokens: { accessToken?: string; refreshToken?: string },
  ): Promise<void> {
    const calls: Promise<void>[] = [];
    if (tokens.refreshToken) {
      calls.push(
        revokeToken(
          revocationEndpoint,
          clientId,
          tokens.refreshToken,
          'refresh_token',
        ),
      );
    }
    if (tokens.accessToken) {
      calls.push(
        revokeToken(
          revocationEndpoint,
          clientId,
          tokens.accessToken,
          'access_token',
        ),
      );
    }
    await Promise.all(calls);
  }

  /**
   * Resolve the dynamic-registration client id for a homeserver's issuer, registering
   * once and caching it in Preferences so a later launch (or account) reuses it instead
   * of minting a fresh registration each time.
   */
  private ensureClientId(
    baseUrl: string,
    metadata: AuthMetadata,
    applicationType: OidcApplicationType,
    redirectUris: string[],
  ): Observable<string> {
    return defer(() =>
      from(
        this.resolveClientId(baseUrl, metadata, applicationType, redirectUris),
      ),
    );
  }

  private async resolveClientId(
    baseUrl: string,
    metadata: AuthMetadata,
    applicationType: OidcApplicationType,
    redirectUris: string[],
  ): Promise<string> {
    const key = clientIdKey(baseUrl, metadata.issuer);
    const cached = await firstValueFrom(this.storage.get(key));
    if (cached) {
      return cached;
    }
    // The fields a provider pins a later authorization against (redirect_uris,
    // application_type, client_uri) need a bump of the key prefix when they change.
    const request: OAuthClientMetadata = {
      client_name: this.handoff.deviceDisplayName(),
      client_uri: CLIENT_URI,
      application_type: applicationType,
      redirect_uris: redirectUris,
    };
    const clientId = await registerClient(metadata, request);
    await firstValueFrom(this.storage.set(key, clientId));
    return clientId;
  }

  private async buildUrl(
    params: OidcAuthorizationParams,
    metadata: AuthMetadata,
    clientId: string,
  ): Promise<OidcAuthorizationRequest> {
    // The `state` is ours to mint: the provider echoes it on callback and the stash is
    // keyed on it.
    const state = crypto.randomUUID();
    const { url, deviceId, codeVerifier } = await authorizationCodeUrl(
      metadata,
      {
        clientId,
        redirectUri: params.redirectUri,
        state,
        // Omitted for a normal login, where a new device is minted.
        ...(params.deviceId ? { deviceId: params.deviceId } : {}),
        ...(params.prompt ? { prompt: params.prompt } : {}),
      },
    );
    return { url, state, clientId, deviceId, codeVerifier };
  }

  /**
   * Absolute epoch-ms access-token expiry, measured from `requestedAt` (stamped before
   * the token POST). The token response carries only the relative `expires_in`.
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

/**
 * The cache key for a client id. The homeserver is part of it because the homeserver
 * chooses the issuer it names: keyed on the issuer alone, one homeserver could leave a
 * client id that another homeserver's sign-in to the same issuer reuses. A URL has no
 * space, so the first space separates the two.
 */
function clientIdKey(
  baseUrl: string,
  issuer: string,
  prefix = CLIENT_ID_KEY_PREFIX,
): string {
  return `${prefix}${baseUrl} ${issuer}`;
}
