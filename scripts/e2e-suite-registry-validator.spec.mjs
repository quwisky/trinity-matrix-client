import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateBrowserJourneyInventory } from './e2e-browser-inventory.mjs';
import { BROWSER_CAPABILITIES } from '../e2e/registry/browser-classification.mts';
import {
  CI_WORKFLOW_BY_TIER,
  registrySnapshot,
  validateDurableE2ENames,
  validateRegistry,
  validateCiReportPaths,
  validateWorkspace,
  yamlReportPaths,
  yamlRunCommands,
} from './e2e-suite-registry-validator.mjs';

const workspaceRoot = join(import.meta.dirname, '..');

describe('E2E suite registry', () => {
  it('validates each CI tier against the workflow that runs it', () => {
    expect(CI_WORKFLOW_BY_TIER).toEqual({
      'pull-request': '.github/workflows/ci.yml',
      scheduled: '.github/workflows/ci.yml',
      nightly: '.github/workflows/e2e-ios-nightly.yml',
    });
    const snapshot = registrySnapshot();
    snapshot.ciEntrypoints.push({
      command: 'pnpm e2e:nightly-probe',
      tier: 'nightly',
      suiteIds: [],
    });
    snapshot.ciEntrypoints.push({
      command: 'pnpm e2e:weekly-probe',
      tier: 'weekly',
      suiteIds: [],
    });
    const errors = validateWorkspace(workspaceRoot, snapshot);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('.github/workflows/e2e-ios-nightly.yml'),
        'pnpm e2e:weekly-probe uses CI tier weekly, which no workflow runs',
      ]),
    );
    expect(errors).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'absent from .github/workflows/ci.yml: pnpm e2e:nightly-probe',
        ),
      ]),
    );
  }, 120_000);

  it('requires report paths only in the workflow that runs the suite', () => {
    const snapshot = registrySnapshot();
    const errors = [];
    validateCiReportPaths(errors, 'steps: []', snapshot, []);
    expect(errors).toEqual([]);
    validateCiReportPaths(
      errors,
      'steps: []',
      snapshot,
      snapshot.ciEntrypoints.filter(({ suiteIds }) =>
        suiteIds.includes('browser.canonical'),
      ),
    );
    expect(errors).toEqual([
      'CI report path is missing suite browser.canonical',
    ]);
  });

  it('lets a pull request run a later-tier suite only when its paths change', () => {
    const snapshot = registrySnapshot();
    const scheduled = snapshot.suites.find(
      ({ ciTier }) => ciTier === 'scheduled',
    );
    const pullRequest = snapshot.suites.find(
      ({ ciTier }) => ciTier === 'pull-request',
    );
    snapshot.ciEntrypoints = snapshot.ciEntrypoints.filter(
      ({ changedPathsOnly }) => !changedPathsOnly,
    );
    const changed = {
      command: 'pnpm e2e:changed-probe',
      tier: 'pull-request',
      suiteIds: [scheduled.id],
      changedPathsOnly: true,
    };
    snapshot.ciEntrypoints.push(changed);
    expect(validateRegistry(snapshot)).toEqual([]);

    const errors = [];
    validateCiReportPaths(errors, 'steps: []', snapshot, [changed]);
    expect(errors).toEqual([`CI report path is missing suite ${scheduled.id}`]);

    snapshot.ciEntrypoints.push(
      {
        ...changed,
        command: 'pnpm e2e:pr-suite-probe',
        suiteIds: [pullRequest.id],
      },
      { ...changed, command: 'pnpm e2e:scheduled-probe', tier: 'scheduled' },
    );
    expect(validateRegistry(snapshot)).toEqual([
      `${pullRequest.id} runs on changed paths but is classified pull-request`,
      'pnpm e2e:scheduled-probe runs on changed paths outside the pull-request tier',
    ]);
  });

  it('owns the iOS environment by the mobile lifecycle project', () => {
    const snapshot = registrySnapshot();
    const android = snapshot.suites.find(({ id }) => id === 'mobile.android');
    snapshot.suites.push({
      ...structuredClone(android),
      id: 'mobile.probe',
      environment: 'mobile-ios',
      currentTarget: 'trinity-e2e-mobile:probe',
      delegatingTargets: [],
    });
    expect(validateRegistry(snapshot)).not.toContain(
      'mobile.probe targets the wrong lifecycle project',
    );
  });

  // Resolves every owned Nx project on a cold hosted runner. The first public
  // run exceeded 30 seconds; this is a graph contract, not a performance budget.
  it('matches the current workspace entrypoints, targets, commands and CI', () => {
    expect(validateWorkspace(workspaceRoot)).toEqual([]);
  }, 120_000);

  it('rejects duplicate target ownership and serialization resources', () => {
    const snapshot = registrySnapshot();
    snapshot.suites[1].currentTarget = snapshot.suites[0].currentTarget;
    snapshot.resources.push(structuredClone(snapshot.resources[0]));

    expect(validateRegistry(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('duplicate current target'),
        expect.stringContaining('duplicate serialization resource'),
      ]),
    );
  });

  it('rejects cacheable suites and missing annotations or prerequisites', () => {
    const snapshot = registrySnapshot();
    snapshot.suites[0].cachePolicy = 'allowed';
    snapshot.suites[0].capabilities = [];
    snapshot.suites[0].prerequisites = [];
    snapshot.suites[0].availabilityPolicy = undefined;

    expect(validateRegistry(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing capability or contract annotations'),
        expect.stringContaining('no explicit prerequisite classification'),
        expect.stringContaining('no explicit availability policy'),
        expect.stringContaining('permits caching'),
      ]),
    );
  });

  it('locks the canonical browser suite to one CI retry and the mobile suite to none', () => {
    const snapshot = registrySnapshot();
    snapshot.suites.find(({ id }) => id === 'browser.canonical').ciRetries = 2;

    expect(validateWorkspace(workspaceRoot, snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'browser.canonical must allow exactly one CI retry',
        ),
      ]),
    );
    expect(
      snapshot.suites.find(({ id }) => id === 'mobile.android').ciRetries ?? 0,
    ).toBe(0);
  });

  it('rejects undefined serialization ownership and command drift', () => {
    const snapshot = registrySnapshot();
    snapshot.suites[0].serializationKeys = ['unowned-stack'];
    snapshot.packageScripts.find(({ name }) => name === 'e2e').command =
      'nx run trinity-e2e:drifted';
    snapshot.packageScripts.find(({ name }) => name === 'e2e:verify').command =
      'nx run trinity-e2e:drifted-compatibility-alias';

    expect(validateWorkspace(workspaceRoot, snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('undefined serialization resource'),
        expect.stringContaining('package script e2e drifted'),
        expect.stringContaining('package script e2e:verify drifted'),
        expect.stringContaining('targets missing Nx task'),
      ]),
    );
  });

  it('rejects expired or incomplete quarantine entries', () => {
    const snapshot = registrySnapshot();
    snapshot.quarantine.push({
      suiteId: 'browser.canonical',
      issue: '',
      owner: '',
      reason: '',
      expiresOn: '2025-01-01',
      excludedTier: 'pull-request',
    });

    expect(
      validateRegistry(snapshot, new Date('2026-08-30T00:00:00Z')),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing issue, owner or reason'),
        expect.stringContaining('expired on 2025-01-01'),
      ]),
    );
  });

  it('locks every compatibility alias to the full release-cycle removal gate', () => {
    const snapshot = registrySnapshot();
    snapshot.packageScripts.find(
      ({ kind }) => kind === 'compatibility',
    ).removalAfterRelease = 'next release';

    expect(validateRegistry(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('incomplete compatibility removal criteria'),
      ]),
    );
  });

  it('rejects unregistered targets, entrypoints and CI commands', () => {
    const snapshot = registrySnapshot();
    snapshot.inventory.trackedTargetProjects[0].ignoredTargets = ['typecheck'];
    snapshot.suites[0].sourceEntrypoints = [];
    snapshot.ciEntrypoints = snapshot.ciEntrypoints.filter(
      ({ suiteIds }) => !suiteIds.includes('browser.canonical'),
    );

    expect(validateWorkspace(workspaceRoot, snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('unregistered E2E target: trinity-e2e:lint'),
        expect.stringContaining('has no source entrypoint'),
        expect.stringContaining('unregistered E2E entrypoint'),
        expect.stringContaining('unregistered CI E2E entrypoint'),
      ]),
    );
  });

  it('rejects aggregate-target drift', () => {
    const snapshot = registrySnapshot();
    snapshot.aggregateTargets[0].target = 'missing-target';

    expect(validateWorkspace(workspaceRoot, snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'aggregate target trinity-e2e:missing-target does not exist',
        ),
      ]),
    );
  });

  describe('browser journey folders', () => {
    const inventoryErrors = (mutate = () => undefined) => {
      const root = mkdtempSync(join(tmpdir(), 'trinity-e2e-inventory-'));
      try {
        const spec = (path) => {
          mkdirSync(join(root, path, '..'), { recursive: true });
          writeFileSync(join(root, path), '');
        };
        for (const capability of BROWSER_CAPABILITIES) {
          spec(`e2e/browser/journeys/${capability}/one.spec.mts`);
        }
        mutate(root, spec);
        const errors = [];
        validateBrowserJourneyInventory(errors, root);
        return errors;
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    it('accepts the checked-in layout and a complete synthetic one', () => {
      const errors = [];
      validateBrowserJourneyInventory(errors, workspaceRoot);
      expect(errors).toEqual([]);
      expect(inventoryErrors()).toEqual([]);
    });

    it('rejects specs under an unknown capability folder', () => {
      expect(
        inventoryErrors((_, spec) =>
          spec('e2e/browser/journeys/bogus/a.spec.mts'),
        ),
      ).toEqual([expect.stringContaining('journeys/bogus/a.spec.mts')]);
    });

    it('rejects specs nested below a capability folder', () => {
      expect(
        inventoryErrors((_, spec) =>
          spec('e2e/browser/journeys/accounts/deep/a.spec.mts'),
        ),
      ).toEqual([expect.stringContaining('accounts/deep/a.spec.mts')]);
    });

    it('rejects a capability without a spec', () => {
      expect(
        inventoryErrors((root) =>
          rmSync(join(root, 'e2e/browser/journeys/trust'), { recursive: true }),
        ),
      ).toEqual(['browser capability has no journey: trust']);
    });

    it('rejects specs left in the former flat root', () => {
      expect(
        inventoryErrors((_, spec) => spec('e2e/playwright/old.spec.mts')),
      ).toEqual([
        expect.stringContaining('former flat canonical browser root'),
      ]);
    });
  });

  it('requires migrated lifecycle targets and artifacts to use their durable owner', () => {
    const artifactSnapshot = registrySnapshot();
    const artifactWeb = artifactSnapshot.suites.find(
      ({ id }) => id === 'web.production-pwa',
    );
    artifactWeb.currentArtifactRoot = 'dist/.playwright/web';

    expect(validateRegistry(artifactSnapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'web.production-pwa current artifacts must use dist/.playwright/trinity-e2e-web/<run-id>',
        ),
      ]),
    );

    const targetSnapshot = registrySnapshot();
    const targetWeb = targetSnapshot.suites.find(
      ({ id }) => id === 'web.production-pwa',
    );
    targetWeb.currentTarget = 'trinity-e2e:web-e2e';

    expect(validateRegistry(targetSnapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'web.production-pwa bypasses its active lifecycle project',
        ),
      ]),
    );
  });

  it('rejects historical E2E paths and source names but permits the retained alias', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-e2e-names-'));
    try {
      const phaseName = ['phase', '6'].join('');
      const shippedName = ['shipped', 'UI'].join(' ');
      mkdirSync(join(directory, 'e2e/nested'), { recursive: true });
      writeFileSync(
        join(directory, `e2e/${phaseName}.config.mts`),
        'export {};\n',
      );
      writeFileSync(
        join(directory, 'e2e/nested/active.mts'),
        `export const name = '${shippedName}';\n`,
      );
      writeFileSync(
        join(directory, 'e2e/compat.mts'),
        "export const alias = 'e2e:ui:shipped';\n",
      );
      const errors = [];

      validateDurableE2ENames(errors, directory);

      expect(errors).toEqual(
        expect.arrayContaining([
          `historical E2E name remains in path: e2e/${phaseName}.config.mts`,
          'historical E2E name remains in source: e2e/nested/active.mts',
        ]),
      );
      expect(errors).not.toContain(
        'historical E2E name remains in source: e2e/compat.mts',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects canonical runner bypasses and incomplete CI tiers', () => {
    const snapshot = registrySnapshot();
    snapshot.packageScripts.find(({ name }) => name === 'e2e:web').command =
      'nx run trinity-e2e:web-e2e';
    snapshot.ciEntrypoints = snapshot.ciEntrypoints.filter(
      ({ suiteIds }) => !suiteIds.includes('browser.canonical'),
    );

    expect(validateRegistry(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('e2e:web bypasses the E2E aggregate runner'),
      ]),
    );
    expect(validateWorkspace(workspaceRoot, snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'pull-request suite has no CI entrypoint: browser.canonical',
        ),
      ]),
    );
  });

  it('classifies inline and multiline workflow commands', () => {
    expect(
      yamlRunCommands(`
steps:
  - run: pnpm exec nx run trinity-e2e:storybook-e2e
  - run: |
      pnpm build
      pnpm e2e:web
`),
    ).toEqual(['pnpm exec nx run trinity-e2e:storybook-e2e', 'pnpm e2e:web']);
  });

  it('unwraps the owned CI timeout wrapper before comparing commands', () => {
    expect(
      yamlRunCommands(`
steps:
  - run: node scripts/ci-run-command.mjs --timeout-ms 3600000 -- pnpm exec nx run trinity-e2e-browser:e2e
  - run: TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 3600000 -- pnpm e2e:mobile
`),
    ).toEqual([
      'pnpm exec nx run trinity-e2e-browser:e2e',
      'TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm e2e:mobile',
    ]);
  });

  it('classifies registry-owned CI report paths', () => {
    expect(
      yamlReportPaths(`
steps:
  - report-path: dist/.playwright/trinity-e2e-browser/*/browser.canonical/**
  - report-path: dist/.playwright/**/**
`),
    ).toEqual([
      'dist/.playwright/trinity-e2e-browser/*/browser.canonical/**',
      'dist/.playwright/**/**',
    ]);

    const snapshot = registrySnapshot();
    const errors = [];
    validateCiReportPaths(
      errors,
      'report-path: dist/.playwright/trinity-e2e-web/*/browser.canonical/**',
      snapshot,
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        'CI report path for browser.canonical targets trinity-e2e-web, expected trinity-e2e-browser',
      ]),
    );
  });
});
