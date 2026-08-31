import type { E2EQuarantineEntry, E2ESerializationResource } from './types.mts';

export const E2E_SERIALIZATION_RESOURCES = [
  {
    key: 'android-avd',
    owner: 'trinity-e2e-support',
    description: 'One installed Android application, emulator and adb bridge.',
  },
  {
    key: 'electron',
    owner: 'trinity-e2e-support',
    description: 'One launched Electron application and user-data lifecycle.',
  },
  {
    key: 'crypto-spike',
    owner: 'trinity-e2e-support',
    description:
      'The shared crypto-spike driver and mutable renderer artifact used by both browser engines.',
  },
  {
    key: 'synapse',
    owner: 'trinity-e2e-support',
    description:
      'The fixed-port disposable Synapse, remote Synapse, Dex and Caddy stack.',
  },
] as const satisfies readonly E2ESerializationResource[];

export const E2E_QUARANTINE =
  [] as const satisfies readonly E2EQuarantineEntry[];

export const E2E_TIMEOUTS_MS = {
  short: 60_000,
  medium: 300_000,
  long: 1_800_000,
  host: 3_600_000,
} as const;
