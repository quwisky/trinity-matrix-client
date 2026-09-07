/** The CI graph must fail closed and preserve diagnostics independently of suite success. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { CODE_JOB_IDS } from './ci-classify.mjs';
import { validateWorkflowContracts } from './e2e-suite-registry-validator.mjs';

const root = resolve(import.meta.dirname, '..');
const yaml = (path) => parse(readFileSync(resolve(root, path), 'utf8'));
const workflow = yaml('.github/workflows/ci.yml');
const reusableE2e = yaml('.github/workflows/_e2e-suite.yml');
const renderer = yaml('.github/workflows/_renderer.yml');
const restore = yaml('.github/actions/restore-verified-renderer/action.yml');
const diagnostics = yaml(
  '.github/actions/upload-playwright-diagnostics/action.yml',
);
const setupPlaywright = yaml('.github/actions/setup-playwright/action.yml');
const workflowDocs = () => ({
  ci: structuredClone(workflow),
  e2e: structuredClone(reusableE2e),
  renderer: structuredClone(renderer),
  restore: structuredClone(restore),
  diagnostics: structuredClone(diagnostics),
  setupPlaywright: structuredClone(setupPlaywright),
});

describe('CI execution contract', () => {
  it('classifies every PR and preserves the full code graph', () => {
    expect(workflow.on.pull_request?.['paths-ignore']).toBeUndefined();
    expect(workflow.jobs.classify.outputs.mode).toContain(
      'steps.classify.outputs.mode',
    );
    for (const id of CODE_JOB_IDS) {
      expect([workflow.jobs[id].needs].flat()).toContain('classify');
      expect(workflow.jobs[id].if).toContain('!cancelled()');
      expect(workflow.jobs[id].if).toContain(
        "needs.classify.outputs.mode != 'docs'",
      );
    }
    expect(workflow.jobs['android-e2e'].strategy.matrix.shard).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('keeps the docs gate limited to formatting and source contracts', () => {
    const job = workflow.jobs['docs-gate'];
    expect(job.if).toContain("needs.classify.outputs.mode == 'docs'");
    expect(job.steps.flatMap((step) => (step.run ? [step.run] : []))).toEqual([
      'pnpm format:check',
      'pnpm nx test scripts',
    ]);
  });

  it('uploads only started suites, including hidden output, after ordinary failures', () => {
    const uploads = [
      ...Object.values(workflow.jobs),
      ...Object.values(reusableE2e.jobs),
    ]
      .flatMap((job) => job.steps ?? [])
      .filter(
        (step) =>
          step.uses === './.github/actions/upload-playwright-diagnostics',
      );
    expect(uploads.length).toBe(5);
    for (const step of uploads) {
      expect(step.if).toMatch(/!cancelled\(\).*outputs.started == 'true'/);
      expect(step.with.surface).toBeTruthy();
      expect(step.with['report-path']).toMatch(
        /dist\/\.playwright\/|steps\.plan\.outputs\.report-path/,
      );
    }
    const action = yaml(
      '.github/actions/upload-playwright-diagnostics/action.yml',
    );
    const upload = action.runs.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(upload.with['include-hidden-files']).toBe(true);
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(upload.with.name).toContain('inputs.artifact-name');
  });

  it('waits for KVM udev completion and separates browser and Gradle caches', () => {
    const steps = workflow.jobs['android-e2e'].steps;
    const kvm = steps.find(
      (step) => step.name === 'Grant emulator access to KVM',
    ).run;
    expect(kvm.indexOf('udevadm settle --timeout=30')).toBeGreaterThan(
      kvm.indexOf('udevadm trigger'),
    );
    expect(kvm.indexOf('test -r /dev/kvm')).toBeGreaterThan(
      kvm.indexOf('udevadm settle'),
    );
    const caches = steps.filter((step) =>
      step.uses?.startsWith('actions/cache@'),
    );
    expect(
      caches.some(
        (step) =>
          step.with.path.includes('.gradle') &&
          !step.with.path.includes('ms-playwright'),
      ),
    ).toBe(true);
    expect(
      caches.some(
        (step) =>
          step.with.path.includes('ms-playwright') &&
          !step.with.path.includes('.gradle'),
      ),
    ).toBe(true);
  });

  it('rejects mutations to the reusable caller graph and evidence contracts', () => {
    const mutations = [
      [
        'nested reusable call',
        (docs) => {
          docs.e2e.jobs.suite.uses = './.github/workflows/other.yml';
        },
      ],
      [
        'mutable checkout ref',
        (docs) => {
          docs.ci.jobs['component-storybook-e2e'].with.sha = 'main';
        },
      ],
      [
        'secret inheritance',
        (docs) => {
          docs.ci.jobs['component-storybook-e2e'].secrets = 'inherit';
        },
      ],
      [
        'permission ceiling',
        (docs) => {
          docs.ci.jobs['component-storybook-e2e'].permissions = {
            contents: 'write',
            actions: 'write',
          };
        },
      ],
      [
        'protected environment input',
        (docs) => {
          docs.ci.jobs['component-storybook-e2e'].with.environment =
            'production';
        },
      ],
      [
        'unpinned reached action',
        (docs) => {
          docs.e2e.jobs.suite.steps[0].uses = 'actions/checkout@main';
        },
      ],
      [
        'artifact attempt identity',
        (docs) => {
          docs.ci.jobs['component-storybook-e2e'].with[
            'diagnostics-artifact-name'
          ] =
            'playwright-${{ github.run_id }}-${{ github.sha }}-components-storybook-linux-all';
        },
      ],
      [
        'suite substitution',
        (docs) => {
          docs.ci.jobs['component-storybook-e2e'].with['suite-id'] =
            'web.container';
        },
      ],
      [
        'matrix scalar output',
        (docs) => {
          docs.ci.jobs['android-e2e'].outputs = {
            result: '${{ matrix.shard }}',
          };
        },
      ],
      [
        'container restore',
        (docs) => {
          docs.ci.jobs['web-container'].steps = docs.ci.jobs[
            'web-container'
          ].steps.filter(
            (step) => !step.uses?.includes('restore-verified-renderer'),
          );
        },
      ],
      [
        'container started diagnostics',
        (docs) => {
          const step = docs.ci.jobs['web-container'].steps.find((candidate) =>
            candidate.uses?.includes('upload-playwright-diagnostics'),
          );
          step.if = '${{ !cancelled() }}';
        },
      ],
      [
        'iOS managed target',
        (docs) => {
          const step = docs.ci.jobs['ios-native-build'].steps.find(
            (candidate) => candidate.id === 'ios',
          );
          step.run = 'xcodebuild build';
        },
      ],
      [
        'registry-owned dynamic report',
        (docs) => {
          const step = docs.e2e.jobs.suite.steps.find((candidate) =>
            candidate.uses?.includes('upload-playwright-diagnostics'),
          );
          step.with['report-path'] = 'dist/.playwright/**/**';
        },
      ],
      [
        'incorrect required aggregate',
        (docs) => {
          docs.ci.jobs.required.needs = docs.ci.jobs.required.needs.filter(
            (id) => id !== 'android-e2e',
          );
        },
      ],
      [
        'fail-fast matrix',
        (docs) => {
          docs.ci.jobs['android-e2e'].strategy['fail-fast'] = true;
        },
      ],
      [
        'unpinned diagnostics action',
        (docs) => {
          const upload = docs.diagnostics.runs.steps.find((step) =>
            step.uses?.startsWith('actions/upload-artifact@'),
          );
          upload.uses = 'actions/upload-artifact@main';
        },
      ],
      [
        'missing callee permissions',
        (docs) => {
          delete docs.e2e.jobs.suite.permissions;
        },
      ],
      [
        'callee write permissions',
        (docs) => {
          docs.e2e.jobs.suite.permissions = {
            contents: 'write',
            actions: 'read',
          };
        },
      ],
      [
        'caller extra permissions',
        (docs) => {
          docs.ci.jobs['component-storybook-e2e'].permissions.packages =
            'write';
        },
      ],
      [
        'renderer caller secrets',
        (docs) => {
          docs.ci.jobs.renderer.secrets = 'inherit';
        },
      ],
      [
        'callee mutable checkout',
        (docs) => {
          docs.e2e.jobs.suite.steps.find((step) =>
            step.uses?.startsWith('actions/checkout@'),
          ).with.ref = 'develop';
        },
      ],
      [
        'matrix output without matrix reference',
        (docs) => {
          docs.ci.jobs['android-e2e'].outputs = {
            result: '${{ steps.test.outputs.result }}',
          };
        },
      ],
    ];
    for (const [name, mutate] of mutations) {
      const docs = workflowDocs();
      mutate(docs);
      expect(validateWorkflowContracts(root, docs), name).not.toEqual([]);
    }
  });
});

it('reserves bounded iOS diagnostic and action-cleanup time after the compiler wrapper', () => {
  const job = workflow.jobs['ios-native-build'];
  const budgets = job.steps.map((step) => step['timeout-minutes']);
  expect(
    budgets.every((minutes) => Number.isInteger(minutes) && minutes > 0),
  ).toBe(true);
  expect(budgets.reduce((total, minutes) => total + minutes, 0)).toBeLessThan(
    job['timeout-minutes'],
  );
  const compiler = job.steps.find((step) => step.id === 'ios');
  const wrapperBudget = Number(compiler.run.match(/--timeout-ms (\d+)/)?.[1]);
  expect(wrapperBudget).toBeGreaterThan(0);
  // The shared command wrapper allows one minute to terminate/reap its process group.
  expect(wrapperBudget + 60_000).toBeLessThan(
    compiler['timeout-minutes'] * 60_000,
  );
});
