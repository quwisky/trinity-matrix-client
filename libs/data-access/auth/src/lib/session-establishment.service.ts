import { Injectable, inject } from '@angular/core';
import { Observable, switchMap } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { AvatarService, MediaService } from '@trinity/data-access/media';
import { PushService } from '@trinity/data-access/notifications';
import { SessionStorageService } from '@trinity/platform-native';
import { MatrixSession, type OidcSessionBinding } from '@trinity/util/matrix';

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
 * Persists an authenticated Matrix session and starts its client.
 *
 * Kept separate from the protocol-specific auth services so a successful registration
 * never has to repeat its account-creation request merely because local initialization
 * failed afterward.
 */
@Injectable({ providedIn: 'root' })
export class SessionEstablishmentService {
  private readonly matrix = inject(MatrixClientService);
  private readonly storage = inject(SessionStorageService);
  private readonly avatars = inject(AvatarService);
  private readonly media = inject(MediaService);
  private readonly push = inject(PushService);

  /** Persist and start a session, replacing the current account unless `mode` is `add`. */
  establish(
    baseUrl: string,
    res: AuthenticatedSessionResponse,
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
}
