import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, defer, from, map } from 'rxjs';
import {
  IDENTITY_MATRIX_EVENTS,
  IdentityMatrixPort,
  type IdentityMatrixClient,
} from '@trinity/data-access/matrix-client';
import {
  identityNotReady,
  recoverIdentityOperation,
  type IdentityOperation,
} from './identity-operation-error';

/** A blocked user as the active account knows them; the name is null when it never saw one. */
export interface IgnoredUser {
  readonly userId: string;
  readonly displayName: string | null;
  readonly avatarMxc: string | null;
}

const NONE: readonly IgnoredUser[] = [];

/**
 * The account-wide ignore ("block") list (`m.ignored_user_list`). Ignoring a user makes
 * the homeserver and SDK hide their events, so it works without any room-admin rights.
 * Writes are cold Observables; the change syncs to every device.
 */
@Injectable({ providedIn: 'root' })
export class IgnoredUsersService {
  private readonly matrix = inject(IdentityMatrixPort);
  private readonly _ignoredUsers = signal<readonly IgnoredUser[]>(NONE, {
    equal: sameUsers,
  });

  /** The active account's blocked users while {@link runProjection} is held; empty otherwise. */
  readonly ignoredUsers = this._ignoredUsers.asReadonly();
  readonly ignoredUserIds = computed(
    () => this._ignoredUsers().map((user) => user.userId),
    {
      equal: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
    },
  );

  private readonly projection = this.matrix.project({
    id: 'identity.ignored-users',
    events: [IDENTITY_MATRIX_EVENTS.accountData],
    rebuild: (client) => this._ignoredUsers.set(readIgnored(client)),
    reset: () => this._ignoredUsers.set(NONE),
  });

  /** Cold projection lifetime; each surface that reads the list holds it while shown. */
  runProjection(): Observable<void> {
    return this.projection.run();
  }

  /** Whether `userId` is blocked by the active account, as projected. */
  isIgnored(userId: string): boolean {
    return this.ignoredUserIds().includes(userId);
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

function readIgnored(client: IdentityMatrixClient): readonly IgnoredUser[] {
  return client.getIgnoredUsers().map((userId) => {
    const known = client.getUser(userId);
    return {
      userId,
      displayName: known?.displayName || null,
      avatarMxc: known?.avatarUrl || null,
    };
  });
}

function sameUsers(
  a: readonly IgnoredUser[],
  b: readonly IgnoredUser[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (user, i) =>
        user.userId === b[i].userId &&
        user.displayName === b[i].displayName &&
        user.avatarMxc === b[i].avatarMxc,
    )
  );
}
