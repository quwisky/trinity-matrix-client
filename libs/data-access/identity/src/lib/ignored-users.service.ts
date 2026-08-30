import { Injectable, inject } from '@angular/core';
import { Observable, defer, from, map } from 'rxjs';
import { IdentityMatrixPort } from '@trinity/data-access/matrix-client';
import {
  identityNotReady,
  recoverIdentityOperation,
  type IdentityOperation,
} from './identity-operation-error';

/**
 * The account-wide ignore ("block") list (`m.ignored_user_list`). Ignoring a user makes
 * the homeserver and SDK hide their events, so it works without any room-admin rights.
 * Writes are cold Observables; the change syncs to every device.
 */
@Injectable({ providedIn: 'root' })
export class IgnoredUsersService {
  private readonly matrix = inject(IdentityMatrixPort);

  /** Whether `userId` is currently ignored. */
  isIgnored(userId: string): boolean {
    return (
      this.matrix.isAvailable() &&
      this.matrix.active().client.isUserIgnored(userId)
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
      const operation: IdentityOperation = ignored
        ? 'ignore-user'
        : 'unignore-user';
      if (!this.matrix.isAvailable()) {
        throw identityNotReady(operation);
      }
      const client = this.matrix.active().client;
      const current = client.getIgnoredUsers();
      const next = ignored
        ? [...new Set([...current, userId])]
        : current.filter((id) => id !== userId);
      return from(client.setIgnoredUsers(next)).pipe(map(() => void 0));
    }).pipe(
      recoverIdentityOperation(ignored ? 'ignore-user' : 'unignore-user'),
    );
  }
}
