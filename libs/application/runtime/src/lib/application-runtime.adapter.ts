import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  ApplicationRecoveryAdapterOutcome,
  ApplicationRuntimeWarning,
  ApplicationStartupRecovery,
  ApplicationStartupStageOutcome,
} from './application-runtime.models';

/** Host composition supplied at the Application Runtime seam. */
export interface ApplicationRuntimeAdapter {
  negotiateHost(): Observable<ApplicationStartupStageOutcome>;
  hydratePreferences(): Observable<ApplicationStartupStageOutcome>;
  restoreAccounts(): Observable<ApplicationStartupStageOutcome>;
  establishSessionCapabilities(): Observable<ApplicationStartupStageOutcome>;
  restoreWorkspace(): Observable<ApplicationStartupStageOutcome>;
  awaitReadiness(): Observable<ApplicationStartupStageOutcome>;
  recover(
    recovery: ApplicationStartupRecovery,
  ): Observable<ApplicationRecoveryAdapterOutcome>;

  /** Starts after preference hydration and lives until the Application Runtime stops. */
  runPreferenceLifetime(): Observable<ApplicationRuntimeWarning>;

  /** Lives until Application Runtime is stopped or the host application is destroyed. */
  runSession(): Observable<ApplicationRuntimeWarning>;
}

export const APPLICATION_RUNTIME_ADAPTER =
  new InjectionToken<ApplicationRuntimeAdapter>('APPLICATION_RUNTIME_ADAPTER');
