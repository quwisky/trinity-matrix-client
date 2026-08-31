import {
  E2E_AGGREGATE_TARGETS,
  E2E_CI_ENTRYPOINTS,
  E2E_PACKAGE_SCRIPTS,
} from './commands.mts';
import {
  E2E_QUARANTINE,
  E2E_SERIALIZATION_RESOURCES,
  E2E_TIMEOUTS_MS,
} from './resources.mts';
import { BROWSER_E2E_SUITES } from './suites/browser.mts';
import { COMPONENT_E2E_SUITES } from './suites/components.mts';
import { HOST_E2E_SUITES } from './suites/hosts.mts';
import { PROTOCOL_E2E_SUITES } from './suites/protocol.mts';

export const E2E_SUITES = [
  ...BROWSER_E2E_SUITES,
  ...COMPONENT_E2E_SUITES,
  ...HOST_E2E_SUITES,
  ...PROTOCOL_E2E_SUITES,
] as const;

export const E2E_INVENTORY = {
  canonicalBrowserSpecCount: 104,
  trackedTargetProjects: [
    {
      project: 'trinity-e2e',
      projectFile: 'e2e/project.json',
      ignoredTargets: ['lint', 'typecheck'],
    },
    {
      project: 'trinity-desktop',
      projectFile: 'electron/project.json',
      includedTargets: ['e2e', 'e2e-smoke'],
    },
    {
      project: 'trinity-android',
      projectFile: 'android/project.json',
      includedTargets: ['e2e'],
    },
  ],
  trackedEntrypointPatterns: [
    'e2e/playwright*.config.mts',
    'e2e/runners/*.mjs',
    'e2e/features/*.mjs',
    'e2e/android/run.mts',
    'scripts/run-phase7-e2e.mjs',
  ],
  sharedEntrypoints: [
    {
      path: 'e2e/features/crypto-spike.mjs',
      serializationKey: 'crypto-spike',
    },
  ],
} as const;

export {
  E2E_AGGREGATE_TARGETS,
  E2E_CI_ENTRYPOINTS,
  E2E_PACKAGE_SCRIPTS,
  E2E_QUARANTINE,
  E2E_SERIALIZATION_RESOURCES,
  E2E_TIMEOUTS_MS,
};

export type * from './types.mts';
