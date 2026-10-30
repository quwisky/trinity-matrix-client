import { Injectable, computed, inject, signal, untracked } from '@angular/core';
import { Observable, defer, map } from 'rxjs';
import {
  projectActiveAccount,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import { unwrapEngineResult } from '@trinity/util/matrix';
import { IDENTITY_ENGINE } from './identity-engine.token';
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
  private readonly engine = inject(IDENTITY_ENGINE);
  private readonly session = inject(SessionStateService);
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

  private readonly projection = projectActiveAccount<readonly IgnoredUser[]>({
    id: 'identity.ignored-users',
    subscribe: (accountId) => this.engine.ignoredUsers(accountId),
    rebuild: (users) => this._ignoredUsers.set(users),
    reset: () => this._ignoredUsers.set(NONE),
  });

  /** Cold projection lifetime; each surface that reads the list holds it while shown. */
  runProjection(): Observable<void> {
    return this.projection.run();
  }

  /**
   * Whether the active account blocks `userId`, as projected. False while no
   * {@link runProjection} is held, so a caller outside a surface that holds it must hold it too.
   */
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
    const operation: IdentityOperation = ignored
      ? 'ignore-user'
      : 'unignore-user';
    return defer(() => {
      const accountId = untracked(this.session.activeAccountId);
      if (!accountId) {
        throw identityNotReady(operation);
      }
      return this.engine.setIgnored(accountId, userId, ignored);
    }).pipe(
      unwrapEngineResult(),
      map(() => void 0),
      recoverIdentityOperation(operation),
    );
  }
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
