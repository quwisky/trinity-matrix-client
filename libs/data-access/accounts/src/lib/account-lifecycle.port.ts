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
  releaseSharedCaches(): void;
  clearDrafts(): void;
}

const NOOP_ACCOUNT_LIFECYCLE_PORT: AccountLifecyclePort = {
  forgetPushHandoff: () => of(void 0),
  registerNotifications: () => of(void 0),
  unregisterNotifications: () => of(void 0),
  revokeProviderSession: () => of(void 0),
  releaseSharedCaches: () => undefined,
  clearDrafts: () => undefined,
};

export const ACCOUNT_LIFECYCLE_PORT = new InjectionToken<AccountLifecyclePort>(
  'account-runtime.lifecycle-port',
  { factory: () => NOOP_ACCOUNT_LIFECYCLE_PORT },
);
