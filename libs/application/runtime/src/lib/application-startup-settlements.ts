import {
  APPLICATION_STARTUP_PRODUCERS,
  APPLICATION_STARTUP_STAGES,
  type ApplicationStartupProducerSettlement,
  type ApplicationStartupStage,
  type ApplicationStartupStageOutcome,
} from './application-runtime.models';
import {
  APPLICATION_STARTUP_PRODUCER_POLICIES,
  startupProducersForStage,
} from './application-startup.policy';

export function recoveryStartIndex(stage: ApplicationStartupStage): number {
  const failedIndex = APPLICATION_STARTUP_STAGES.indexOf(stage);
  const sessionIndex = APPLICATION_STARTUP_STAGES.indexOf(
    'session-capabilities',
  );
  return failedIndex > sessionIndex ? sessionIndex : failedIndex;
}

export function warningsBefore(
  index: number,
  warnings: NonNullable<ApplicationStartupStageOutcome['warnings']>,
): NonNullable<ApplicationStartupStageOutcome['warnings']> {
  return warnings.filter(
    (warning) =>
      warning.stage !== 'session' &&
      APPLICATION_STARTUP_STAGES.indexOf(warning.stage) < index,
  );
}

export function settlementsBefore(
  index: number,
  settlements: readonly ApplicationStartupProducerSettlement[],
): readonly ApplicationStartupProducerSettlement[] {
  return settlements.filter(
    (settlement) =>
      APPLICATION_STARTUP_STAGES.indexOf(settlement.stage) < index,
  );
}

export function optionalSessionSettlements(
  outcome: ApplicationStartupStageOutcome,
): readonly ApplicationStartupProducerSettlement[] {
  if (outcome.settlements) return outcome.settlements;
  return startupProducersForStage('session-capabilities')
    .filter((producer) => producer !== 'room-library')
    .map((producer) => ({
      producer,
      stage: 'session-capabilities' as const,
      status:
        outcome.kind === 'ready' ? ('ready' as const) : ('blocked' as const),
      ...(outcome.kind === 'blocked' ? { diagnostic: outcome.diagnostic } : {}),
    }));
}

export function stageSettlements(
  stage: ApplicationStartupStage,
  outcome: ApplicationStartupStageOutcome,
): readonly ApplicationStartupProducerSettlement[] {
  if (outcome.settlements) return outcome.settlements;
  const producers =
    stage === 'session-capabilities'
      ? (['room-library'] as const)
      : startupProducersForStage(stage);
  return producers.map((producer) => ({
    producer,
    stage,
    status:
      outcome.kind === 'ready' ? ('ready' as const) : ('blocked' as const),
    ...(outcome.kind === 'blocked' ? { diagnostic: outcome.diagnostic } : {}),
  }));
}

export function withDependencySkips(
  blockedStage: ApplicationStartupStage,
  settlements: readonly ApplicationStartupProducerSettlement[],
  current: readonly ApplicationStartupProducerSettlement[],
): readonly ApplicationStartupProducerSettlement[] {
  const currentProducers = new Set(
    current.map((settlement) => settlement.producer),
  );
  const combined = [
    ...settlements.filter(
      (settlement) => !currentProducers.has(settlement.producer),
    ),
    ...current,
  ];
  const blockedIndex = APPLICATION_STARTUP_STAGES.indexOf(blockedStage);
  const retained = combined.filter(
    (settlement) =>
      APPLICATION_STARTUP_STAGES.indexOf(settlement.stage) <= blockedIndex,
  );
  const retainedProducers = new Set(
    retained.map((settlement) => settlement.producer),
  );
  const skipped = APPLICATION_STARTUP_PRODUCERS.filter((producer) => {
    const policy = APPLICATION_STARTUP_PRODUCER_POLICIES[producer];
    return (
      APPLICATION_STARTUP_STAGES.indexOf(policy.stage) > blockedIndex &&
      !retainedProducers.has(producer)
    );
  }).map((producer): ApplicationStartupProducerSettlement => ({
    producer,
    stage: APPLICATION_STARTUP_PRODUCER_POLICIES[producer].stage,
    status: 'dependency-skipped',
    diagnostic: { code: `dependency-blocked-by-${blockedStage}` },
  }));
  return [...retained, ...skipped];
}
