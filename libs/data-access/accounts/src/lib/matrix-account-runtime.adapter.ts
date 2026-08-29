import { Injectable, inject } from '@angular/core';
import {
  MatrixClientService,
  type PersistedAccountStartOutcome,
} from '@trinity/data-access/matrix-client';
import { SessionStorageService } from '@trinity/platform-native';
import { Observable, catchError, map, of, switchMap } from 'rxjs';
import type {
  AccountRuntimeAdapter,
  AdapterAccountRestoreOutcome,
  SavedAccountsSnapshot,
} from './account-runtime.adapter';
import type { AccountRestoreRole } from './account-runtime.models';

@Injectable({ providedIn: 'root' })
export class MatrixAccountRuntimeAdapter implements AccountRuntimeAdapter {
  private readonly matrix = inject(MatrixClientService);
  private readonly storage = inject(SessionStorageService);

  readonly activeAccountId = this.matrix.activeUserId;

  sweepOrphanedStores(): Observable<void> {
    return this.storage.sweepOrphanedCryptoStores();
  }

  readSavedAccounts(): Observable<SavedAccountsSnapshot> {
    return this.storage.snapshot().pipe(
      map((snapshot) => ({
        kind: 'available' as const,
        activeAccountId: snapshot.activeAccountId,
        accountIds: snapshot.accounts.map((account) => account.userId),
      })),
      catchError(() => of({ kind: 'corrupt-local-state' as const })),
    );
  }

  restoreAccount(
    accountId: string,
    role: AccountRestoreRole,
  ): Observable<AdapterAccountRestoreOutcome> {
    return this.storage.load(accountId).pipe(
      map((session) => ({ kind: 'loaded' as const, session })),
      catchError(() =>
        of({
          kind: 'failed' as const,
          failure: 'corrupt-local-state' as const,
        }),
      ),
      switchMap((loaded) => {
        if (loaded.kind === 'failed') {
          return of(loaded);
        }
        const { session } = loaded;
        if (!session) {
          this.matrix.requireReauthentication(accountId);
          return of({ kind: 'reauthentication-required' as const });
        }
        return this.matrix
          .restorePersisted(
            session,
            role === 'active' ? 'activate' : 'background',
          )
          .pipe(map((outcome) => this.toAdapterOutcome(outcome)));
      }),
    );
  }

  private toAdapterOutcome(
    outcome: PersistedAccountStartOutcome,
  ): AdapterAccountRestoreOutcome {
    if (outcome.kind === 'ready') {
      return outcome;
    }
    return outcome.failure === 'reauthentication-required'
      ? { kind: 'reauthentication-required' }
      : { kind: 'failed', failure: outcome.failure };
  }
}
