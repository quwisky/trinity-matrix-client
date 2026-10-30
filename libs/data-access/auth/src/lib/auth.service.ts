import { Injectable, inject } from '@angular/core';
import {
  createClient,
  type DeviceAccessTokenResponse,
  type MatrixClient,
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
  take,
  tap,
  throwError,
} from 'rxjs';
import {
  MatrixClientService,
  SESSION_ENGINE,
} from '@trinity/data-access/matrix-client';
import {
  AccountRuntimeService,
  UnprotectedStorageGate,
  type AccountEstablishmentOutcome,
} from '@trinity/data-access/accounts';
import { HostAuthenticationHandoffService } from '@trinity/runtime/host';
import {
  SessionStorageService,
  sameHomeserver,
} from '@trinity/platform-native';
import {
  EngineRequestError,
  UiaCancelledError,
  driveUia,
  engineUia,
  unwrapEngineResult,
  type OidcSessionBinding,
} from '@trinity/util/matrix';
import { AUTH_ENGINE } from './auth-engine.token';
import type { SignedInSession } from './auth-engine';
import type { AuthMetadata } from './auth-metadata';
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
  verifyAccountServer,
  type AuthenticatedSessionResponse,
  type LoginMode,
} from './account-establishment';
import { AUTHENTICATION_HOMESERVER_DISCOVERY } from './homeserver-discovery.port';
import {
  NEW_DEVICE_SIGN_IN,
  NewDeviceSignInCancelledError,
  UnprotectedStorageDeclinedError,
} from './new-device-sign-in.port';
import {
  accountServerApi,
  type AccountManagement,
  type AccountServerApi,
} from './account-server-api';
import type {
  LinkedSecrets,
  QrSignInCompletion,
} from './qr-sign-in/qr-sign-in-completion.port';
import { QrAccountAlreadyStoredError } from './qr-sign-in/qr-sign-in.model';

export type { LoginMode } from './account-establishment';
export type { AccountEstablishmentOutcome } from '@trinity/data-access/accounts';

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
export class AuthService implements QrSignInCompletion {
  private readonly matrix = inject(MatrixClientService);
  private readonly engine = inject(AUTH_ENGINE);
  private readonly sessionEngine = inject(SESSION_ENGINE);
  private readonly storage = inject(SessionStorageService);
  private readonly oidc = inject(OidcClientService);
  private readonly accounts = inject(AccountRuntimeService);
  private readonly newDeviceSignIn = inject(NEW_DEVICE_SIGN_IN);
  private readonly unprotectedStorage = inject(UnprotectedStorageGate);
  private readonly handoff = inject(HostAuthenticationHandoffService);
  private readonly discovery = inject(AUTHENTICATION_HOMESERVER_DISCOVERY);

  /** Which login flows the homeserver supports (e.g. 'm.login.password', 'm.login.sso'). */
  getSupportedFlows(baseUrl: string): Observable<string[]> {
    return this.engine.loginFlows(baseUrl).pipe(
      unwrapEngineResult(),
      map((flows) => [...flows]),
    );
  }

  /**
   * Discover a homeserver's delegated OIDC (MSC2965) provider config, or `null` when it
   * doesn't delegate authentication. Any failure also maps to `null`, so the login page can
   * probe in parallel with {@link getSupportedFlows} without slowing or breaking a legacy
   * homeserver.
   */
  getDelegatedAuthConfig(baseUrl: string): Observable<AuthMetadata | null> {
    return this.engine.authMetadata(baseUrl).pipe(
      map((answer) => (answer.ok ? answer.value : null)),
      catchError(() => of(null)),
    );
  }

  /**
   * Log in with username + password. `replace` (default) makes it the sole account; `add`
   * keeps the other signed-in accounts. `deviceId` re-authenticates that EXISTING device
   * (soft-logged-out account) so its crypto store is reused and no re-verification is
   * needed. Re-auth also passes `expectedUserId`: a login that returns anyone else is
   * refused before anything is persisted. `serverName` is the server the person entered,
   * which the returned account may belong to without a well-known lookup.
   */
  loginWithPassword(
    baseUrl: string,
    user: string,
    password: string,
    mode: LoginMode = 'replace',
    deviceId?: string,
    expectedUserId?: string,
    serverName?: string,
  ): Observable<AccountEstablishmentOutcome> {
    return defer(() =>
      this.engine.loginWithPassword(baseUrl, {
        localpart: this.localpart(user),
        password,
        deviceDisplayName: this.handoff.deviceDisplayName(),
        deviceId: deviceId ?? null,
      }),
    ).pipe(
      unwrapEngineResult(),
      switchMap((session) =>
        this.establish(
          baseUrl,
          sessionResponse(session),
          mode,
          expectedUserId,
          deviceId,
          serverName,
        ),
      ),
    );
  }

