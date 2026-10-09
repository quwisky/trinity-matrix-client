import { Injectable, inject } from '@angular/core';
import {
  createClient,
  type AuthDict,
  type ValidatedAuthMetadata,
} from 'matrix-js-sdk';
import {
  Observable,
  catchError,
  defaultIfEmpty,
  defer,
  finalize,
  from,
  map,
  of,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  AccountRuntimeService,
  type AccountEstablishmentOutcome,
} from '@trinity/data-access/accounts';
import {
  SessionStorageService,
  sameHomeserver,
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
  ReauthAccountMismatchError,
  accountEstablishment,
  type AuthenticatedSessionResponse,
  type LoginMode,
} from './account-establishment';
import {
  NEW_DEVICE_SIGN_IN,
  NewDeviceSignInCancelledError,
} from './new-device-sign-in.port';

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
/** Whether a sign-in's session is known to be a new device (see `confirmNewDevice`). */
interface NewDeviceCheck {
  isNew: boolean;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly matrix = inject(MatrixClientService);
  private readonly storage = inject(SessionStorageService);
  private readonly oidc = inject(OidcClientService);
  private readonly accounts = inject(AccountRuntimeService);
  private readonly newDeviceSignIn = inject(NEW_DEVICE_SIGN_IN);

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
   * account) so its crypto store is reused and no re-verification is needed. Re-auth
   * also passes `expectedUserId`, the account being reconnected: a login that returns
   * anyone else is refused before anything is persisted.
   */
  loginWithPassword(
    baseUrl: string,
    user: string,
    password: string,
    mode: LoginMode = 'replace',
    deviceId?: string,
    expectedUserId?: string,
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
    ).pipe(
      switchMap((res) =>
        this.establish(baseUrl, res, mode, expectedUserId, deviceId),
      ),
    );
  }

  /** Build the SSO redirect URL the browser/WebView should navigate to. */
  getSsoUrl(baseUrl: string, redirectUrl: string): string {
    return createClient({ baseUrl }).getSsoLoginUrl(redirectUrl, 'sso');
  }

  /**
   * Complete an SSO/CAS login by exchanging the returned `loginToken` for a session.
   * Called from the SSO callback route after the homeserver redirects back.
   * `deviceId` and `expectedUserId` are set only by re-auth, as for {@link loginWithPassword}.
   */
  completeSsoLogin(
    baseUrl: string,
    loginToken: string,
    mode: LoginMode = 'replace',
    deviceId?: string,
    expectedUserId?: string,
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
    ).pipe(
      switchMap((res) =>
        this.establish(baseUrl, res, mode, expectedUserId, deviceId),
      ),
    );
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
   * Forget the cached dynamic-registration client id for a homeserver's issuer so the
   * next login re-registers — called when the provider rejects the id (`invalid_client`),
   * which would otherwise wedge login until app storage is wiped.
   */
  forgetOidcClientId(baseUrl: string, issuer: string): Observable<void> {
    return this.oidc.forgetClientId(baseUrl, issuer);
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
          expectedUserId,
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
      () => new ReauthAccountMismatchError(grant.userId, expectedUserId),
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
          // The probe sends no `auth` at all: an empty dict is malformed UIA data that
          // ruma-based servers reject with M_BAD_JSON instead of the 401 challenge. The
          // SDK types the dict as required but serialises an undefined one away.
          (auth) =>
            client.setPassword(
              auth ?? (undefined as unknown as AuthDict),
              newPassword,
              false,
            ),
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
   * `requestedDeviceId` is the device id a password or legacy SSO re-auth asked for.
   * A session is handed back on refusal only when it is known to be a NEW device: a
   * re-auth signs back in on a device the user keeps, and signing that out would end it
   * on the server.
   */
  private establish(
    baseUrl: string,
    response: AuthenticatedSessionResponse,
    mode: LoginMode,
    expectedUserId?: string | null,
    requestedDeviceId?: string,
  ): Observable<AccountEstablishmentOutcome> {
    // Every login method converges here, so this one check covers password, legacy SSO
    // and OIDC re-auth alike.
    if (expectedUserId && response.user_id !== expectedUserId) {
      if (!requestedDeviceId) {
        this.signOutNewDevice(baseUrl, response);
      }
      return throwError(
        () => new ReauthAccountMismatchError(response.user_id, expectedUserId),
      );
    }
    const command = accountEstablishment(baseUrl, response, mode, 'upsert');
    // Without a requested device id, a password or legacy SSO login always gets a new
    // device from the server. OAuth names its device id itself, the stored one on
    // re-auth, so only the stored record can tell (see `confirmNewDevice`).
    const device: NewDeviceCheck = {
      isNew: !requestedDeviceId && !response.oidc,
    };
    return this.confirmNewDevice(
      baseUrl,
      response,
      requestedDeviceId,
      device,
    ).pipe(
      switchMap(() =>
        this.accounts.establishAuthenticatedAccount(
          command.grant,
          command.intent,
        ),
      ),
      tap((outcome) => {
        // Refused before anything was saved: nothing will ever use this session.
        if (
          device.isNew &&
          (outcome.kind === 'transition-in-progress' ||
            (outcome.kind === 'failed' &&
              (outcome.failure === 'homeserver-mismatch' ||
                outcome.failure === 'account-already-stored')))
        ) {
          this.signOutNewDevice(baseUrl, response);
        }
      }),
    );
  }

  /**
   * A sign-in without the stored device id gets a new device, and persisting it deletes
   * the stored device's crypto store (`SessionStorageService` upsert). Unless key backup
   * holds every room key, ask first, while the stored account's client can still answer.
   * Whenever the sign-in does not go ahead (cancel, a failed check, or a subscriber that
   * leaves mid-dialog), sign the new device out again and leave the stored account as it was.
   * Only a session in `device.isNew` is signed out: never one on a requested or stored
   * device id, nor an OAuth session whose stored record could not be read.
   */
  private confirmNewDevice(
    baseUrl: string,
    response: AuthenticatedSessionResponse,
    requestedDeviceId: string | undefined,
    device: NewDeviceCheck,
  ): Observable<void> {
    const userId = response.user_id;
    let proceeded = false;
    return this.storage.record(userId).pipe(
      tap((record) => {
        device.isNew =
          !requestedDeviceId && record?.deviceId !== response.device_id;
      }),
      switchMap((record) =>
        // A stored account on another server is not replaced: saving refuses the sign-in.
        !record ||
        record.deviceId === response.device_id ||
        !sameHomeserver(record.baseUrl, baseUrl)
          ? of(true)
          : this.matrix.roomKeysBackedUp(userId).pipe(
              switchMap((backedUp) =>
                backedUp
                  ? of(true)
                  : this.newDeviceSignIn.confirm({
                      userId,
                      roomKeysBackedUp: backedUp,
                    }),
              ),
            ),
      ),
      defaultIfEmpty(false),
      switchMap((proceed) => {
        proceeded = proceed;
        return proceed
          ? of(void 0)
          : throwError(() => new NewDeviceSignInCancelledError(userId));
      }),
      finalize(() => {
        if (!proceeded && device.isNew) {
          this.signOutNewDevice(baseUrl, response);
        }
      }),
    );
  }

  /** Hand back a session this sign-in created but will not use. Detached and best-effort. */
  private signOutNewDevice(
    baseUrl: string,
    response: AuthenticatedSessionResponse,
  ): void {
    const signOut: Observable<unknown> = response.oidc
      ? this.oidc.revokeTokens(baseUrl, response.oidc, {
          accessToken: response.access_token,
          refreshToken: response.refresh_token,
        })
      : defer(() =>
          from(
            createClient({
              baseUrl,
              accessToken: response.access_token,
            }).logout(true),
          ),
        );
    signOut.subscribe({ error: () => undefined });
  }

  /** Strip a full MXID down to its localpart for the password identifier. */
  private localpart(user: string): string {
    const trimmed = user.trim().replace(/^@/, '');
    const colon = trimmed.indexOf(':');
    return colon >= 0 ? trimmed.slice(0, colon) : trimmed;
  }
}
