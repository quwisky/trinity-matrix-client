import { Observable, defer } from 'rxjs';
import type { ApplicationRuntimeAdapter } from './application-runtime.adapter';
import type {
  ApplicationStartupStage,
  ApplicationStartupStageOutcome,
} from './application-runtime.models';

/** Selects one cold adapter command for an ordered startup stage. */
export function applicationStartupStageCommand(
  adapter: ApplicationRuntimeAdapter,
  stage: ApplicationStartupStage,
): Observable<ApplicationStartupStageOutcome> {
  const commands: Record<
    ApplicationStartupStage,
    () => Observable<ApplicationStartupStageOutcome>
  > = {
    'host-negotiation': () => adapter.negotiateHost(),
    'preference-hydration': () => adapter.hydratePreferences(),
    'account-restoration': () => adapter.restoreAccounts(),
    'session-capabilities': () => adapter.establishSessionCapabilities(),
    'workspace-restoration': () => adapter.restoreWorkspace(),
    readiness: () => adapter.awaitReadiness(),
  };
  return defer(commands[stage]);
}
