import { Injectable, inject } from '@angular/core';
import {
  AccountRuntimeService,
  AuthenticatedAccountGrant,
  type AccountEstablishmentIntent,
  type AccountEstablishmentOutcome,
} from '@trinity/data-access/accounts';
import { AvatarService, MediaService } from '@trinity/data-access/media';
import { PushService } from '@trinity/data-access/notifications';
import { MatrixSession, type OidcSessionBinding } from '@trinity/util/matrix';
import { Observable, defer, map, of, switchMap } from 'rxjs';

/** Whether a successful authentication replaces the current account or adds alongside it. */
export type LoginMode = 'replace' | 'add';

/** The authenticated fields shared by password, SSO, OIDC, and registration responses. */
export interface AuthenticatedSessionResponse {
  user_id: string;
  device_id: string;
  access_token: string;
  refresh_token?: string;
  accessTokenExpiresAt?: number;
  oidc?: OidcSessionBinding;
}

/**
 * Converts protocol-specific authentication responses into Account Runtime grants.
 *
 * This compatibility facade retains the existing login command shape and ancillary
 * cache/push behavior. Persistence and live-client placement belong exclusively to
 * Account Runtime; auth code never receives the grant payload back after issuing it.
 */
@Injectable({ providedIn: 'root' })
export class SessionEstablishmentService {
  private readonly accounts = inject(AccountRuntimeService);
  private readonly avatars = inject(AvatarService);
  private readonly media = inject(MediaService);
  private readonly push = inject(PushService);

  /** Establish a session, replacing the current account unless `mode` is `add`. */
  establish(
    baseUrl: string,
    response: AuthenticatedSessionResponse,
    mode: LoginMode,
  ): Observable<AccountEstablishmentOutcome> {
    return this.establishWithConstraint(baseUrl, response, mode, 'upsert');
  }

  /** Establish a newly registered account without replacing an existing record. */
  establishNew(
    baseUrl: string,
    response: AuthenticatedSessionResponse,
    mode: LoginMode,
  ): Observable<AccountEstablishmentOutcome> {
    return this.establishWithConstraint(baseUrl, response, mode, 'new');
  }

  private establishWithConstraint(
    baseUrl: string,
    response: AuthenticatedSessionResponse,
    mode: LoginMode,
    accountRecord: AccountEstablishmentIntent['accountRecord'],
  ): Observable<AccountEstablishmentOutcome> {
    return defer(() => {
      const grant = AuthenticatedAccountGrant.issue(
        this.toSession(baseUrl, response),
      );
      const intent: AccountEstablishmentIntent = {
        placement: 'active',
        liveAccounts: mode === 'add' ? 'keep' : 'replace',
        accountRecord,
      };

      if (mode === 'add') {
        return this.accounts
          .establishAuthenticatedAccount(grant, intent)
          .pipe(
            switchMap((outcome) =>
              outcome.kind === 'ready'
                ? this.push.register().pipe(map(() => outcome))
                : of(outcome),
            ),
          );
      }

      // Push teardown must see the prior live clients. Account Runtime commits the new
      // active placement only after this best-effort compatibility cleanup completes.
      this.avatars.releaseAll();
      this.media.releaseAll();
      return this.push
        .unregister()
        .pipe(
          switchMap(() =>
            this.accounts.establishAuthenticatedAccount(grant, intent),
          ),
        );
    });
  }

  private toSession(
    baseUrl: string,
    response: AuthenticatedSessionResponse,
  ): MatrixSession {
    return {
      baseUrl,
      userId: response.user_id,
      deviceId: response.device_id,
      accessToken: response.access_token,
      ...(response.refresh_token !== undefined
        ? { refreshToken: response.refresh_token }
        : {}),
      ...(response.accessTokenExpiresAt !== undefined
        ? { accessTokenExpiresAt: response.accessTokenExpiresAt }
        : {}),
      ...(response.oidc ? { oidc: response.oidc } : {}),
    };
  }
}
