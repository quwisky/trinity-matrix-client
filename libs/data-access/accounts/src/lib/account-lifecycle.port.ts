import { InjectionToken } from '@angular/core';
import type { MatrixSession } from '@trinity/util/matrix';
import { Observable, of } from 'rxjs';

/** App-shell integrations needed by Account Runtime without crossing capability boundaries. */
export interface AccountLifecyclePort {
  /**
   * Remove one account from the native push handoff store, or empty it without an id.
   * The first step of signing an account out, ahead of anything that invalidates its token.
   */
  forgetPushHandoff(accountId?: string): Observable<void>;
  /**
   * Empty the native push handoff store of every account but `keepAccountId`, whose entry is
   * written again: a sign-in that replaced every other live account.
   */
  forgetOtherPushHandoffs(keepAccountId: string): Observable<void>;
  registerNotifications(): Observable<void>;
  unregisterNotifications(accountId?: string): Observable<void>;
  /** Errors when a token may stay live at the provider, which a reset records as residue. */
  revokeProviderSession(session: MatrixSession): Observable<void>;
  /** Delete one account's recorded mention history, after its client has stopped. */
  forgetMentionHistory(accountId: string): Observable<void>;
  /**
   * Whether an account, or with none named any on this device, has recorded mentions. A read
   * that fails or doesn't answer in time gives `ifUnknown`, which defaults to false.
   */
  hasMentionHistory(
    accountId?: string,
    ifUnknown?: boolean,
  ): Observable<boolean>;
  /** Stop recording mentions and settle once no write is under way, ahead of a database wipe. */
  stopMentionIndex(): Observable<void>;
  releaseSharedCaches(): void;
  clearDrafts(): void;
  /** Forget a deleted account's account- and conversation-scoped device preferences. */
  forgetAccountPreferences(accountId: string): Observable<void>;
}

const NOOP_ACCOUNT_LIFECYCLE_PORT: AccountLifecyclePort = {
  forgetPushHandoff: () => of(void 0),
  forgetOtherPushHandoffs: () => of(void 0),
  registerNotifications: () => of(void 0),
  unregisterNotifications: () => of(void 0),
  revokeProviderSession: () => of(void 0),
  forgetMentionHistory: () => of(void 0),
  hasMentionHistory: () => of(false),
  stopMentionIndex: () => of(void 0),
  releaseSharedCaches: () => undefined,
  clearDrafts: () => undefined,
  forgetAccountPreferences: () => of(void 0),
};

export const ACCOUNT_LIFECYCLE_PORT = new InjectionToken<AccountLifecyclePort>(
  'account-runtime.lifecycle-port',
  { factory: () => NOOP_ACCOUNT_LIFECYCLE_PORT },
);
