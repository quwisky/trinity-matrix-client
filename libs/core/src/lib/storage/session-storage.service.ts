import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { Observable, defer, from, map } from 'rxjs';
import { MatrixSession } from '../matrix/session.model';

const SESSION_KEY = 'matrix.session';

/**
 * Persists the Matrix session (token, ids, homeserver) via Capacitor Preferences,
 * which is backed by native secure-ish storage on device and localStorage on web.
 *
 * Methods return cold Observables (`defer` so the work runs on subscribe).
 */
@Injectable({ providedIn: 'root' })
export class SessionStorageService {
  save(session: MatrixSession): Observable<void> {
    return defer(() =>
      from(
        Preferences.set({ key: SESSION_KEY, value: JSON.stringify(session) }),
      ),
    );
  }

  load(): Observable<MatrixSession | null> {
    return defer(() => from(Preferences.get({ key: SESSION_KEY }))).pipe(
      map(({ value }) => (value ? (JSON.parse(value) as MatrixSession) : null)),
    );
  }

  clear(): Observable<void> {
    return defer(() => from(Preferences.remove({ key: SESSION_KEY })));
  }
}