  /** Build the SSO redirect URL the browser/WebView should navigate to. */
  getSsoUrl(baseUrl: string, redirectUrl: string): Observable<string> {
    return this.engine
      .ssoLoginUrl(baseUrl, redirectUrl)
      .pipe(unwrapEngineResult());
  }

  /**
   * Complete an SSO/CAS login by exchanging the returned `loginToken` for a session.
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
      this.engine.loginWithToken(baseUrl, {
        token: loginToken,
        deviceDisplayName: this.handoff.deviceDisplayName(),
        deviceId: deviceId ?? null,
      }),
    ).pipe(
      unwrapEngineResult(),
      switchMap((session) =>
        this.establish(
          baseUrl,
          sessionResponse(session),
          mode,
          expectedUserId,
          deviceId,
        ),
      ),
    );
  }

  /**
   * Build the OIDC ("next-gen auth") authorization URL, plus the PKCE sign-in state the
   * caller must durably stash so a cold-start / off-origin callback can complete the grant.
   */
  buildOidcAuthorizationRequest(
    params: OidcAuthorizationParams,
  ): Observable<OidcAuthorizationRequest> {
    return this.oidc.buildAuthorizationRequest(params);
  }

  /**
   * Forget the rejected dynamic-registration client id for a homeserver's issuer so the
   * next login re-registers — called when the provider rejects the id (`invalid_client`),
   * which would otherwise wedge login until app storage is wiped.
   */
  forgetOidcClientId(
    baseUrl: string,
    issuer: string,
    rejectedClientId: string,
  ): Observable<void> {
    return this.oidc.forgetClientId(baseUrl, issuer, rejectedClientId);
  }

  /**
   * Complete an OIDC login: exchange the returned `code` for tokens, resolve the account
   * identity, and establish the session. `redirectUri` is the one used to build the
   * request, needed to rebuild the token refresher on restore.
   *
   * `expectedUserId` is set only by re-auth and binds the grant to the account the user
   * asked to reconnect — see {@link rejectMismatchedGrant}.
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

  /** The OAuth client id QR sign-in uses for the device grant. */
  deviceGrantClientId(
    metadata: ValidatedAuthMetadata,
    homeserverUrl: string,
  ): Observable<string> {
    return this.oidc.deviceGrantClientId(metadata, homeserverUrl);
  }

  /** The metadata QR sign-in runs the device grant on, with its endpoints verified. */
  deviceGrantMetadata(
    metadata: ValidatedAuthMetadata,
  ): Observable<ValidatedAuthMetadata> {
    return this.oidc.deviceGrantMetadata(metadata);
  }

  /** Forget the device-grant client id after the provider rejected it. */
  forgetDeviceGrantClientId(
    metadata: ValidatedAuthMetadata,
    homeserverUrl: string,
  ): Observable<void> {
    return this.oidc.forgetDeviceGrantClientId(metadata, homeserverUrl);
  }

