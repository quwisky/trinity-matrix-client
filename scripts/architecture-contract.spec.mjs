import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classify,
  findCycles,
  validateDependencies,
  validateEntrypoints,
  validateLedger,
  validateMapFreshness,
  validateQualityBaselines,
  validateRoleDirection,
} from './architecture-contract.mjs';

const workspaceRoot = join(import.meta.dirname, '..');
const architectureCommand = join(
  workspaceRoot,
  'scripts/architecture-contract.mjs',
);

describe('architecture contract', () => {
  it('validates the classified Nx graph and committed dependency map', () => {
    const output = execFileSync(
      process.execPath,
      [architectureCommand, 'check'],
      {
        cwd: workspaceRoot,
        encoding: 'utf8',
      },
    );

    expect(output).toContain('Architecture contract is valid');

    const dependencyMap = readFileSync(
      join(workspaceRoot, 'docs-internal/architecture/dependency-map.md'),
      'utf8',
    );
    expect(dependencyMap).toMatch(/\d+ Nx projects/);
    expect(dependencyMap).toMatch(/\d+ dependencies/);
    expect(dependencyMap).toContain('No project cycles detected.');
  });

  const rejectionCases = [
    {
      name: 'unclassified projects',
      expected: 'exactly one role:* tag',
      run(errors) {
        classify(
          {
            nodes: {
              orphan: {
                data: { tags: ['capability:accounts'] },
              },
            },
          },
          {
            roles: { capability: ['capability'] },
            capabilities: ['accounts'],
            unmanagedProjects: [],
            classificationExceptions: [],
            multiCapabilityProjects: [],
          },
          errors,
        );
      },
    },
    {
      name: 'new dependency exceptions',
      expected: 'Dependency exception allowlist drifted',
      run(errors) {
        validateDependencies(
          {
            dependencies: { accounts: [{ target: 'trust' }], trust: [] },
          },
          {
            roles: { capability: ['capability'] },
            dependencyExceptions: [],
          },
          {
            roles: new Map([
              ['accounts', 'capability'],
              ['trust', 'capability'],
            ]),
            capabilities: new Map([
              ['accounts', ['accounts']],
              ['trust', ['trust']],
            ]),
          },
          errors,
        );
      },
    },
    {
      name: 'duplicate primary entrypoints',
      expected: 'exactly one explicit public entrypoint',
      run(errors) {
        validateEntrypoints(
          {
            nodes: {
              accounts: { data: { root: 'libs/accounts' } },
            },
          },
          {
            entrypointExemptProjects: [],
            secondaryEntrypoints: [],
          },
          {
            '@trinity/accounts': ['./libs/accounts/src/index.ts'],
            '@trinity/accounts-again': ['./libs/accounts/src/index.ts'],
          },
          errors,
        );
      },
    },
    {
      name: 'project cycles',
      expected: 'a -> b -> a',
      run(errors) {
        errors.push(
          ...findCycles({
            a: [{ target: 'b' }],
            b: [{ target: 'a' }],
          }).map((cycle) => cycle.join(' -> ')),
        );
      },
    },
    {
      name: 'stale generated maps',
      expected: 'Generated dependency map is stale',
      run(errors) {
        validateMapFreshness('expected map', 'stale map', errors);
      },
    },
    {
      name: 'temporary ledgers in the contracted phase',
      expected: 'Contracted architecture cannot retain secondary entrypoint',
      run(errors) {
        validateLedger(
          {
            phase: 'contracted',
            roles: { kernel: ['kernel'] },
            classificationExceptions: [],
            secondaryEntrypoints: [
              { alias: '@trinity/legacy', reason: 'legacy', removeBy: '#1' },
            ],
            multiCapabilityProjects: [],
            dependencyExceptions: [],
            sourceBaselines: {},
          },
          errors,
        );
      },
    },
    {
      name: 'source baselines in the contracted phase',
      expected: 'Contracted architecture cannot retain source baselines',
      run(errors) {
        validateLedger(
          {
            phase: 'contracted',
            roles: { kernel: ['kernel'] },
            classificationExceptions: [],
            secondaryEntrypoints: [],
            multiCapabilityProjects: [],
            dependencyExceptions: [],
            sourceBaselines: { legacyLines: { value: 0 } },
          },
          errors,
        );
      },
    },
    {
      name: 'cyclic role directions',
      expected: 'Role dependency direction is cyclic',
      run(errors) {
        validateRoleDirection(
          {
            application: ['capability'],
            capability: ['adapter'],
            adapter: ['application'],
          },
          errors,
        );
      },
    },
    {
      name: 'missing security baselines',
      expected: 'Security baseline registry must cover exactly',
      run(errors) {
        validateQualityBaselines(
          {
            performance: [
              'account-restore',
              'active-account-switch',
              'background-account-cpu',
              'conversation-attach',
              'message-projection',
              'retained-resources',
              'workspace-transition',
            ].map((metric) => ({
              metric,
              scope: 'scope',
              unit: 'unit',
              current: 'current',
              owner: 'owner',
              issue: '#1',
            })),
            security: [],
          },
          errors,
        );
      },
    },
  ];

  it.each(rejectionCases)('rejects $name', ({ run, expected }) => {
    const errors = [];
    run(errors);
    expect(errors).toEqual(
      expect.arrayContaining([expect.stringContaining(expected)]),
    );
  });
});
