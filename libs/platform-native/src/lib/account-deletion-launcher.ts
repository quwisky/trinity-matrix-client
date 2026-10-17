import { InjectionToken, type Signal } from '@angular/core';
import type { Observable } from 'rxjs';

/** How deletion works for an account, decided by what its server supports. */
export type AccountDeletionPlan =
  /** The legacy account API: Trinity deletes the account itself. */
  | { readonly kind: 'in-app' }
  /** An OAuth 2.0 server: the provider's page deletes it; null when none is published. */
  | { readonly kind: 'provider'; readonly url: string | null };

/** The re-authentication answers the deletion dialog collects. */
export interface AccountDeletionPrompts {
  /** The account's password, or null to go back; `rejected` when the last one was refused. */
  password(context: { readonly rejected: boolean }): Promise<string | null>;
  /** Resolves true once the person reports the page finished, false to go back. */
  confirmInBrowser(step: {
    readonly url: string;
    readonly pending: boolean;
  }): Promise<boolean>;
}

/** Why an account was not deleted. */
export type AccountDeletionRefusal =
  | 'cancelled'
  | 'attempts-exceeded'
  | 'no-usable-stage'
  | 'unsupported'
  | 'forbidden'
  | 'rate-limited'
  | 'unreachable'
  | 'still-active'
  | 'signed-out'
  | 'busy'
  | 'account-unavailable'
  | 'failed';

/** How a deletion request ended, for the surface that asked. */
export type AccountDeletionOutcome =
  /** Deleted; the flow has closed Settings, moved on and said so. */
  | { readonly kind: 'deleted' }
  | {
      readonly kind: 'kept';
      readonly reason: AccountDeletionRefusal;
      readonly retryAfterMs?: number;
    }
  /** The server may or may not have deleted it; asking again can settle it. */
  | { readonly kind: 'unconfirmed' };

export interface AccountDeletionLauncher {
  plan(accountId: string): Observable<AccountDeletionPlan>;
  delete(request: {
    readonly accountId: string;
    readonly erase: boolean;
    readonly prompts: AccountDeletionPrompts;
  }): Observable<AccountDeletionOutcome>;
  /** Ask the server whether the account still exists, and finish the deletion if not. */
  checkDeletion(accountId: string): Observable<AccountDeletionOutcome>;
  /** Open the provider page and remove the account here once its token stops working. */
  openProvider(accountId: string, url: string): Observable<boolean>;
  /**
   * The account whose deletion left no account behind, for the sign-in page's notice. It
   * can arrive after sign-in has opened: the last account's removal leads there itself.
   */
  readonly deletedNotice: Signal<string | null>;
  dismissDeletedNotice(): void;
}

/**
 * "Delete account" in Settings › Account and its notice on the sign-in page. Declared in
 * this shared tier because features may import neither Accounts nor an application
 * library. Application Runtime provides it.
 */
export const ACCOUNT_DELETION_LAUNCHER =
  new InjectionToken<AccountDeletionLauncher>('ACCOUNT_DELETION_LAUNCHER');
