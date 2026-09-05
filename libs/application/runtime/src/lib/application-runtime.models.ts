import type {
  AccountCleanupIssue,
  AccountCleanupPending,
} from '@trinity/data-access/accounts';

export const APPLICATION_STARTUP_STAGES = [
  'host-negotiation',
  'preference-hydration',
  'account-restoration',
  'session-capabilities',
  'workspace-restoration',
  'readiness',
] as const;

export type ApplicationStartupStage =
  (typeof APPLICATION_STARTUP_STAGES)[number];

export const APPLICATION_STARTUP_PRODUCERS = [
  'host-contract',
  'preference-hydration',
  'account-registry',
  'room-library',
  'room-order',
  'browser-storage-persistence',
  'workspace',
  'readiness',
] as const;

export type ApplicationStartupProducer =
  (typeof APPLICATION_STARTUP_PRODUCERS)[number];

export interface ApplicationStartupProducerSettlement {
  readonly producer: ApplicationStartupProducer;
  readonly stage: ApplicationStartupStage;
  readonly status: 'ready' | 'degraded' | 'blocked' | 'dependency-skipped';
  readonly diagnostic?: ApplicationRuntimeDiagnostic;
}

export type ApplicationStartupRecovery =
  | 'retry-startup'
  | 'reset-preferences'
  | 'reauthenticate'
  | 'reset-installation';

/** Stable, value-free metadata suitable for logs and support reports. */
export interface ApplicationRuntimeDiagnostic {
  readonly code: string;
}

export interface ApplicationStartupFailure {
  readonly stage: ApplicationStartupStage;
  readonly recovery: ApplicationStartupRecovery;
  readonly diagnostic: ApplicationRuntimeDiagnostic;
}

/** Preparation and live events from the one owned Application Runtime session source. */
export type ApplicationSessionEvent =
  | { readonly kind: 'prepared' }
  | {
      readonly kind: 'blocked';
      readonly recovery: ApplicationStartupRecovery;
      readonly diagnostic: ApplicationRuntimeDiagnostic;
    };

export type ApplicationStartupStageOutcome =
  | {
      readonly kind: 'ready';
      readonly settlements?: readonly ApplicationStartupProducerSettlement[];
    }
  | {
      readonly kind: 'blocked';
      readonly recovery: ApplicationStartupRecovery;
      readonly diagnostic: ApplicationRuntimeDiagnostic;
      readonly settlements?: readonly ApplicationStartupProducerSettlement[];
    };

export type ApplicationStartOutcome =
  | {
      readonly kind: 'ready';
      readonly attempt: number;
      readonly settlements: readonly ApplicationStartupProducerSettlement[];
    }
  | {
      readonly kind: 'blocked';
      readonly attempt: number;
      readonly failure: ApplicationStartupFailure;
      readonly settlements: readonly ApplicationStartupProducerSettlement[];
    };

export type ApplicationRuntimeState =
  | { readonly phase: 'stopped' }
  | {
      readonly phase: 'starting';
      readonly attempt: number;
      readonly stage: ApplicationStartupStage;
      readonly settlements: readonly ApplicationStartupProducerSettlement[];
    }
  | {
      readonly phase: 'blocked';
      readonly attempt: number;
      readonly failure: ApplicationStartupFailure;
      readonly settlements: readonly ApplicationStartupProducerSettlement[];
    }
  | {
      readonly phase: 'ready';
      readonly attempt: number;
      readonly settlements: readonly ApplicationStartupProducerSettlement[];
    }
  | { readonly phase: 'stopping'; readonly attempt: number };

export type ApplicationRecoveryOutcome =
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'unavailable';
      readonly reason:
        'not-blocked' | 'recovery-failed' | 'transition-in-progress';
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'cleanup-in-progress';
      readonly cleanup: {
        readonly issues: readonly AccountCleanupIssue[];
        readonly pending: readonly AccountCleanupPending[];
      };
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'partial-cleanup';
      readonly cleanup: { readonly issues: readonly AccountCleanupIssue[] };
    };

export type ApplicationRecoveryAdapterOutcome =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'recovery-failed' | 'transition-in-progress';
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'cleanup-in-progress';
      readonly cleanup: {
        readonly issues: readonly AccountCleanupIssue[];
        readonly pending: readonly AccountCleanupPending[];
      };
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'partial-cleanup';
      readonly cleanup: { readonly issues: readonly AccountCleanupIssue[] };
    };

export type ApplicationStopOutcome =
  { readonly kind: 'stopped' } | { readonly kind: 'already-stopped' };
