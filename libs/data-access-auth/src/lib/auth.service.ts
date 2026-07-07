import { Injectable, inject } from '@angular/core';
import { AutoDiscovery, createClient } from 'matrix-js-sdk';
import {
  Observable,
  catchError,
  defer,
  from,
  map,
  of,
  switchMap,
  tap,
} from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { AvatarService } from '@trinity/data-access-media';
import { MediaService } from '@trinity/data-access-media';
import { PushService } from '@trinity/data-access-notifications';
import { SessionStorageService } from '@trinity/platform-native';
import { MatrixSession } from '@trinity/util-matrix';

const DEVICE_DISPLAY_NAME = 'Trinity (Ionic)';

/** Whether a successful login replaces the current account or adds alongside it. */
export type LoginMode = 'replace' | 'add';

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
        createClient({ baseUrl }).login('m.login.password', {
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
        createClient({ baseUrl }).login('m.login.token', {
          token: loginToken,
          initial_device_display_name: DEVICE_DISPLAY_NAME,
          ...(deviceId ? { device_id: deviceId } : {}),
        }),
      ),
    ).pipe(switchMap((res) => this.establish(baseUrl, res, mode)));
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
    const isLast = this.matrix.accountIds().every((id) => id === target);

    if (isLast) {
      // Delete the pusher first (token still valid), log out server-side, then
      // reset() (not stop()) so the account's keys/cache don't linger on a shared
      // device, drop the shared blob caches, and clear storage.
      return this.push.unregister().pipe(
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
    // (token still valid), then matrix.remove stops + wipes it and repoints the active
    // account to a survivor — mirror that in storage.
    return this.push.unregister(target).pipe(
      switchMap(() => serverLogout),
      switchMap(() => this.matrix.remove(target)),
      switchMap(() => this.storage.remove(target)),
      switchMap(() => {
        const active = this.matrix.activeUserId();
        return active ? this.storage.setActive(active) : of(void 0);
      }),
    );
  }

  /**
   * Persist a login response and bring its client up. `replace` (the default login)
   * tears down any current account first — dropping its media/avatar caches + pusher;
   * `add` keeps the other signed-in accounts running and just adds this one, active.
   */
  private establish(
    baseUrl: string,
    res: { user_id: string; device_id: string; access_token: string },
    mode: LoginMode,
  ): Observable<void> {
    const session: MatrixSession = {
      baseUrl,
      userId: res.user_id,
      deviceId: res.device_id,
      accessToken: res.access_token,
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