  /**
   * Sign in a QR-linked new device with its device-grant tokens, keeping other signed-in
   * accounts. Emits the started client only after `whoami` has succeeded with the new
   * token, so the device exists on the server before the existing device shares secrets.
   * An account this device already stores is refused and left as it was. Until `establish`
   * takes the tokens over, any failure or unsubscribe revokes them.
   */
  completeDeviceGrant(
    tokens: DeviceAccessTokenResponse,
    clientId: string,
    metadata: ValidatedAuthMetadata,
    homeserverUrl: string,
  ): Observable<MatrixClient> {
    return defer(() => {
      const issuedBy = Date.now();
      let binding: OidcSessionBinding = { issuer: metadata.issuer, clientId };
      let owned = false;
      return from(
        createClient({
          baseUrl: homeserverUrl,
          accessToken: tokens.access_token,
        }).whoami(),
      ).pipe(
        switchMap((who) => {
          const deviceId = who.device_id;
          if (!deviceId) {
            throw new Error(
              'The provider returned no device for this session.',
            );
          }
          return this.storage.record(who.user_id).pipe(
            take(1),
            switchMap((stored) => {
              if (stored) throw new QrAccountAlreadyStoredError();
              return this.oidc.deviceGrantBinding(metadata, clientId);
            }),
            map((pinned) => {
              binding = pinned;
              return { userId: who.user_id, deviceId };
            }),
          );
        }),
        switchMap(({ userId, deviceId }) => {
          owned = true;
          return this.establish(
            homeserverUrl,
            {
              user_id: userId,
              device_id: deviceId,
              access_token: tokens.access_token,
              refresh_token: tokens.refresh_token,
              ...(tokens.expires_in !== undefined
                ? { accessTokenExpiresAt: issuedBy + tokens.expires_in * 1000 }
                : {}),
              oidc: binding,
            },
            'add',
          );
        }),
        map((outcome) => {
          const client =
            outcome.kind === 'ready'
              ? this.matrix.clientFor(outcome.accountId)
              : null;
          if (!client) {
            throw new Error(`The QR sign-in did not start (${outcome.kind}).`);
          }
          return client;
        }),
        finalize(() => {
          if (owned) return;
          this.oidc
            .revokeTokens(homeserverUrl, binding, {
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
            })
            .subscribe({ error: () => undefined });
        }),
      );
    });
  }

