import type {
  ApplicationStartupProducer,
  ApplicationStartupProducerSettlement,
} from '../application-runtime.models';

export interface OptionalProducerOutcome {
  readonly settlement: ApplicationStartupProducerSettlement;
}

export function optionalProducerReady(
  producer: ApplicationStartupProducer,
): OptionalProducerOutcome {
  return {
    settlement: {
      producer,
      stage: 'session-capabilities',
      status: 'ready',
    },
  };
}

export function optionalProducerDegraded(
  producer: ApplicationStartupProducer,
  code: string,
): OptionalProducerOutcome {
  return {
    settlement: {
      producer,
      stage: 'session-capabilities',
      status: 'degraded',
      diagnostic: { code },
    },
  };
}

/** A producer whose scoped health is its warning surface, in place of a global warning. */
