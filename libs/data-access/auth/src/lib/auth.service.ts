import { Injectable, inject } from '@angular/core';
import {
  AutoDiscovery,
  createClient,
  type AuthDict,
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
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  AccountRuntimeService,
  type AccountEstablishmentOutcome,
} from '@trinity/data-access/accounts';
import {
  SessionStorageService,
  getTrinityDesktopBridge,
} from '@trinity/platform-native';
import {
  UiaCancelledError,
  runPasswordUia,
  type PasswordPrompt,
} from '@trinity/util/matrix';
import {
  OidcClientService,
  type OidcAuthorizationParams,
  type OidcAuthorizationRequest,
  type OidcGrant,
  type OidcGrantContext,
} from './oidc-client.service';
import {
  accountEstablishment,
  type AuthenticatedSessionResponse,
  type LoginMode,
} from './account-establishment';

export type { LoginMode } from './account-establishment';
export type { AccountEstablishmentOutcome } from '@trinity/data-access/accounts';

const DEVICE_DISPLAY_NAME = 'Trinity';

/** The active OIDC account's provider-hosted account-management surface. */
export interface AccountManagement {
  /** The provider's account-management URL (validated https). */
  url: string;
  /** MSC2965 actions the provider supports deep-linking to (e.g. session management). */
  actionsSupported: string[];
}

