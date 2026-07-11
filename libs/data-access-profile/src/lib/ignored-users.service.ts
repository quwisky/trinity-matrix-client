import { Injectable, inject } from '@angular/core';
import { Observable, defer, from, map, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

/**
 * The account-wide ignore ("block") list (`m.ignored_user_list`). Ignoring a user makes
 * the homeserver and SDK hide their events, so it works without any room-admin rights.
 * Writes are cold Observables; the change syncs to every device.
 */
@Injectable({ providedIn: 'root' })
export class IgnoredUsersService {
  private readonly matrix = inject(MatrixClientService);

  /** Whether `userId` is currently ignored. */
  isIgnored(userId: string): boolean {
    return (
      this.matrix.isInitialized && this.matrix.instance.isUserIgnored(userId)
    );
  }

  /** Ignore (block) a user. Cold — runs on subscribe. No-op if already ignored. */
  ignore(userId: string): Observable<void> {
    return this.write(userId, true);
  }

  /** Stop ignoring (unblock) a user. Cold — runs on subscribe. */
  unignore(userId: string): Observable<void> {
    return this.write(userId, false);
  }

  private write(userId: string, ignored: boolean): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      const client = this.matrix.instance;
      const current = client.getIgnoredUsers();
      const next = ignored
        ? [...new Set([...current, userId])]
        : current.filter((id) => id !== userId);
      return from(client.setIgnoredUsers(next)).pipe(map(() => void 0));
    });
  }
}
