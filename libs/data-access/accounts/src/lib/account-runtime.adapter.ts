import { InjectionToken, Signal, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { MatrixAccountRuntimeAdapter } from './matrix-account-runtime.adapter';
import type { AuthenticatedAccountGrant } from './authenticated-account-grant';
import type {
  AccountCleanupIssue,
  AccountEstablishmentFailure,
  AccountEstablishmentIntent,
  AccountRestoreFailure,
  AccountRestoreRole,
  AccountSignOutOutcome,
  AccountSwitchFailure,
  InstallationResetOutcome,
} from './account-runtime.models';

export type SavedAccountsSnapshot =
  | {
      readonly kind: 'available';
      readonly activeAccountId: string | null;
      readonly accountIds: readonly string[];
    }
  | { readonly kind: 'corrupt-local-state' };

export type AdapterAccountRestoreOutcome =
  | { readonly kind: 'ready' }
  | { readonly kind: 'reauthentication-required' }
  | { readonly kind: 'failed'; readonly failure: AccountRestoreFailure };

export type AdapterAccountEstablishmentOutcome =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'failed';
      readonly failure: AccountEstablishmentFailure;
    };

export type AdapterAccountSwitchOutcome =
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly failure: AccountSwitchFailure };

export interface AccountRuntimeAdapter {
  readonly activeAccountId: Signal<string | null>;
  sweepOrphanedStores(): Observable<void>;
  readSavedAccounts(): Observable<SavedAccountsSnapshot>;
  restoreAccount(
    accountId: string,
    role: AccountRestoreRole,
  ): Observable<AdapterAccountRestoreOutcome>;
  establishAccount(
    grant: AuthenticatedAccountGrant,
    intent: AccountEstablishmentIntent,
  ): Observable<AdapterAccountEstablishmentOutcome>;
  prepareActiveAccount(
    accountId: string,
  ): Observable<AdapterAccountSwitchOutcome>;
  commitActiveAccount(
    accountId: string,
  ): Observable<AdapterAccountSwitchOutcome>;
  signOutAccount(accountId: string): Observable<AccountSignOutOutcome>;
  retrySignOutCleanup(
    accountId: string,
    issues: readonly AccountCleanupIssue[],
  ): Observable<AccountSignOutOutcome>;
  resetInstallation(): Observable<InstallationResetOutcome>;
  retryInstallationCleanup(
    issues: readonly AccountCleanupIssue[],
  ): Observable<InstallationResetOutcome>;
}

export interface AccountRestorePolicy {
  readonly timeoutMs: number;
  readonly concurrency: number;
}

export const ACCOUNT_RUNTIME_ADAPTER =
  new InjectionToken<AccountRuntimeAdapter>('account-runtime.adapter', {
    providedIn: 'root',
    factory: () => inject(MatrixAccountRuntimeAdapter),
  });

export const ACCOUNT_RESTORE_POLICY = new InjectionToken<AccountRestorePolicy>(
  'account-runtime.restore-policy',
  {
    providedIn: 'root',
    factory: () => ({ timeoutMs: 30_000, concurrency: 4 }),
  },
);
