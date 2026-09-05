import { ROOM_LIBRARY_PREPARATION_BUDGET_MS } from '@trinity/data-access/room-library';
import {
  APPLICATION_STARTUP_PRODUCERS,
  APPLICATION_STARTUP_STAGES,
  type ApplicationStartupProducer,
  type ApplicationStartupStage,
} from './application-runtime.models';

interface ApplicationStartupProducerPolicy {
  readonly stage: ApplicationStartupStage;
  readonly required: boolean;
  readonly budgetMs: number;
  readonly automaticRetryLimit: 0;
  readonly timeoutCode: string;
  readonly attemptBudgetMs?: number;
}

/**
 * The one startup producer ledger. Sibling migrations add outcomes here rather than
 * introducing another orchestrator. Promise-backed deadlines stop observation only;
 * late work is rejected by the runtime attempt or adapter generation.
 */
export const APPLICATION_STARTUP_PRODUCER_POLICIES = {
  'host-contract': {
    stage: 'host-negotiation',
    required: true,
    budgetMs: 10_000,
    automaticRetryLimit: 0,
    timeoutCode: 'host-negotiation-timeout',
  },
  'preference-hydration': {
    stage: 'preference-hydration',
    required: false,
    budgetMs: 10_000,
    automaticRetryLimit: 0,
    timeoutCode: 'preference-hydration-timeout',
  },
  'account-registry': {
    stage: 'account-restoration',
    required: true,
    budgetMs: 150_000,
    automaticRetryLimit: 0,
    timeoutCode: 'account-restoration-timeout',
  },
  'room-library': {
    stage: 'session-capabilities',
    required: true,
    budgetMs: ROOM_LIBRARY_PREPARATION_BUDGET_MS,
    automaticRetryLimit: 0,
    timeoutCode: 'room-library-projection-preparation-timeout',
  },
  'room-order': {
    stage: 'session-capabilities',
    required: false,
    budgetMs: 5_000,
    automaticRetryLimit: 0,
    timeoutCode: 'room-order-hydration-timeout',
  },
  'browser-storage-persistence': {
    stage: 'session-capabilities',
    required: false,
    budgetMs: 2_000,
    automaticRetryLimit: 0,
    timeoutCode: 'storage-persistence-timeout',
  },
  workspace: {
    stage: 'workspace-restoration',
    required: true,
    budgetMs: 15_000,
    automaticRetryLimit: 0,
    timeoutCode: 'workspace-restoration-timeout',
    attemptBudgetMs: 7_000,
  },
  readiness: {
    stage: 'readiness',
    required: true,
    budgetMs: 30_000,
    automaticRetryLimit: 0,
    timeoutCode: 'application-readiness-timeout',
  },
} as const satisfies Record<
  ApplicationStartupProducer,
  ApplicationStartupProducerPolicy
>;

/**
 * The stages are serial, while producers within one stage settle in parallel. The watchdog
 * therefore owns the sum of each stage's longest declared producer budget, including optional
 * serial stages such as preference hydration.
 */
export const APPLICATION_STARTUP_WATCHDOG_BUDGET_MS =
  APPLICATION_STARTUP_STAGES.reduce(
    (pathBudget, stage) =>
      pathBudget +
      Math.max(
        ...Object.values(APPLICATION_STARTUP_PRODUCER_POLICIES)
          .filter((policy) => policy.stage === stage)
          .map((policy) => policy.budgetMs),
      ),
    0,
  );

export function startupProducersForStage(
  stage: ApplicationStartupStage,
): readonly ApplicationStartupProducer[] {
  return APPLICATION_STARTUP_PRODUCERS.filter(
    (producer) =>
      APPLICATION_STARTUP_PRODUCER_POLICIES[producer].stage === stage,
  );
}

export function requiredStartupPolicyForStage(
  stage: ApplicationStartupStage,
): ApplicationStartupProducerPolicy | null {
  return (
    Object.values(APPLICATION_STARTUP_PRODUCER_POLICIES).find(
      (policy) => policy.required && policy.stage === stage,
    ) ?? null
  );
}
