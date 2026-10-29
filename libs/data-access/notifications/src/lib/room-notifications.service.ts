import { Injectable, inject } from '@angular/core';
import { Observable, defer, forkJoin, map, throwError } from 'rxjs';
import {
  SessionStateService,
  projectActiveAccount,
} from '@trinity/data-access/matrix-client';
import { EngineRequestError, unwrapEngineResult } from '@trinity/util/matrix';
import type { RoomNotifyMode } from './notification-engine';
import { NOTIFICATION_ENGINE } from './notification-engine.token';
import { NotificationSettingsStore } from './notification-settings.store';

export type { RoomNotifyMode } from './notification-engine';
export type RoomNotifyDisplayMode = RoomNotifyMode | 'mixed';

/** Reads and writes a room's notification level via Matrix push rules: the preference, not delivery. */
@Injectable({ providedIn: 'root' })
export class RoomNotificationsService {
  private readonly engine = inject(NOTIFICATION_ENGINE);
  private readonly store = inject(NotificationSettingsStore);
  private readonly session = inject(SessionStateService);
  private readonly projection = projectActiveAccount({
    id: 'notifications.room-rules',
    subscribe: (accountId) => this.engine.settings(accountId),
    rebuild: () => this.acknowledgeRules(),
  });

  /** Cold rule projection retained by the named Notification session lifetime. */
  runProjection(): Observable<void> {
    return this.projection.run();
  }

  /** Reconcile the retained rules projection without replacing its listener owner. */
  retryProjection(): void {
    this.projection.schedule();
  }

  /** The room's current notification mode. Pass `accountId` for a room owned by a
   * non-active account (the mixed-account view) so the mode is read from the account that
   * actually holds the rules. */
  modeFor(roomId: string, accountId?: string): RoomNotifyMode {
    const owner = accountId ?? this.session.activeAccountId();
    return owner
      ? (this.store.settings(owner).roomModes[roomId] ?? 'all')
      : 'all';
  }

  /** Aggregate the state represented by one merged room row. */
  modeForAccounts(
    roomId: string,
    accountIds?: readonly string[],
  ): RoomNotifyDisplayMode {
    const ids = accountIds?.length ? [...new Set(accountIds)] : [undefined];
    const modes = ids.map((accountId) => this.modeFor(roomId, accountId));
    const first = modes[0] ?? 'all';
    return modes.every((mode) => mode === first) ? first : 'mixed';
  }

  /**
   * Refresh and read one exact Account-and-Room notification mode from its homeserver.
   *
   * Unlike {@link modeFor}, never turns a missing Account into the guessed default `all`,
   * so unavailable and failed reads stay distinguishable from a real server answer. Cold
   * and finite.
   */
  readMode(roomId: string, accountId: string): Observable<RoomNotifyMode> {
    return this.engine
      .readRoomMode(accountId, roomId)
      .pipe(unwrapEngineResult());
  }

  /** Apply a notification mode, replacing the room's own rules. Cold. */
  setMode(
    roomId: string,
    mode: RoomNotifyMode,
    accountId?: string,
  ): Observable<void> {
    return this.setModeForAccounts(
      roomId,
      mode,
      accountId ? [accountId] : undefined,
    );
  }

  /**
   * Apply one mode to every account represented by a merged room row. Each account is
   * written on its own; when any fails, this errors with the first failure after all have
   * settled, and the others keep the new mode.
   */
  setModeForAccounts(
    roomId: string,
    mode: RoomNotifyMode,
    accountIds?: readonly string[],
  ): Observable<void> {
    return defer(() => {
      const activeId = this.session.activeAccountId();
      const ids = accountIds?.length
        ? [...new Set(accountIds)]
        : activeId
          ? [activeId]
          : [];
      if (!ids.length) {
        return throwError(() => new Error('Not signed in.'));
      }
      return forkJoin(
        ids.map((id) => this.engine.setRoomMode(id, roomId, mode)),
      ).pipe(
        map((results) => {
          for (const result of results) {
            if (!result.ok) throw new EngineRequestError(result.failure);
          }
        }),
      );
    });
  }

  /** The store owns the read model, so a reconcile only acknowledges the rules; a method
   * rather than inline so the health journey can fault it. */
  private acknowledgeRules(): void {
    return;
  }
}
