import {
  APPLICATION_STARTUP_PRODUCERS,
  APPLICATION_STARTUP_STAGES,
  SESSION_LOCK_UNAVAILABLE_COPY,
  type ApplicationStartupProducer,
  type ApplicationStartupProducerSettlement,
  type ApplicationStartupRecovery,
} from './application-runtime.models';

export interface StartupStatusEntry {
  readonly producer: ApplicationStartupProducer | 'runtime';
  readonly stage: string;
  readonly heading: string;
  readonly consequence: string;
}

export function startupBlockerConsequence(
  recovery: ApplicationStartupRecovery,
): string {
  switch (recovery) {
    case 'retry-startup':
      return 'A required startup dependency is unavailable. Routed content stays closed until it is ready.';
    case 'reset-preferences':
      return 'Required preference defaults are unavailable. Resetting affects settings on this device.';
    case 'reauthenticate':
      return 'The required Account session is unavailable. Reauthentication removes its local session first.';
    case 'reset-installation':
      return 'Required local Account data is unavailable. Resetting erases Trinity data on this installation.';
  }
}

/** A secondary recovery names what it does: removal, not a fresh sign-in. */
export function secondaryRecoveryLabel(
  recovery: ApplicationStartupRecovery,
): string {
  return recovery === 'reauthenticate'
    ? 'Remove account'
    : startupRecoveryLabel(recovery);
}

export function startupRecoveryLabel(
  recovery: ApplicationStartupRecovery,
): string {
  switch (recovery) {
    case 'retry-startup':
      return 'Retry startup';
    case 'reset-preferences':
      return 'Reset preferences';
    case 'reauthenticate':
      return 'Sign in again';
    case 'reset-installation':
      return 'Reset this installation';
  }
}

export const STARTUP_STATUS_COPY = {
  'host-contract': {
    heading: 'Device integration could not be prepared',
    consequence: 'Trinity cannot safely use this host yet.',
  },
  'session-lock': {
    heading: SESSION_LOCK_UNAVAILABLE_COPY.heading,
    consequence: SESSION_LOCK_UNAVAILABLE_COPY.body,
  },
  'preference-hydration': {
    heading: 'Safe settings could not be prepared',
    consequence: 'Trinity cannot establish a safe settings baseline.',
  },
  'account-registry': {
    heading: 'Accounts could not be restored',
    consequence: 'The required Account session is unavailable.',
  },
  'room-library': {
    heading: 'Rooms could not be prepared',
    consequence: 'The required Room library is unavailable.',
  },
  'room-order': {
    heading: 'Saved Room ordering could not be prepared',
    consequence: 'Rooms may not use their saved order.',
  },
  'browser-storage-persistence': {
    heading: 'Protected local storage could not be prepared',
    consequence: 'Local Trinity data may be cleared under storage pressure.',
  },
  workspace: {
    heading: 'The workspace could not be restored',
    consequence: 'Trinity cannot open a safe application destination.',
  },
  readiness: {
    heading: 'Application readiness could not be confirmed',
    consequence: 'Trinity cannot safely expose the workspace yet.',
  },
} as const satisfies Record<
  ApplicationStartupProducer,
  { readonly heading: string; readonly consequence: string }
>;

export function startupStatusEntry(
  settlement: ApplicationStartupProducerSettlement,
): StartupStatusEntry {
  return {
    producer: settlement.producer,
    stage: settlement.stage,
    ...STARTUP_STATUS_COPY[settlement.producer],
  };
}

export function startupSettlementOrder(
  a: ApplicationStartupProducerSettlement,
  b: ApplicationStartupProducerSettlement,
): number {
  return (
    APPLICATION_STARTUP_STAGES.indexOf(a.stage) -
      APPLICATION_STARTUP_STAGES.indexOf(b.stage) ||
    APPLICATION_STARTUP_PRODUCERS.indexOf(a.producer) -
      APPLICATION_STARTUP_PRODUCERS.indexOf(b.producer)
  );
}
