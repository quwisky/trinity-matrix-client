import type {
  ApplicationRuntimeState,
  ApplicationStartOutcome,
  ApplicationStartupStage,
  ApplicationStartupStageOutcome,
} from './application-runtime.models';
import {
  stageSettlements,
  withDependencySkips,
} from './application-startup-settlements';

/** Builds one safe blocker from the currently observed startup stage. */
export function startupFailureOutcome(
  attempt: number,
  current: ApplicationRuntimeState,
  code: string,
): Extract<ApplicationStartOutcome, { readonly kind: 'blocked' }> {
  const stage = failedStage(current);
  const settlements = 'settlements' in current ? current.settlements : [];
  const stageOutcome: ApplicationStartupStageOutcome = {
    kind: 'blocked',
    recovery: 'retry-startup',
    diagnostic: { code },
  };
  const failure = {
    stage,
    recovery: 'retry-startup',
    diagnostic: stageOutcome.diagnostic,
  } as const;
  return {
    kind: 'blocked',
    attempt,
    failure,
    settlements: withDependencySkips(
      stage,
      settlements,
      stageSettlements(stage, stageOutcome),
    ),
  };
}

function failedStage(
  current: ApplicationRuntimeState,
): ApplicationStartupStage {
  if (current.phase === 'starting') return current.stage;
  // Only the session lock has run for a tab still waiting for another tab.
  if (current.phase === 'waiting-for-session') return 'session-lock';
  return 'session-capabilities';
}
