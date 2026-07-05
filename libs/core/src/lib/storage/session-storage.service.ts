import { Injectable, inject } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { Observable, defer, from } from 'rxjs';
import { MatrixSession } from '@trinity/util-matrix';
import { SecureStorageService } from './secure-storage.service';

/** Non-secret session fields (baseUrl/userId/deviceId) — safe for Preferences. */
const SESSION_KEY = 'matrix.session';
/** The access token — held by {@link SecureStorageService} (keychain/keystore). */
const TOKEN_KEY = 'matrix.accessToken';

/**
 * Persists the Matrix session. The **access token** (the full account bearer
 * credential) goes through {@link SecureStorageService} — OS keychain on native,
 * `safeStorage` on Electron, best-effort on web — while the non-secret fields
 * (homeserver, user id, device id) stay in Capacitor Preferences. Never write the
 * token to Preferences/localStorage.
 *
 * Methods return cold Observables (`defer` so the work runs on subscribe).
 */
@Injectable({ providedIn: 'root' })
export class SessionStorageService {
  private readonly secure = inject(SecureStorageService);

  save(session: MatrixSession): Observable<void> {
    return defer(() => from(this.saveInternal(session)));
  }

  load(): Observable<MatrixSession | null> {
    return defer(() => from(this.loadInternal()));
  }

  clear(): Observable<void> {
    return defer(() => from(this.clearInternal()));
  }

  private async saveInternal(session: MatrixSession): Promise<void> {
    const { accessToken, ...nonSecret } = session;
    await this.secure.set(TOKEN_KEY, accessToken);
    await Preferences.set({
      key: SESSION_KEY,
      value: JSON.stringify(nonSecret),
    });
  }

  private async loadInternal(): Promise<MatrixSession | null> {
    const { value } = await Preferences.get({ key: SESSION_KEY });
    if (!value) {
      return null;
    }
    const stored = JSON.parse(value) as Partial<MatrixSession>;
    let accessToken = await this.secure.get(TOKEN_KEY);

    // Migrate a pre-secure-storage blob: the token used to be persisted inside the
    // session JSON. Move it into secure storage and rewrite Preferences without it —
    // a one-time, transparent upgrade (no re-login).
    if (!accessToken && stored.accessToken) {
      accessToken = stored.accessToken;
      await this.secure.set(TOKEN_KEY, accessToken);
      await Preferences.set({
        key: SESSION_KEY,
        value: JSON.stringify({
          baseUrl: stored.baseUrl,
          userId: stored.userId,
          deviceId: stored.deviceId,
        }),
      });
    }

    if (!stored.baseUrl || !stored.userId || !stored.deviceId || !accessToken) {
      return null;
    }
    return {
      baseUrl: stored.baseUrl,
      userId: stored.userId,
      deviceId: stored.deviceId,
      accessToken,
    };
  }

  private async clearInternal(): Promise<void> {
    await Preferences.remove({ key: SESSION_KEY });
    await this.secure.remove(TOKEN_KEY);
  }
}
