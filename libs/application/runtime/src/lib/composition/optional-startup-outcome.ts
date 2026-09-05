import type {
  ApplicationStartupProducer,
  ApplicationStartupProducerSettlement,
  ApplicationStartupStageOutcome,
} from '../application-runtime.models';

type RuntimeWarning = NonNullable<
  ApplicationStartupStageOutcome['warnings']
>[number];

export interface OptionalProducerOutcome {
  readonly warnings: readonly RuntimeWarning[];
  readonly settlement: ApplicationStartupProducerSettlement;
}

export function optionalProducerReady(
  producer: ApplicationStartupProducer,
): OptionalProducerOutcome {
  return {
    warnings: [],
    settlement: {
      producer,
      stage: 'session-capabilities',
      status: 'ready',
    },
  };
}

export function optionalProducerDegraded(
  producer: ApplicationStartupProducer,
  warning: RuntimeWarning,
): OptionalProducerOutcome {
  return {
    warnings: [warning],
    settlement: {
      producer,
      stage: 'session-capabilities',
      status: 'degraded',
      diagnostic: warning.diagnostic,
    },
  };
}
