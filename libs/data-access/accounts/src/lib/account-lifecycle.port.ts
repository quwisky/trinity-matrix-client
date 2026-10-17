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
  registerNotifications(): Observable<void>;
  unregisterNotifications(accountId?: string): Observable<void>;
  revokeProviderSession(session: MatrixSession): Observable<void>;
  /**
   * Stop the on-device diagnostic log for the rest of the session and delete it, ahead of
   * the installation reset's database wipe, so no pending write recreates it afterwards.
   * Settles once no write is under way.
   */
  stopDiagnosticLog(): Observable<void>;
  /**
   * After the installation reset's wipes: start a fresh diagnostic log for the rest of the
   * session if its setting is back to its default (on), without saving the setting, so an
   * app that keeps running after the reset logs again as a fresh installation would.
   */
  resumeDiagnosticLog(): Observable<void>;
  releaseSharedCaches(): void;
  clearDrafts(): void;
  /** Forget a deleted account's account- and conversation-scoped device preferences. */
  forgetAccountPreferences(accountId: string): Observable<void>;
}

const NOOP_ACCOUNT_LIFECYCLE_PORT: AccountLifecyclePort = {
  forgetPushHandoff: () => of(void 0),
  registerNotifications: () => of(void 0),
  unregisterNotifications: () => of(void 0),
  revokeProviderSession: () => of(void 0),
  stopDiagnosticLog: () => of(void 0),
  resumeDiagnosticLog: () => of(void 0),
  releaseSharedCaches: () => undefined,
  clearDrafts: () => undefined,
  forgetAccountPreferences: () => of(void 0),
};

export const ACCOUNT_LIFECYCLE_PORT = new InjectionToken<AccountLifecyclePort>(
  'account-runtime.lifecycle-port',
  { factory: () => NOOP_ACCOUNT_LIFECYCLE_PORT },
);
