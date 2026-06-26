import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { MatrixSession } from '../matrix/session.model';

const SESSION_KEY = 'matrix.session';

/**
 * Persists the Matrix session (token, ids, homeserver) via Capacitor Preferences,
 * which is backed by native secure-ish storage on device and localStorage on web.
 */
@Injectable({ providedIn: 'root' })
export class SessionStorageService {
  async save(session: MatrixSession): Promise<void> {
    await Preferences.set({ key: SESSION_KEY, value: JSON.stringify(session) });
  }

  async load(): Promise<MatrixSession | null> {
    const { value } = await Preferences.get({ key: SESSION_KEY });
    return value ? (JSON.parse(value) as MatrixSession) : null;
  }

  async clear(): Promise<void> {
    await Preferences.remove({ key: SESSION_KEY });
  }
}
