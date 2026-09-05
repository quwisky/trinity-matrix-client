import { ROOM_LIBRARY_PREPARATION_BUDGET_MS } from '@trinity/data-access/room-library';
import {
  APPLICATION_STARTUP_PRODUCERS,
  type ApplicationStartupProducer,
  type ApplicationStartupStage,
} from './application-runtime.models';

interface ApplicationStartupProducerPolicy {
  readonly stage: ApplicationStartupStage;
  readonly required: boolean;
  readonly compatibility?: boolean;
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
    compatibility: true,
    budgetMs: 30_000,
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

/** No required producer remains behind the legacy warning compatibility path. */
export const REQUIRED_STARTUP_PRODUCER_COMPATIBILITY = [] as const;

const OPTIONAL_PREPARATION_ALLOWANCE_MS = Math.max(
  APPLICATION_STARTUP_PRODUCER_POLICIES['room-order'].budgetMs,
  APPLICATION_STARTUP_PRODUCER_POLICIES['browser-storage-persistence'].budgetMs,
);
const REQUIRED_PATH_BUDGET_MS = Object.values(
  APPLICATION_STARTUP_PRODUCER_POLICIES,
)
  .filter((policy) => policy.required)
  .reduce((total, policy) => total + policy.budgetMs, 0);
const COMPATIBILITY_PATH_BUDGET_MS = Object.values(
  APPLICATION_STARTUP_PRODUCER_POLICIES,
)
  .filter((policy) => 'compatibility' in policy && policy.compatibility)
  .reduce((total, policy) => total + policy.budgetMs, 0);

/** Longest declared required path plus the still-compatible preference stage. */
export const APPLICATION_STARTUP_WATCHDOG_BUDGET_MS =
  REQUIRED_PATH_BUDGET_MS +
  COMPATIBILITY_PATH_BUDGET_MS +
  OPTIONAL_PREPARATION_ALLOWANCE_MS;

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
