import type {
  ApplicationRuntimeState,
  ApplicationStartOutcome,
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
  const stage =
    current.phase === 'starting' ? current.stage : 'session-capabilities';
  const warnings = 'warnings' in current ? current.warnings : [];
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
    warnings,
    settlements: withDependencySkips(
      stage,
      settlements,
      stageSettlements(stage, stageOutcome),
    ),
  };
}
