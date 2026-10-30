import { Injectable, inject } from '@angular/core';
import { type Observable, catchError, forkJoin, map, of } from 'rxjs';
import { SessionStorageService } from '@trinity/platform-native';
import type { SessionStorageEffect } from './session-engine';

/** Every session storage write an engine owes, in one place. */
@Injectable({ providedIn: 'root' })
export class SessionStorageWrites {
  private readonly storage = inject(SessionStorageService);

  /** Errors only for `tokens-rotated`; logout writes are best-effort, as before. */
  apply(effect: SessionStorageEffect): Observable<void> {
    switch (effect.kind) {
      case 'tokens-rotated':
        return this.storage.updateTokens(
          effect.accountId,
          effect.lineage ?? undefined,
          effect.accessToken,
          effect.refreshToken ?? undefined,
          effect.expiresAt ?? undefined,
        );
      case 'soft-logout':
        return this.afterLogout(
          this.storage.invalidateToken(effect.accountId),
          effect.activeAccountId,
        );
      case 'hard-logout':
        return this.afterLogout(
          this.storage.remove(effect.accountId),
          effect.activeAccountId,
        );
    }
  }

  // The engine repoints by its own order and storage.remove by the record order; without the
  // repoint a restart could restore a different account than the UI shows. Both are sent at
  // once: storage queues them in order, and a switch made meanwhile lands after the repoint.
  private afterLogout(
    write: Observable<void>,
    activeAccountId: string | null,
  ): Observable<void> {
    return forkJoin([
      bestEffort(write),
      activeAccountId
        ? bestEffort(this.storage.setActive(activeAccountId))
        : of(undefined),
    ]).pipe(map(() => undefined));
  }
}

function bestEffort(write: Observable<void>): Observable<void> {
  return write.pipe(catchError(() => of(undefined)));
}
