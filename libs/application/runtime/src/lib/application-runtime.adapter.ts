import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  ApplicationRecoveryAdapterOutcome,
  ApplicationSessionEvent,
  ApplicationSessionLockOutcome,
  ApplicationStartupRecovery,
  ApplicationStartupStageOutcome,
} from './application-runtime.models';

/** Host composition supplied at the Application Runtime seam. */
export interface ApplicationRuntimeAdapter {
  negotiateHost(): Observable<ApplicationStartupStageOutcome>;
  /** Claims this tab's one running session: `waiting` when another tab has it. */
  acquireSessionLock(): Observable<ApplicationSessionLockOutcome>;
  /** Emits once this tab holds the session lock it waited for. */
  awaitSessionLock(): Observable<void>;
  hydratePreferences(): Observable<ApplicationStartupStageOutcome>;
  restoreAccounts(): Observable<ApplicationStartupStageOutcome>;
  establishSessionCapabilities(): Observable<ApplicationStartupStageOutcome>;
  restoreWorkspace(): Observable<ApplicationStartupStageOutcome>;
  awaitReadiness(): Observable<ApplicationStartupStageOutcome>;
  recover(
    recovery: ApplicationStartupRecovery,
  ): Observable<ApplicationRecoveryAdapterOutcome>;

  /** Starts after preference hydration and lives until the Application Runtime stops. */
  runPreferenceLifetime(): Observable<never>;

  /** Prepares before Workspace restoration and opens live streams after final readiness. */
  runSession(readiness: Observable<void>): Observable<ApplicationSessionEvent>;
}

export const APPLICATION_RUNTIME_ADAPTER =
  new InjectionToken<ApplicationRuntimeAdapter>('APPLICATION_RUNTIME_ADAPTER');
