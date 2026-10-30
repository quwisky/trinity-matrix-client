import { Injectable, type Signal, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { plainEqual } from '@trinity/util/matrix';
import {
  connectivityOf,
  EMPTY_SESSION,
  type SessionAccountStatus,
  type SessionEngine,
  type SessionSnapshot,
  type SessionSyncState,
} from './session-engine';
import { SESSION_SNAPSHOT } from './session-engine.token';

/** A snapshot signal fed by any engine's `session()` stream, for engines without a sync snapshot. */
export function sessionSnapshotFrom(
  engine: SessionEngine,
): Signal<SessionSnapshot> {
  return toSignal(engine.session(), { initialValue: EMPTY_SESSION });
}

/** Plain-data view of the signed-in accounts. Derived values change only when their content does. */
@Injectable({ providedIn: 'root' })
export class SessionStateService {
  private readonly statuses = new Map<
    string,
    Signal<SessionAccountStatus | null>
  >();

  readonly snapshot = inject(SESSION_SNAPSHOT);

  readonly activeAccountId: Signal<string | null> = computed(
    () => this.snapshot().activeAccountId,
  );

  readonly accountIds: Signal<readonly string[]> = computed(
    () => this.snapshot().accounts.map((a) => a.accountId),
    { equal: plainEqual },
  );

  readonly softLoggedOut: Signal<readonly string[]> = computed(
    () => this.snapshot().softLoggedOut,
    { equal: plainEqual },
  );

  readonly active: Signal<SessionAccountStatus | null> = computed(
    () => this.statusIn(this.snapshot(), this.activeAccountId()),
    { equal: plainEqual },
  );

  readonly syncState: Signal<SessionSyncState | null> = computed(
    () => this.active()?.syncState ?? null,
  );

  readonly connectivity: Signal<'online' | 'offline'> = computed(() =>
    connectivityOf(this.syncState()),
  );

  readonly waitingCount: Signal<number> = computed(
    () => this.active()?.waitingCount ?? 0,
  );

  readonly cryptoStoreEncrypted: Signal<boolean | null> = computed(
    () => this.active()?.cryptoStoreEncrypted ?? null,
  );

  /** Reads the snapshot; the reference holds while this account's status is unchanged. */
  status(accountId: string): SessionAccountStatus | null {
    let status = this.statuses.get(accountId);
    if (!status) {
      status = computed(() => this.statusIn(this.snapshot(), accountId), {
        equal: plainEqual,
      });
      this.statuses.set(accountId, status);
    }
    return status();
  }

  private statusIn(
    snapshot: SessionSnapshot,
    accountId: string | null,
  ): SessionAccountStatus | null {
    return snapshot.accounts.find((a) => a.accountId === accountId) ?? null;
  }
}
