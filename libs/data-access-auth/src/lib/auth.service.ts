import { Injectable, inject } from '@angular/core';
import {
  AutoDiscovery,
  createClient,
  type AuthDict,
  type OidcClientConfig,
} from 'matrix-js-sdk';
import {
  Observable,
  catchError,
  defer,
  from,
  map,
  of,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { AvatarService } from '@trinity/data-access-media';
import { MediaService } from '@trinity/data-access-media';
import { PushService } from '@trinity/data-access-notifications';
import { SessionStorageService } from '@trinity/platform-native';
import {
  MatrixSession,
  UiaCancelledError,
  runPasswordUia,
  type OidcSessionBinding,
  type PasswordPrompt,
} from '@trinity/util-matrix';
import {
  OidcClientService,
  type OidcAuthorizationParams,
  type OidcAuthorizationRequest,
} from './oidc-client.service';

const DEVICE_DISPLAY_NAME = 'Trinity';

/** Whether a successful login replaces the current account or adds alongside it. */
export type LoginMode = 'replace' | 'add';

/** The active OIDC account's provider-hosted account-management surface. */
export interface AccountManagement {
  /** The provider's account-management URL (validated https). */
  url: string;
  /** MSC2965 actions the provider supports deep-linking to (e.g. session management). */
  actionsSupported: string[];
}

/**
 * Handles authentication: homeserver discovery (.well-known), password login,
 * SSO URL construction, and logout. On success it persists the session and hands
 * the live client to MatrixClientService.
 *
 * Components talk to this service, never to matrix-js-sdk directly. Async APIs are
 * cold Observables.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly matrix = inject(MatrixClientService);
  private readonly storage = inject(SessionStorageService);
  private readonly avatars = inject(AvatarService);
  private readonly media = inject(MediaService);
  private readonly push = inject(PushService);
  private readonly oidc = inject(OidcClientService);

  /**
   * Resolve a homeserver base URL from a user-entered domain (e.g. "matrix.org"
   * or "@me:example.org" -> "example.org") via .well-known auto-discovery.
   * Falls back to https://<domain> when discovery is silent.
   */
  discoverHomeserver(input: string): Observable<string> {
    const domain = this.extractDomain(input);
    return defer(() => from(AutoDiscovery.findClientConfig(domain))).pipe(
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
        const baseUrl = hs.base_url ?? `https://${domain}`;
        return baseUrl.replace(/\/$/, '');
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
  getDelegatedAuthConfig(baseUrl: string): Observable<OidcClientConfig | null> {
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
  ): Observable<void> {
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
  ): Observable<void> {
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
   */
  completeOidcLogin(
    code: string,
    state: string,
    redirectUri: string,
    mode: LoginMode = 'replace',
  ): Observable<void> {
    return this.oidc.completeGrant(code, state, redirectUri).pipe(
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
   * Switch the active account. Cheap when it's already live (flips the active client
   * + persisted pointer); starts it first if it isn't running yet.
   */
  switchAccount(userId: string): Observable<void> {
    if (this.matrix.accountIds().includes(userId)) {
      this.matrix.setActive(userId);
      return this.storage.setActive(userId);
    }
    return this.storage.load(userId).pipe(
      switchMap((session) => (session ? this.matrix.add(session) : of(void 0))),
      switchMap(() => this.storage.setActive(userId)),
    );
  }

  /**
   * Sign an account out — the active one by default, or a specific `userId`.
   * Invalidates its server-side device and wipes its local stores. When it was the
   * last account this fully resets (releasing the shared media/avatar caches and
   * clearing storage); otherwise the others keep running and the active pointer moves
   * to a survivor.
   */
  logout(userId?: string): Observable<void> {
    // `||` (not `??`) so an empty-string id — e.g. the user panel emitting a null
    // active id as '' — falls back to the active account rather than being treated
    // as a real target (which would skip client teardown and clear everything).
    const target = userId || this.matrix.activeUserId();
    if (!target) {
      return this.storage.clear();
    }
    const client = this.matrix.clientFor(target);
    // Even if the server call fails, clear locally so the user isn't stuck.
    const serverLogout = client
      ? from(client.logout(true)).pipe(catchError(() => of(void 0)))
      : of(void 0);
    // For an OIDC account, also revoke its tokens at the provider (best-effort, while
    // they're still valid) — belt-and-suspenders alongside the CSAPI logout above.
    const revoke = this.storage.load(target).pipe(
      switchMap((session) =>
        session?.oidc
          ? this.oidc.revokeTokens(session.baseUrl, session.oidc, {
              accessToken: session.accessToken,
              refreshToken: session.refreshToken,
            })
          : of(void 0),
      ),
      catchError(() => of(void 0)),
    );
    // Whether this is the last account must be judged against the PERSISTED registry,
    // not the live client map (`accountIds()`). The two diverge: an account that is
    // soft-logged-out, or whose background warm-up failed, drops out of the map but
    // deliberately KEEPS its registry record so re-auth can reuse its crypto store.
    // Judging by the map would take the full-clear branch and wipe that record — and,
    // once the startup sweep sees an unowned store, that account's E2EE keys with it.
    // The registry is what clear() erases, so the registry decides.
    return this.storage.list().pipe(
      switchMap((accounts) => {
        const isLast = accounts.every((account) => account.userId === target);
        if (isLast) {
          // Delete the pusher first (token still valid), revoke at the provider + log out
          // server-side, then reset() (not stop()) so the account's keys/cache don't linger
          // on a shared device, drop the shared blob caches, and clear storage.
          return this.push.unregister().pipe(
            switchMap(() => revoke),
            switchMap(() => serverLogout),
            switchMap(() => this.matrix.reset()),
            tap(() => {
              this.avatars.releaseAll();
              this.media.releaseAll();
            }),
            switchMap(() => this.storage.clear()),
          );
        }
        // Sign out just this account; the others keep syncing. Delete its pusher first
        // (token still valid), revoke at the provider + log out server-side, then
        // matrix.remove stops + wipes it and repoints the active account to a survivor.
        return this.push.unregister(target).pipe(
          switchMap(() => revoke),
          switchMap(() => serverLogout),
          switchMap(() => this.matrix.remove(target)),
          switchMap(() => this.storage.remove(target)),
          switchMap(() => {
            const active = this.matrix.activeUserId();
            return active ? this.storage.setActive(active) : of(void 0);
          }),
        );
      }),
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

  /**
   * Persist a login response and bring its client up. `replace` (the default login)
   * tears down any current account first — dropping its media/avatar caches + pusher;
   * `add` keeps the other signed-in accounts running and just adds this one, active.
   */
  private establish(
    baseUrl: string,
    res: {
      user_id: string;
      device_id: string;
      access_token: string;
      refresh_token?: string;
      accessTokenExpiresAt?: number;
      oidc?: OidcSessionBinding;
    },
    mode: LoginMode,
  ): Observable<void> {
    const session: MatrixSession = {
      baseUrl,
      userId: res.user_id,
      deviceId: res.device_id,
      accessToken: res.access_token,
      ...(res.refresh_token !== undefined
        ? { refreshToken: res.refresh_token }
        : {}),
      ...(res.accessTokenExpiresAt !== undefined
        ? { accessTokenExpiresAt: res.accessTokenExpiresAt }
        : {}),
      ...(res.oidc ? { oidc: res.oidc } : {}),
    };
    if (mode === 'add') {
      // Additive: leave the other accounts' media/avatar caches + pusher untouched.
      // Start with the STORED session so this account uses its own crypto-store
      // prefix, not the SDK default (which would collide with the active account's).
      // Then register a pusher for the new account (idempotent; no-op off native).
      return this.storage.save(session).pipe(
        switchMap((stored) => this.matrix.add(stored)),
        switchMap(() => this.push.register()),
      );
    }
    // Replace: drop the prior session's avatar/media blobs (re-login can switch
    // accounts/homeservers without a logout) and its pusher, then start fresh.
    this.avatars.releaseAll();
    this.media.releaseAll();
    return this.push.unregister().pipe(
      switchMap(() => this.storage.save(session)),
      switchMap((stored) => this.matrix.init(stored)),
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