/**
 * Handles homeserver discovery and authentication exchanges. Successful login methods
 * issue an opaque Account grant to Account Runtime, which owns persistence and startup.
 *
 * Components talk to this service, never to matrix-js-sdk directly. Async APIs are
 * cold Observables.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly matrix = inject(MatrixClientService);
  private readonly storage = inject(SessionStorageService);
  private readonly oidc = inject(OidcClientService);
  private readonly accounts = inject(AccountRuntimeService);

  /**
   * Resolve a homeserver base URL from a user-entered domain (e.g. "matrix.org"
   * or "@me:example.org" -> "example.org") via .well-known auto-discovery.
   * Falls back to https://<domain> when discovery is silent.
   */
  discoverHomeserver(input: string): Observable<string> {
    const domain = this.extractDomain(input);
    return defer(() => {
      // Desktop: let main's CORS shim serve this origin. Discovery reaches a server
      // BEFORE any account exists to declare it — `.well-known` on the typed domain,
      // then the SDK validates the resolved base_url. Both are allowed here; the next
      // account change replaces the whole set, so a probe of a server the user never
      // signs into is dropped rather than lingering.
      this.allowCorsOrigin(`https://${domain}`);
      return from(AutoDiscovery.findClientConfig(domain));
    }).pipe(
      map((config) => {
        const hs = config['m.homeserver'];
        if (
          hs.state === AutoDiscovery.FAIL_PROMPT ||
          hs.state === AutoDiscovery.FAIL_ERROR
        ) {
          const reason = typeof hs.error === 'string' ? hs.error : null;
          throw new Error(
            reason ?? `Could not discover a homeserver for "${domain}".`,
          );
        }
        const baseUrl = (hs.base_url ?? `https://${domain}`).replace(/\/$/, '');
        // The resolved homeserver may be a different origin than the typed domain, and
        // login POSTs to it before the account exists.
        this.allowCorsOrigin(baseUrl);
        return baseUrl;
      }),
    );
  }

  /** Which login flows the homeserver supports (e.g. 'm.login.password', 'm.login.sso'). */
  getSupportedFlows(baseUrl: string): Observable<string[]> {
    return defer(() => from(createClient({ baseUrl }).loginFlows())).pipe(
      map((res) => res.flows.map((f) => f.type)),
    );
  }

  /**
   * Discover a homeserver's delegated OIDC ("next-gen auth", MSC2965) provider config,
   * or `null` when the homeserver doesn't delegate authentication. `getAuthMetadata()`
   * throws on a non-OIDC homeserver, so we map that to `null` — letting the login page
   * probe for OIDC in parallel with {@link getSupportedFlows} without a legacy
   * homeserver ever being slowed or broken by the extra round-trip.
   */
  getDelegatedAuthConfig(
    baseUrl: string,
  ): Observable<ValidatedAuthMetadata | null> {
    return defer(() => from(createClient({ baseUrl }).getAuthMetadata())).pipe(
      catchError(() => of(null)),
    );
  }

  /**
   * Log in with username + password. `replace` (default) makes it the sole account;
   * `add` keeps the other signed-in accounts and adds this one alongside. Passing
   * `deviceId` re-authenticates that EXISTING device (re-auth of a soft-logged-out
   * account) so its crypto store is reused and no re-verification is needed.
   */
  loginWithPassword(
    baseUrl: string,
    user: string,
    password: string,
    mode: LoginMode = 'replace',
    deviceId?: string,
  ): Observable<AccountEstablishmentOutcome> {
    return defer(() =>
      from(
        createClient({ baseUrl }).loginRequest({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: this.localpart(user) },
          password,
          initial_device_display_name: DEVICE_DISPLAY_NAME,
          ...(deviceId ? { device_id: deviceId } : {}),
        }),
      ),
    ).pipe(switchMap((res) => this.establish(baseUrl, res, mode)));
  }

  /**
   * Ask the Electron main process to serve `origin` through its CORS shim (see
   * electron/src/cors.ts). A no-op off desktop, where the bridge is absent.
   */
  private allowCorsOrigin(origin: string): void {
    getTrinityDesktopBridge()?.cors?.allowOrigin(origin);
  }

  /** Build the SSO redirect URL the browser/WebView should navigate to. */
  getSsoUrl(baseUrl: string, redirectUrl: string): string {
    return createClient({ baseUrl }).getSsoLoginUrl(redirectUrl, 'sso');
  }

  /**
   * Complete an SSO/CAS login by exchanging the returned `loginToken` for a session.
   * Called from the SSO callback route after the homeserver redirects back.
   */
  completeSsoLogin(
    baseUrl: string,
    loginToken: string,
    mode: LoginMode = 'replace',
    deviceId?: string,
  ): Observable<AccountEstablishmentOutcome> {
    return defer(() =>
      from(
        createClient({ baseUrl }).loginRequest({
          type: 'm.login.token',
          token: loginToken,
          initial_device_display_name: DEVICE_DISPLAY_NAME,
          ...(deviceId ? { device_id: deviceId } : {}),
        }),
      ),
    ).pipe(switchMap((res) => this.establish(baseUrl, res, mode)));
  }

  /**
   * Build the OIDC ("next-gen auth") authorization URL to redirect to, plus the PKCE
   * sign-in state the caller must durably stash so a cold-start / off-origin callback
   * can complete the grant. Thin facade over {@link OidcClientService}.
   */
  buildOidcAuthorizationRequest(
    params: OidcAuthorizationParams,
  ): Observable<OidcAuthorizationRequest> {
    return this.oidc.buildAuthorizationRequest(params);
  }

  /**
   * Forget the cached dynamic-registration client id for an issuer so the next login
   * re-registers — called when the provider rejects the id (`invalid_client`), which
   * would otherwise wedge login until app storage is wiped.
   */
  forgetOidcClientId(issuer: string): Observable<void> {
    return this.oidc.forgetClientId(issuer);
  }

  /**
   * Complete an OIDC login: exchange the returned `code` for tokens, resolve the
   * account identity, and establish the session. Called from the callback route after
   * the provider redirects back (and after the stashed sign-in state was re-seeded).
   * `redirectUri` is the one used to build the request — needed to rebuild the token
   * refresher on restore.
   *
   * `expectedUserId` is set only by re-auth, and is what binds the grant to the account
   * the user asked to reconnect — see {@link rejectMismatchedGrant}.
   */
  completeOidcLogin(
    code: string,
    context: OidcGrantContext,
    mode: LoginMode = 'replace',
    expectedUserId: string | null = null,
  ): Observable<AccountEstablishmentOutcome> {
    return this.oidc.completeGrant(code, context).pipe(
      switchMap((grant) => this.rejectMismatchedGrant(grant, expectedUserId)),
      switchMap((grant) =>
        this.establish(
          grant.homeserverUrl,
          {
            user_id: grant.userId,
            device_id: grant.deviceId,
            access_token: grant.accessToken,
            refresh_token: grant.refreshToken,
            accessTokenExpiresAt: grant.accessTokenExpiresAt,
            oidc: grant.oidc,
          },
          mode,
        ),
      ),
    );
  }

  /**
   * Refuse a grant that came back as someone other than the account being re-authenticated.
   *
   * A re-auth puts the stored account's device id in the requested scope, and sends no
   * `prompt=login` — so a provider already holding a browser session authorizes with no
   * user interaction at all. On a homeserver where the user has two accounts, "sign in
   * again to reconnect this account" can therefore return the OTHER one, and nothing in
   * the token response identifies who it belongs to (identity comes from `whoami`).
   * Persisting it would file that account under this one's device id, at which point
   * `upsert` sees the device change and reclaims its live crypto store — forcing
   * re-verification of an account the user never touched.
   *
   * The tokens are already live, so hand them back. Detached: revocation reaches the
   * provider with no timeout, and the user needs the explanation now, not after it.
   */
  private rejectMismatchedGrant(
    grant: OidcGrant,
    expectedUserId: string | null,
  ): Observable<OidcGrant> {
    if (!expectedUserId || grant.userId === expectedUserId) {
      return of(grant);
    }
    this.oidc
      .revokeTokens(grant.homeserverUrl, grant.oidc, {
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
      })
      .subscribe({ error: () => undefined });
    return throwError(
      () =>
        new Error(
          `Your provider signed you in as ${grant.userId}, not ${expectedUserId}. ` +
            'Sign in to that account instead.',
        ),
    );
  }

  /**
   * The active account's provider-hosted account management, or `null` when it isn't an
   * OIDC account (or the provider exposes none). OIDC-native servers own credentials +
   * device management at the provider, so the in-app password form is replaced by a link
   * to this URL. The URL is validated as https before it is surfaced (it comes from
   * homeserver-controlled metadata, so a non-https value is rejected, not opened).
   */
  getAccountManagement(): Observable<AccountManagement | null> {
    return this.storage.load().pipe(
      switchMap((session) => {
        if (!session?.oidc) {
          return of(null);
        }
        return this.getDelegatedAuthConfig(session.baseUrl).pipe(
          map((config) => {
            const url = config?.account_management_uri;
            if (!url || !/^https:\/\//i.test(url)) {
              return null;
            }
            return {
              url,
              actionsSupported:
                config?.account_management_actions_supported ?? [],
            };
          }),
        );
      }),
    );
  }

  /**
   * Change the active account's password. Cold — runs on subscribe. The homeserver
   * requires a user-interactive-auth (UIA) password stage, which we satisfy with the
   * supplied `currentPassword` via {@link runPasswordUia}; a rejected password surfaces
   * as a clear "incorrect password" error rather than a raw UIA failure. Other sessions
   * are kept signed in (`logoutDevices: false`).
   */
  changePassword(
    currentPassword: string,
    newPassword: string,
  ): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      const client = this.matrix.instance;
      let provided = false;
      const promptPassword: PasswordPrompt = () => {
        // A second prompt means the server rejected the first — bail rather than loop.
        if (provided) {
          return Promise.resolve(null);
        }
        provided = true;
        return Promise.resolve(currentPassword);
      };
      return from(
        runPasswordUia(
          (auth) =>
            client.setPassword(auth ?? ({} as AuthDict), newPassword, false),
          promptPassword,
          client.getUserId() ?? '',
        ),
      ).pipe(
        map(() => void 0),
        catchError((err) =>
          throwError(() =>
            err instanceof UiaCancelledError
              ? new Error('Your current password is incorrect.')
              : err,
          ),
        ),
      );
    });
  }

  private establish(
    baseUrl: string,
    response: AuthenticatedSessionResponse,
    mode: LoginMode,
  ): Observable<AccountEstablishmentOutcome> {
    const command = accountEstablishment(baseUrl, response, mode, 'upsert');
    return this.accounts.establishAuthenticatedAccount(
      command.grant,
      command.intent,
    );
  }

  /** Accept "@user:server.org", "user:server.org", or a bare "server.org". */
  private extractDomain(input: string): string {
    const trimmed = input.trim().replace(/^@/, '');
    const colon = trimmed.indexOf(':');
    return colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
  }

  /** Strip a full MXID down to its localpart for the password identifier. */
  private localpart(user: string): string {
    const trimmed = user.trim().replace(/^@/, '');
    const colon = trimmed.indexOf(':');
    return colon >= 0 ? trimmed.slice(0, colon) : trimmed;
  }
}
