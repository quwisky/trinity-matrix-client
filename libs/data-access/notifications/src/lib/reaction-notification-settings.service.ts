import { Injectable, computed, inject } from '@angular/core';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { unwrapEngineResult } from '@trinity/util/matrix';
import { Observable, defer, map, throwError } from 'rxjs';
import { NOTIFICATION_ENGINE } from './notification-engine.token';
import { NotificationSettingsStore } from './notification-settings.store';

/** Whether reactions to the account's own messages notify; off unless the account opts in. */
@Injectable({ providedIn: 'root' })
export class ReactionNotificationSettingsService {
  private readonly engine = inject(NOTIFICATION_ENGINE);
  private readonly store = inject(NotificationSettingsStore);
  private readonly session = inject(SessionStateService);

  /** The active account's preference. */
  readonly enabled = computed(() => this.isOn());

  /** The preference of `accountId`, else of the active account. */
  isOn(accountId?: string): boolean {
    const owner = accountId ?? this.session.activeAccountId();
    return owner ? this.store.settings(owner).reactionNotifications : false;
  }

  /** Persist the active account's preference to account data. Cold: runs on subscribe. */
  setOn(on: boolean): Observable<void> {
    return defer(() => {
      const accountId = this.session.activeAccountId();
      if (!accountId) {
        return throwError(() => new Error('Not signed in.'));
      }
      return this.engine
        .setPreference(accountId, 'reactionNotifications', on)
        .pipe(
          unwrapEngineResult<null>(),
          map(() => undefined),
        );
    });
  }
}
