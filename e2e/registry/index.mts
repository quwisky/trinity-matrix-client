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
  canonicalBrowserSpecCount: 120,
  trackedTargetProjects: [
    {
      project: 'trinity-e2e',
      projectFile: 'e2e/project.json',
      ignoredTargets: ['lint', 'typecheck'],
    },
    {
      project: 'trinity-e2e-browser',
      projectFile: 'e2e/browser/project.json',
      ignoredTargets: ['lint', 'typecheck'],
    },
    {
      project: 'trinity-e2e-electron',
      projectFile: 'e2e/electron/project.json',
      ignoredTargets: ['lint', 'typecheck'],
    },
    {
      project: 'trinity-e2e-android',
      projectFile: 'e2e/android/project.json',
      ignoredTargets: ['lint', 'typecheck'],
    },
    {
      project: 'trinity-e2e-web',
      projectFile: 'e2e/web/project.json',
      ignoredTargets: ['lint', 'typecheck'],
    },
    {
      project: 'trinity-e2e-components',
      projectFile: 'e2e/components/project.json',
      ignoredTargets: ['lint', 'typecheck'],
    },
    {
      project: 'trinity-e2e-protocol',
      projectFile: 'e2e/protocol/project.json',
      ignoredTargets: ['e2e', 'lint', 'typecheck', 'test'],
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
    'e2e/**/playwright*.config.mts',
    'e2e/protocol/*.spec.mjs',
    'e2e/android/run.mts',
  ],
  sharedEntrypoints: [
    {
      path: 'e2e/protocol/crypto-spike.spec.mjs',
      serializationKey: 'crypto-spike',
    },
  ],
} as const;

export function registeredE2ESuite(
  id: (typeof E2E_SUITES)[number]['id'],
): (typeof E2E_SUITES)[number] {
  const suite = E2E_SUITES.find((candidate) => candidate.id === id);
  if (!suite) throw new Error(`Unknown registered E2E suite: ${id}`);
  return suite;
}

export {
  E2E_AGGREGATE_TARGETS,
  E2E_CI_ENTRYPOINTS,
  E2E_PACKAGE_SCRIPTS,
  E2E_QUARANTINE,
  E2E_SERIALIZATION_RESOURCES,
  E2E_TIMEOUTS_MS,
};

export type * from './types.mts';