  /**
   * Import the secrets a QR link shared, cross-sign this device and enable key backup.
   * Emits whether the device ended cross-signed; `false` leaves it to the usual check.
   * Errors are dropped unlogged: they can quote the secrets.
   */
  importLinkedSecrets(
    client: MatrixClient,
    secrets: LinkedSecrets,
  ): Observable<boolean> {
    return defer(async () => {
      const crypto = client.getCrypto();
      const deviceId = client.getDeviceId();
      const userId = client.getUserId();
      if (!crypto?.importSecretsBundle || !deviceId || !userId) return false;
      await crypto.importSecretsBundle(secrets);
      await crypto.crossSignDevice(deviceId);
      // Best effort: backup does not decide whether the device is verified.
      await crypto.checkKeyBackupAndEnable().catch(() => undefined);
      if (!(await crypto.isCrossSigningReady())) return false;
      const status = await crypto.getDeviceVerificationStatus(userId, deviceId);
      return status?.crossSigningVerified === true;
    }).pipe(catchError(() => of(false)));
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
   * The active account's provider-hosted account management, or `null` when its server
   * does not use OAuth 2.0 (or the provider exposes none).
   */
  getAccountManagement(): Observable<AccountManagement | null> {
    return this.storage.load().pipe(
      switchMap((session) =>
        session ? this.serverApi(session.baseUrl) : of(null),
      ),
      map((api) => (api?.kind === 'oauth' ? api.management : null)),
    );
  }

  /**
   * Which account API `accountId`'s server uses, decided by the server's OAuth 2.0
   * metadata rather than by how the account signed in: a password login through MAS's
   * compatibility layer has no `oidc` binding, yet its server serves no legacy account API.
   */
  accountManagementFor(accountId: string): Observable<AccountServerApi> {
    return this.sessionEngine.accessToken(accountId).pipe(
      take(1),
      switchMap((live) =>
        live
          ? of(live.homeserverUrl)
          : this.storage.record(accountId).pipe(map((r) => r?.baseUrl ?? null)),
      ),
      switchMap((baseUrl) =>
        baseUrl ? this.serverApi(baseUrl) : of({ kind: 'legacy' } as const),
      ),
    );
  }

  private serverApi(baseUrl: string): Observable<AccountServerApi> {
    return this.engine.authMetadata(baseUrl).pipe(map(accountServerApi));
  }

  /**
   * Change `accountId`'s password. Cold — runs on subscribe. The homeserver requires a
   * user-interactive-auth (UIA) password stage, which we satisfy with the supplied
   * `currentPassword` via {@link driveUia}; a rejected password surfaces as a clear
   * "incorrect password" error rather than a raw UIA failure, and a weak new password as
   * the server's reason. Other sessions are kept signed in.
   */
  changePassword(
    accountId: string,
    currentPassword: string,
    newPassword: string,
  ): Observable<void> {
    return defer(() =>
      driveUia(
        engineUia((auth) =>
          this.engine.changePassword(accountId, newPassword, auth),
        ),
        {
          password: {
            user: accountId,
            // A second prompt means the server rejected the first — bail rather than loop.
            prompt: ({ rejected }) =>
              Promise.resolve(rejected ? null : currentPassword),
          },
        },
      ),
    ).pipe(
      map(() => void 0),
      catchError((err: unknown) => {
        if (err instanceof UiaCancelledError) {
          return throwError(
            () => new Error('Your current password is incorrect.'),
          );
        }
        const reason =
          err instanceof EngineRequestError &&
          err.failure.code === 'request-failed'
            ? err.failure.params?.serverMessage
            : undefined;
        return throwError(() => (reason ? new Error(reason) : err));
      }),
    );
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
    enteredServerName?: string,
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
    // Without a requested device id, a password or legacy SSO login always gets a new
    // device from the server. OAuth names its device id itself, the stored one on
    // re-auth, so only the stored record can tell (see `confirmNewDevice`).
    const device: NewDeviceCheck = {
      isNew: !requestedDeviceId && !response.oidc,
    };
    return defer(() => {
      const command = accountEstablishment(baseUrl, response, mode, 'upsert');
      return this.reauthOfStoredAccount(
        baseUrl,
        response.user_id,
        expectedUserId,
      ).pipe(
        switchMap((stored) =>
          stored
            ? of(undefined)
            : verifyAccountServer(
                baseUrl,
                response.user_id,
                this.discovery,
                enteredServerName,
              ),
        ),
        map(() => command),
      );
    }).pipe(
      catchError((error: unknown) => {
        // Only a sign-in that is not a re-auth is known to hold a new device.
        if (!requestedDeviceId && !expectedUserId) {
          this.signOutNewDevice(baseUrl, response);
        }
        return throwError(() => error);
      }),
      switchMap((command) =>
        this.confirmNewDevice(
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
        ),
      ),
      tap((outcome) => {
        // Refused before anything was saved: nothing will ever use this session.
        if (
          device.isNew &&
          (outcome.kind === 'transition-in-progress' ||
            (outcome.kind === 'failed' &&
              (outcome.failure === 'homeserver-mismatch' ||
                outcome.failure === 'account-already-stored' ||
                outcome.failure === 'unprotected-storage-declined')))
        ) {
          this.signOutNewDevice(baseUrl, response);
        }
      }),
    );
  }

  /**
   * Whether this re-auth is for an account saved through this same homeserver. That
   * record's server was accepted when it was saved, and saving refuses another server.
   */
  private reauthOfStoredAccount(
    baseUrl: string,
    userId: string,
    expectedUserId: string | null | undefined,
  ): Observable<boolean> {
    if (!expectedUserId) {
      return of(false);
    }
    return this.storage.record(userId).pipe(
      map((record) => !!record && sameHomeserver(record.baseUrl, baseUrl)),
      catchError(() => of(false)),
    );
  }

  /**
   * A sign-in without the stored device id gets a new device, and persisting it deletes
   * the stored device's crypto store (`SessionStorageService` upsert). Unless key backup
   * holds every room key, ask first, while the stored account's client can still answer.
   * Then, on a host whose keychain cannot be used, ask whether to store it unprotected.
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
          : this.sessionEngine.roomKeysBackedUp(userId).pipe(
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
      switchMap((proceed) =>
        proceed
          ? // Asked here too, not only by Account Runtime, so this session is handed back
            // whenever the question ends without a yes: declined, unanswered or unreadable.
            this.unprotectedStorage.allowed().pipe(
              take(1),
              switchMap((allowed) => {
                proceeded = allowed;
                return allowed
                  ? of(void 0)
                  : throwError(() => new UnprotectedStorageDeclinedError());
              }),
            )
          : throwError(() => new NewDeviceSignInCancelledError(userId)),
      ),
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
      : this.sessionEngine.logoutSession({
          baseUrl,
          userId: response.user_id,
          deviceId: response.device_id,
          accessToken: response.access_token,
        });
    signOut.subscribe({ error: () => undefined });
  }

  /** Strip a full MXID down to its localpart for the password identifier. */
  private localpart(user: string): string {
    const trimmed = user.trim().replace(/^@/, '');
    const colon = trimmed.indexOf(':');
    return colon >= 0 ? trimmed.slice(0, colon) : trimmed;
  }
}

/** The session as account establishment reads it. */
function sessionResponse(
  session: SignedInSession,
): AuthenticatedSessionResponse {
  return {
    user_id: session.userId,
    device_id: session.deviceId,
    access_token: session.accessToken,
    ...(session.refreshToken !== null
      ? { refresh_token: session.refreshToken }
      : {}),
  };
}
